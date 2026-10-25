import { describe, expect, test } from 'vitest';
import { buyAndPay, call, insertPackage, loginTeacher, loginUser, noticesOf, setup } from '../../../tests/helpers.ts';
import { crisisEvents, replyWaits, riskEvents } from '../../db/schema.ts';
import { applyPause } from '../../domain/segments.ts';
import { addMs, HOUR_MS, MINUTE_MS } from '../../lib/dates.ts';
import { rewriteSegments } from '../relations/service.ts';
import { replyStats } from './replies.ts';
import { handleAfterSend } from './service.ts';

async function world() {
  const ctx = await setup();
  const t = await loginTeacher(ctx, 't');
  const u = await loginUser(ctx, 'u');
  const x = await loginUser(ctx, 'x');
  const rel = await buyAndPay(ctx, u.userId, await insertPackage(ctx.db, t.userId, { replyHours: 12 }));
  return { ctx, db: ctx.db, t, u, x, rel, t0: ctx.clock.now() };
}
type World = Awaited<ReturnType<typeof world>>;
type Who = { userId: number };

const send = (w: World, from: Who, to: Who, text: string, now = w.t0) =>
  handleAfterSend(w.db, { from: from.userId, to: to.userId, text, now, hotline: '12356' });

describe('发送后处理', () => {
  test('危机词：记录事件，给发送者热线提示，通知对方', async () => {
    const w = await world();
    await send(w, w.u, w.t, '最近总想自杀');
    const [e] = await w.db.select().from(crisisEvents);
    expect(e).toMatchObject({ userId: w.u.userId, peerId: w.t.userId, keyword: '自杀', status: 'open' });
    const [hotline] = await noticesOf(w.db, w.u.userId, 'crisis_hotline');
    expect(hotline.payload).toEqual({ hotline: '12356' });
    expect(await noticesOf(w.db, w.t.userId, 'crisis_alert')).toHaveLength(1);
  });

  test('私下交易：记录风险事件并提示发送者', async () => {
    const w = await world();
    await send(w, w.t, w.u, '加我微信聊');
    const [r] = await w.db.select().from(riskEvents);
    expect(r).toMatchObject({ fromUserId: w.t.userId, toUserId: w.u.userId, keyword: '微信' });
    expect(await noticesOf(w.db, w.t.userId, 'private_trade_warning')).toHaveLength(1);
  });

  test('没有服务关系的消息不处理', async () => {
    const w = await world();
    await send(w, w.u, w.x, '想死');
    expect(await w.db.$count(crisisEvents)).toBe(0);
    expect(await w.db.$count(replyWaits)).toBe(0);
  });
});

describe('回复时效', () => {
  test('学员提问开始计时（并发也只计一条）、老师回复结束；按承诺小时数统计达标率', async () => {
    const w = await world();
    await Promise.all([send(w, w.u, w.t, '在吗'), send(w, w.u, w.t, '有个问题', addMs(w.t0, MINUTE_MS))]);
    expect(await w.db.$count(replyWaits)).toBe(1);
    await send(w, w.t, w.u, '在的', addMs(w.t0, 2 * HOUR_MS));
    const [wait] = await w.db.select().from(replyWaits);
    expect(wait.repliedAt).toEqual(addMs(w.t0, 2 * HOUR_MS));

    const t1 = addMs(w.t0, 3 * HOUR_MS);
    await send(w, w.u, w.t, '还有一个问题', t1);
    const range = { from: w.t0, to: addMs(w.t0, 24 * HOUR_MS) };
    expect(await replyStats(w.db, w.t.userId, { ...range, now: addMs(t1, 11 * HOUR_MS) })).toEqual({
      total: 1,
      onTime: 1,
      rate: 1,
    });
    expect(await replyStats(w.db, w.t.userId, { ...range, now: addMs(t1, 13 * HOUR_MS) })).toEqual({
      total: 2,
      onTime: 1,
      rate: 0.5,
    });
  });

  test('原老师当天暂停（请假）时，学员消息不计时', async () => {
    const w = await world();
    await rewriteSegments(w.db, w.rel.id, (s) => applyPause(s, { from: '2026-11-01', to: '2026-11-01' }));
    await send(w, w.u, w.t, '老师好');
    expect(await w.db.$count(replyWaits)).toBe(0);
  });

  test('HTTP：IM 发送后回调接入处理；老师查看回复时效统计', async () => {
    const w = await world();
    const res = await call(w.ctx, 'POST', '/api/im/callback', {
      body: {
        CallbackCommand: 'C2C.CallbackAfterSendMsg',
        From_Account: `u${w.u.userId}`,
        To_Account: `u${w.t.userId}`,
        MsgBody: [{ MsgType: 'TIMTextElem', MsgContent: { Text: '我不想活了' } }],
      },
    });
    expect(res.json().ErrorCode).toBe(0);
    expect(await w.db.$count(crisisEvents)).toBe(1);
    expect(await w.db.$count(replyWaits)).toBe(1);

    w.ctx.clock.set(addMs(w.t0, 13 * HOUR_MS));
    const stats = await call(w.ctx, 'GET', '/api/teacher/reply-stats', {
      token: w.t.token,
      query: { from: '2026-11-01', to: '2026-11-01' },
    });
    expect(stats.json()).toEqual({ from: '2026-11-01', to: '2026-11-01', total: 1, onTime: 0, rate: 0 });
    const bad = await call(w.ctx, 'GET', '/api/teacher/reply-stats', {
      token: w.t.token,
      query: { from: '2026-11-02', to: '2026-11-01' },
    });
    expect(bad.statusCode).toBe(400);
  });
});
