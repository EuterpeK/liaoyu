import { and, eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { buyAndPay, call, insertPackage, loginTeacher, loginUser, noticesOf, setup } from '../../../tests/helpers.ts';
import { leaveChoices, leaves, serviceRelations, substituteCandidates } from '../../db/schema.ts';
import { availableSlots, book, getAppointment } from '../appointments/service.ts';
import { loadSegments } from '../relations/service.ts';
import { setSchedule } from '../schedule/service.ts';

async function world() {
  const ctx = await setup();
  const t = await loginTeacher(ctx, 't', { level: 2 });
  const s1 = await loginTeacher(ctx, 's1', { level: 2 });
  const s2 = await loginTeacher(ctx, 's2', { level: 3 });
  const low = await loginTeacher(ctx, 'low', { level: 1 });
  const u = await loginUser(ctx, 'u');
  const rel = await buyAndPay(ctx, u.userId, await insertPackage(ctx.db, t.userId));
  return { ctx, db: ctx.db, t, s1, s2, low, u, rel };
}
type World = Awaited<ReturnType<typeof world>>;
type Who = { token: string; userId: number };

const LEAVE = { startDate: '2026-11-10', endDate: '2026-11-14', reason: '出差' };
const apply = (w: World, who: Who, body: object) =>
  call(w.ctx, 'POST', '/api/teacher/leaves', { token: who.token, body });
const respond = (w: World, who: Who, leaveId: number, accept: boolean) =>
  call(w.ctx, 'POST', `/api/teacher/substitute-invites/${leaveId}/respond`, { token: who.token, body: { accept } });

describe('请假', () => {
  test('参数校验', async () => {
    const w = await world();
    const ok = [w.s1.userId];
    const status = async (who: Who, body: object) => (await apply(w, who, body)).statusCode;
    expect(await status(w.u, { ...LEAVE, candidateIds: ok })).toBe(403);
    expect(await status(w.t, { ...LEAVE, startDate: '2026-10-31', candidateIds: ok })).toBe(400);
    expect(await status(w.t, { ...LEAVE, endDate: '2026-11-09', candidateIds: ok })).toBe(400);
    expect(await status(w.t, { ...LEAVE, endDate: '2027-01-10', candidateIds: ok })).toBe(400);
    expect(await status(w.t, { ...LEAVE, candidateIds: [] })).toBe(400);
    expect(await status(w.t, { ...LEAVE, candidateIds: [w.s1.userId, w.s2.userId, w.low.userId, w.u.userId] })).toBe(
      400,
    );
    expect(await status(w.t, { ...LEAVE, candidateIds: [w.t.userId] })).toBe(400);
    expect(await status(w.t, { ...LEAVE, candidateIds: [w.low.userId] })).toBe(400);
    expect(await status(w.t, { ...LEAVE, candidateIds: [w.u.userId] })).toBe(400);
  });

  test('生效：学员分段暂停顺延、生成待选择、通知学员与候选老师', async () => {
    const w = await world();
    const res = await apply(w, w.t, { ...LEAVE, candidateIds: [w.s1.userId, w.s2.userId] });
    expect(res.statusCode).toBe(201);
    expect(await loadSegments(w.db, w.rel.id)).toEqual([
      { kind: 'normal', teacherId: w.t.userId, startDate: '2026-11-01', endDate: '2026-11-09' },
      { kind: 'paused', teacherId: null, startDate: '2026-11-10', endDate: '2026-11-14' },
      { kind: 'normal', teacherId: w.t.userId, startDate: '2026-11-15', endDate: '2026-12-05' },
    ]);
    const [r] = await w.db.select().from(serviceRelations);
    expect(r.endDate).toBe('2026-12-05');

    const [choice] = await w.db.select().from(leaveChoices);
    expect(choice).toMatchObject({ status: 'pending', relationId: w.rel.id });
    expect(choice.deadlineAt.toISOString()).toBe('2026-11-03T04:00:00.000Z');
    expect(await noticesOf(w.db, w.u.userId, 'leave_notice')).toHaveLength(1);
    expect(await noticesOf(w.db, w.s1.userId, 'substitute_invite')).toHaveLength(1);
    expect(await noticesOf(w.db, w.s2.userId, 'substitute_invite')).toHaveLength(1);

    const mine = (await call(w.ctx, 'GET', '/api/teacher/leaves', { token: w.t.token })).json();
    expect(mine).toHaveLength(1);
    expect(mine[0].candidates.map((c: { status: string }) => c.status)).toEqual(['invited', 'invited']);
    expect(mine[0].choices).toHaveLength(1);
  });

  test('请假期间已有预约自动取消并退还次数，请假日不可约', async () => {
    const w = await world();
    const now = w.ctx.clock.now();
    await setSchedule(w.db, w.t.userId, [{ weekday: 2, start: '09:00', end: '12:00' }]);
    const a = await book(w.db, now, { userId: w.u.userId, relationId: w.rel.id, date: '2026-11-10', start: '10:00' });
    await apply(w, w.t, { ...LEAVE, candidateIds: [w.s1.userId] });
    expect(await getAppointment(w.db, a.id)).toMatchObject({ status: 'cancelled', cancelBy: 'leave' });
    const [r] = await w.db.select().from(serviceRelations);
    expect(r.callsLeft).toBe(4);
    expect(await availableSlots(w.db, now, w.t.userId, '2026-11-10')).toEqual([]);
  });

  test('与已有请假重叠 409；候选老师同时段在请假 400', async () => {
    const w = await world();
    expect((await apply(w, w.t, { ...LEAVE, candidateIds: [w.s1.userId] })).statusCode).toBe(201);
    const overlap = { startDate: '2026-11-14', endDate: '2026-11-16', candidateIds: [w.s1.userId] };
    expect((await apply(w, w.t, overlap)).statusCode).toBe(409);
    await w.db.insert(leaves).values({ teacherId: w.s2.userId, startDate: '2026-11-20', endDate: '2026-11-22' });
    const busy = { startDate: '2026-11-21', endDate: '2026-11-21', candidateIds: [w.s2.userId] };
    expect((await apply(w, w.t, busy)).statusCode).toBe(400);
  });

  test('并发提交重叠请假只成功一个', async () => {
    const w = await world();
    const rs = await Promise.all([
      apply(w, w.t, { ...LEAVE, candidateIds: [w.s1.userId] }),
      apply(w, w.t, { startDate: '2026-11-12', endDate: '2026-11-16', candidateIds: [w.s1.userId] }),
    ]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(await w.db.$count(leaveChoices)).toBe(1);
  });
});

describe('代班邀请', () => {
  test('接受/拒绝、重复处理 409、通知原老师与待选择学员', async () => {
    const w = await world();
    const leaveId = (await apply(w, w.t, { ...LEAVE, candidateIds: [w.s1.userId, w.s2.userId] })).json().id;
    const inv = (await call(w.ctx, 'GET', '/api/teacher/substitute-invites', { token: w.s1.token })).json();
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ leaveId, status: 'invited', ownerName: `老师${w.t.userId}` });

    expect((await respond(w, w.s1, leaveId, true)).json().status).toBe('accepted');
    expect((await respond(w, w.s1, leaveId, false)).statusCode).toBe(409);
    expect((await respond(w, w.s2, leaveId, false)).json().status).toBe('rejected');
    expect((await respond(w, w.low, leaveId, true)).statusCode).toBe(404);
    expect(await noticesOf(w.db, w.t.userId, 'substitute_response')).toHaveLength(2);
    expect(await noticesOf(w.db, w.u.userId, 'substitute_available')).toHaveLength(1);
  });

  test('已答应代班的老师不能提交重叠请假；不重叠可以', async () => {
    const w = await world();
    const leaveId = (await apply(w, w.t, { ...LEAVE, candidateIds: [w.s1.userId] })).json().id;
    await respond(w, w.s1, leaveId, true);
    const cand = [w.s2.userId];
    expect(
      (await apply(w, w.s1, { startDate: '2026-11-12', endDate: '2026-11-20', candidateIds: cand })).statusCode,
    ).toBe(409);
    expect(
      (await apply(w, w.s1, { startDate: '2026-11-20', endDate: '2026-11-21', candidateIds: cand })).statusCode,
    ).toBe(201);
  });

  test('老师请假时，自动拒绝其未处理且时段重叠的代班邀请', async () => {
    const w = await world();
    const leaveId = (await apply(w, w.t, { ...LEAVE, candidateIds: [w.s1.userId] })).json().id;
    await apply(w, w.s1, { startDate: '2026-11-13', endDate: '2026-11-15', candidateIds: [w.s2.userId] });
    const [c] = await w.db
      .select()
      .from(substituteCandidates)
      .where(and(eq(substituteCandidates.leaveId, leaveId), eq(substituteCandidates.teacherId, w.s1.userId)));
    expect(c.status).toBe('rejected');
  });
});
