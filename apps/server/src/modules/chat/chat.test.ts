import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import {
  buyAndPay,
  call,
  FIXED_NOW,
  insertPackage,
  loginTeacher,
  loginUser,
  setup,
  TENCENT,
} from '../../../tests/helpers.ts';
import type { Config } from '../../config.ts';
import { serviceRelations } from '../../db/schema.ts';
import { applySubstitute } from '../../domain/segments.ts';
import { rewriteSegments } from '../relations/service.ts';
import { resolvePair } from './service.ts';

const TODAY = '2026-11-01';

async function world(config?: Partial<Config>) {
  const ctx = await setup({ config });
  const t = await loginTeacher(ctx, 't');
  const s = await loginTeacher(ctx, 's');
  const u = await loginUser(ctx, 'u');
  const x = await loginUser(ctx, 'x');
  const rel = await buyAndPay(ctx, u.userId, await insertPackage(ctx.db, t.userId));
  return { ctx, db: ctx.db, t, s, u, x, rel };
}
type World = Awaited<ReturnType<typeof world>>;

const substituteOn = (w: World, date: string) =>
  rewriteSegments(w.db, w.rel.id, (segs) => applySubstitute(segs, { from: date, to: date, teacherId: w.s.userId }));
const beforeSend = (w: World, from: string, to: string, query?: Record<string, string>) =>
  call(w.ctx, 'POST', '/api/im/callback', {
    query: { SdkAppid: '1400000001', CallbackCommand: 'C2C.CallbackBeforeSendMsg', ...query },
    body: {
      CallbackCommand: 'C2C.CallbackBeforeSendMsg',
      From_Account: from,
      To_Account: to,
      MsgBody: [{ MsgType: 'TIMTextElem', MsgContent: { Text: '你好' } }],
    },
  });

describe('聊天权限', () => {
  test('学员与原老师可聊天（双向识别），与陌生人不可', async () => {
    const w = await world();
    expect(await resolvePair(w.db, w.u.userId, w.t.userId, TODAY)).toMatchObject({
      studentId: w.u.userId,
      teacherId: w.t.userId,
      responsible: w.t.userId,
    });
    expect((await resolvePair(w.db, w.t.userId, w.u.userId, TODAY))?.studentId).toBe(w.u.userId);
    expect(await resolvePair(w.db, w.u.userId, w.x.userId, TODAY)).toBeNull();
    expect(await resolvePair(w.db, w.u.userId, w.s.userId, TODAY)).toBeNull();
  });

  test('代班老师仅在代班日可聊天；当天原老师仍可聊但不是负责人', async () => {
    const w = await world();
    await substituteOn(w, TODAY);
    expect((await resolvePair(w.db, w.u.userId, w.s.userId, TODAY))?.responsible).toBe(w.s.userId);
    expect(await resolvePair(w.db, w.u.userId, w.s.userId, '2026-11-02')).toBeNull();
    expect((await resolvePair(w.db, w.u.userId, w.t.userId, TODAY))?.responsible).toBe(w.s.userId);
  });

  test('服务关系结束后不可聊天', async () => {
    const w = await world();
    await w.db.update(serviceRelations).set({ status: 'ended' }).where(eq(serviceRelations.id, w.rel.id));
    expect(await resolvePair(w.db, w.u.userId, w.t.userId, TODAY)).toBeNull();
  });
});

describe('IM 回调与联系人', () => {
  test('发送前回调：有权限放行、无权限拦截、系统账号放行', async () => {
    const w = await world();
    expect((await beforeSend(w, `u${w.u.userId}`, `u${w.t.userId}`)).json()).toEqual({
      ActionStatus: 'OK',
      ErrorCode: 0,
      ErrorInfo: '',
    });
    expect((await beforeSend(w, `u${w.u.userId}`, `u${w.x.userId}`)).json().ErrorCode).toBe(120001);
    expect((await beforeSend(w, 'administrator', `u${w.x.userId}`)).json().ErrorCode).toBe(0);
  });

  test('回调鉴权：配置 Token 后签名错误返回 403', async () => {
    const w = await world({ tencent: { ...TENCENT, imCallbackToken: 'tok' } });
    const RequestTime = String(Date.parse(FIXED_NOW) / 1000);
    const Sign = createHash('sha256').update(`tok${RequestTime}`).digest('hex');
    const from = `u${w.u.userId}`;
    const to = `u${w.t.userId}`;
    expect((await beforeSend(w, from, to, { RequestTime, Sign })).statusCode).toBe(200);
    expect((await beforeSend(w, from, to, { RequestTime, Sign: 'bad' })).statusCode).toBe(403);
    expect((await beforeSend(w, from, to)).statusCode).toBe(403);
  });

  test('联系人：学员看到原老师与当日代班老师；老师各自看到学员', async () => {
    const w = await world();
    await substituteOn(w, TODAY);
    const list = async (who: { token: string }) =>
      (await call(w.ctx, 'GET', '/api/im/contacts', { token: who.token })).json();
    const brief = (cs: { userId: number; role: string; substitute: boolean }[]) =>
      cs.map((c) => [c.userId, c.role, c.substitute]);

    const mine = await list(w.u);
    expect(brief(mine)).toEqual([
      [w.t.userId, 'teacher', false],
      [w.s.userId, 'teacher', true],
    ]);
    expect(mine[0]).toMatchObject({ imId: `u${w.t.userId}`, name: `老师${w.t.userId}` });
    expect(brief(await list(w.t))).toEqual([[w.u.userId, 'student', false]]);
    expect(brief(await list(w.s))).toEqual([[w.u.userId, 'student', true]]);
    expect(await list(w.x)).toEqual([]);
  });
});
