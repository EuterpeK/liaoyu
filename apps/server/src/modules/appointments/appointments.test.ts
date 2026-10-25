import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { buyAndPay, call, insertPackage, loginTeacher, loginUser, noticesOf, setup } from '../../../tests/helpers.ts';
import { leaves, serviceRelations } from '../../db/schema.ts';
import { applyPause, applySubstitute } from '../../domain/segments.ts';
import { addMs, HOUR_MS } from '../../lib/dates.ts';
import { rewriteSegments } from '../relations/service.ts';
import { setSchedule } from '../schedule/service.ts';
import { cancelByUser } from './service.ts';

const MON = '2026-11-02';

async function world() {
  const ctx = await setup();
  const t = await loginTeacher(ctx, 't1');
  const sub = await loginTeacher(ctx, 't2');
  const u = await loginUser(ctx, 'u1');
  await setSchedule(ctx.db, t.userId, [{ weekday: 1, start: '09:00', end: '12:00' }]);
  await setSchedule(ctx.db, sub.userId, [{ weekday: 1, start: '14:00', end: '16:00' }]);
  const pkg = await insertPackage(ctx.db, t.userId);
  const rel = await buyAndPay(ctx, u.userId, pkg);
  return { ctx, db: ctx.db, t, sub, u, rel, pkg };
}
type World = Awaited<ReturnType<typeof world>>;

const slots = (w: World) =>
  call(w.ctx, 'GET', '/api/appointments/slots', { token: w.u.token, query: { relationId: w.rel.id, date: MON } });
const book = (w: World, start: string, date = MON, who = w.u, relationId = w.rel.id) =>
  call(w.ctx, 'POST', '/api/appointments', { token: who.token, body: { relationId, date, start } });
async function callsLeft(w: World): Promise<number> {
  const [r] = await w.db
    .select({ n: serviceRelations.callsLeft })
    .from(serviceRelations)
    .where(eq(serviceRelations.id, w.rel.id));
  return r.n;
}

describe('可约时段与预约', () => {
  test('按负责老师的排班返回可约时段', async () => {
    const w = await world();
    const res = await slots(w);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ teacherId: w.t.userId, slots: ['09:00', '09:30', '10:00', '10:30', '11:00'] });
  });

  test('预约成功：扣次数、占用时段、通知老师', async () => {
    const w = await world();
    const r = await book(w, '10:00');
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      teacherId: w.t.userId,
      date: MON,
      startAt: '2026-11-02T02:00:00.000Z',
      endAt: '2026-11-02T03:00:00.000Z',
      status: 'booked',
    });
    expect(await callsLeft(w)).toBe(3);
    expect((await slots(w)).json().slots).toEqual(['09:00', '11:00']);
    expect(await noticesOf(w.db, w.t.userId, 'appointment_booked')).toHaveLength(1);
  });

  test('不可约时段 409、服务期外 400、次数用完 409', async () => {
    const w = await world();
    expect((await book(w, '08:00')).statusCode).toBe(409);
    expect((await book(w, '09:00', '2026-12-07')).statusCode).toBe(400);
    await w.db.update(serviceRelations).set({ callsLeft: 0 });
    expect((await book(w, '09:00')).statusCode).toBe(409);
  });

  test('暂停日不可约', async () => {
    const w = await world();
    await rewriteSegments(w.db, w.rel.id, (s) => applyPause(s, { from: MON, to: MON }));
    expect((await slots(w)).json()).toEqual({ teacherId: null, slots: [] });
    expect((await book(w, '09:00')).statusCode).toBe(409);
  });

  test('代班日按代班老师排班，预约归代班老师', async () => {
    const w = await world();
    await rewriteSegments(w.db, w.rel.id, (s) => applySubstitute(s, { from: MON, to: MON, teacherId: w.sub.userId }));
    expect((await slots(w)).json()).toEqual({ teacherId: w.sub.userId, slots: ['14:00', '14:30', '15:00'] });
    expect((await book(w, '14:00')).json().teacherId).toBe(w.sub.userId);
  });

  test('同一时段并发预约只成功一个', async () => {
    const w = await world();
    const u2 = await loginUser(w.ctx, 'u2');
    const rel2 = await buyAndPay(w.ctx, u2.userId, w.pkg);
    const rs = await Promise.all([book(w, '10:00'), book(w, '10:00', MON, u2, rel2.id)]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });
});

describe('取消预约', () => {
  test('用户取消：开始前 12 小时以上可取消并退次数，之后不可', async () => {
    const w = await world();
    const a = (await book(w, '10:00')).json();
    const late = addMs(new Date(a.startAt), -11 * HOUR_MS);
    await expect(cancelByUser(w.db, late, { userId: w.u.userId, id: a.id })).rejects.toThrow(/12 小时/);

    const ok = await call(w.ctx, 'POST', `/api/appointments/${a.id}/cancel`, { token: w.u.token });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'cancelled', cancelBy: 'user' });
    expect(await callsLeft(w)).toBe(4);
    expect((await call(w.ctx, 'POST', `/api/appointments/${a.id}/cancel`, { token: w.u.token })).statusCode).toBe(409);
  });

  test('老师取消：退次数并通知用户；不能取消别人的预约', async () => {
    const w = await world();
    const a = (await book(w, '10:00')).json();
    const url = `/api/teacher/appointments/${a.id}/cancel`;
    expect((await call(w.ctx, 'POST', url, { token: w.sub.token })).statusCode).toBe(404);
    const r = await call(w.ctx, 'POST', url, { token: w.t.token });
    expect(r.json()).toMatchObject({ status: 'cancelled', cancelBy: 'teacher' });
    expect(await callsLeft(w)).toBe(4);
    expect(await noticesOf(w.db, w.u.userId, 'appointment_cancelled')).toHaveLength(1);
  });

  test('用户与老师都能看到预约列表；老师请假日无可约时段', async () => {
    const w = await world();
    await book(w, '10:00');
    const mine = (await call(w.ctx, 'GET', '/api/appointments', { token: w.u.token })).json();
    expect(mine).toHaveLength(1);
    expect(mine[0].teacherName).toBe(`老师${w.t.userId}`);
    expect((await call(w.ctx, 'GET', '/api/teacher/appointments', { token: w.t.token })).json()).toHaveLength(1);

    await w.db.insert(leaves).values({ teacherId: w.t.userId, startDate: MON, endDate: MON });
    expect((await slots(w)).json().slots).toEqual([]);
  });
});
