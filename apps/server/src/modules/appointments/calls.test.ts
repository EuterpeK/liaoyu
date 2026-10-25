import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  buyAndPay,
  type Ctx,
  call,
  insertPackage,
  loginTeacher,
  loginUser,
  noticesOf,
  setup,
  TENCENT,
} from '../../../tests/helpers.ts';
import type { Config } from '../../config.ts';
import { serviceRelations } from '../../db/schema.ts';
import { addMs, MINUTE_MS } from '../../lib/dates.ts';
import { setSchedule } from '../schedule/service.ts';
import { autoComplete, book, getAppointment, markNoShows, onRoomDismissed, recordEnter } from './service.ts';

const REAL = { tencent: { ...TENCENT, trtcCallbackKey: 'ck' } };

async function world(config?: Partial<Config>) {
  const ctx = await setup({ config });
  const t = await loginTeacher(ctx, 't');
  const u = await loginUser(ctx, 'u');
  await setSchedule(ctx.db, t.userId, [{ weekday: 1, start: '09:00', end: '12:00' }]);
  const rel = await buyAndPay(ctx, u.userId, await insertPackage(ctx.db, t.userId));
  const a = await book(ctx.db, ctx.clock.now(), {
    userId: u.userId,
    relationId: rel.id,
    date: '2026-11-02',
    start: '10:00',
  });
  return { ctx, db: ctx.db, t, u, rel, a };
}
type World = Awaited<ReturnType<typeof world>>;

const mins = (w: World, base: 'startAt' | 'endAt', n: number) => addMs(w.a[base], n * MINUTE_MS);
const current = async (w: World) => {
  const a = await getAppointment(w.db, w.a.id);
  if (!a) throw new Error('预约丢失');
  return a;
};
const callsLeft = async (w: World) => (await w.db.select().from(serviceRelations))[0].callsLeft;

function trtc(ctx: Ctx, body: object, key = 'ck') {
  const raw = JSON.stringify(body);
  return ctx.app.inject({
    method: 'POST',
    url: '/api/trtc/callback',
    headers: { 'content-type': 'application/json', sign: createHmac('sha256', key).update(raw).digest('base64') },
    payload: raw,
  });
}
const enterEvent = (roomId: number, userId: number, at: Date) => ({
  EventGroupId: 1,
  EventType: 103,
  CallbackTs: at.getTime(),
  EventInfo: {
    RoomId: roomId,
    EventTs: Math.floor(at.getTime() / 1000),
    EventMsTs: at.getTime(),
    UserId: `u${userId}`,
  },
});

describe('进入通话', () => {
  test('时间窗口、只能进自己的预约；MOCK 模式直接记为已进房', async () => {
    const w = await world();
    const join = (who: { token: string }, path: string) => call(w.ctx, 'POST', path, { token: who.token });
    const userPath = `/api/appointments/${w.a.id}/join`;
    expect((await join(w.u, userPath)).statusCode).toBe(409);

    const early = mins(w, 'startAt', -5);
    w.ctx.clock.set(early);
    const ru = await join(w.u, userPath);
    expect(ru.statusCode).toBe(200);
    expect(ru.json()).toEqual({ mock: true, sdkAppId: 0, roomId: w.a.id, imId: `u${w.u.userId}`, userSig: 'mock' });
    expect((await join(w.t, userPath)).statusCode).toBe(404);
    expect((await join(w.t, `/api/teacher/appointments/${w.a.id}/join`)).statusCode).toBe(200);
    expect(await current(w)).toMatchObject({ teacherJoinedAt: early, userJoinedAt: early });

    w.ctx.clock.set(addMs(w.a.endAt, 1));
    expect((await join(w.u, userPath)).statusCode).toBe(409);
  });
});

describe('TRTC 房间回调', () => {
  test('双方进房后解散房间 → 通话完成；签名错误 401；非法 JSON 400', async () => {
    const w = await world(REAL);
    const start = w.a.startAt;
    expect((await trtc(w.ctx, enterEvent(w.a.id, w.t.userId, start), 'wrong')).statusCode).toBe(401);
    expect((await current(w)).teacherJoinedAt).toBeNull();
    const bad = await w.ctx.app.inject({
      method: 'POST',
      url: '/api/trtc/callback',
      headers: { 'content-type': 'application/json', sign: createHmac('sha256', 'ck').update('{').digest('base64') },
      payload: '{',
    });
    expect(bad.statusCode).toBe(400);

    await trtc(w.ctx, enterEvent(w.a.id, w.u.userId, mins(w, 'startAt', 1)));
    await trtc(w.ctx, enterEvent(w.a.id, w.t.userId, mins(w, 'startAt', 2)));
    await trtc(w.ctx, enterEvent(w.a.id, w.t.userId, start));
    expect(await current(w)).toMatchObject({ teacherJoinedAt: start, userJoinedAt: mins(w, 'startAt', 1) });

    const end = mins(w, 'startAt', 50);
    const res = await trtc(w.ctx, {
      EventGroupId: 1,
      EventType: 102,
      EventInfo: { RoomId: String(w.a.id), EventTs: Math.floor(end.getTime() / 1000) },
    });
    expect(res.json()).toEqual({ code: 0 });
    expect(await current(w)).toMatchObject({ status: 'completed', endedAt: end, confirmStatus: null });
    expect(await callsLeft(w)).toBe(3);
  });

  test('只有老师进房就解散，不算完成', async () => {
    const w = await world(REAL);
    await recordEnter(w.db, w.a.id, w.t.userId, w.a.startAt);
    expect(await onRoomDismissed(w.db, w.a.id, mins(w, 'startAt', 1))).toBe(false);
    expect((await current(w)).status).toBe('booked');
  });
});

describe('爽约与自动完成', () => {
  test('开始 15 分钟后老师仍未进房 → 爽约，退还次数并通知双方', async () => {
    const w = await world();
    expect(await markNoShows(w.db, mins(w, 'startAt', 14))).toBe(0);
    expect(await markNoShows(w.db, mins(w, 'startAt', 15))).toBe(1);
    expect((await current(w)).status).toBe('teacher_no_show');
    expect(await callsLeft(w)).toBe(4);
    expect(await noticesOf(w.db, w.u.userId, 'teacher_no_show')).toHaveLength(1);
    expect(await noticesOf(w.db, w.t.userId, 'teacher_no_show')).toHaveLength(1);
    expect(await recordEnter(w.db, w.a.id, w.t.userId, mins(w, 'startAt', 16))).toBe(false);
  });

  test('老师进过房、结束 30 分钟后仍无解散回调 → 自动完成（学员未到也消耗次数）', async () => {
    const w = await world();
    await recordEnter(w.db, w.a.id, w.t.userId, w.a.startAt);
    expect(await markNoShows(w.db, mins(w, 'startAt', 20))).toBe(0);
    expect(await autoComplete(w.db, mins(w, 'endAt', 29))).toBe(0);
    expect(await autoComplete(w.db, mins(w, 'endAt', 30))).toBe(1);
    expect(await current(w)).toMatchObject({ status: 'completed', endedAt: w.a.endAt });
    expect(await callsLeft(w)).toBe(3);
  });
});
