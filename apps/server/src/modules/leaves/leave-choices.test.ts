import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { buyAndPay, call, insertPackage, loginTeacher, loginUser, noticesOf, setup } from '../../../tests/helpers.ts';
import { accruals, leaveChoices, serviceRelations } from '../../db/schema.ts';
import { addMs, HOUR_MS } from '../../lib/dates.ts';
import { accrueUpTo } from '../accrual/service.ts';
import { book, getAppointment } from '../appointments/service.ts';
import { loadSegments } from '../relations/service.ts';
import { setSchedule } from '../schedule/service.ts';
import { createLeave, expireChoices, respondInvite } from './service.ts';

async function world(range = { startDate: '2026-11-10', endDate: '2026-11-14' }) {
  const ctx = await setup();
  const t = await loginTeacher(ctx, 't');
  const s1 = await loginTeacher(ctx, 's1');
  const s2 = await loginTeacher(ctx, 's2');
  const u = await loginUser(ctx, 'u');
  const rel = await buyAndPay(ctx, u.userId, await insertPackage(ctx.db, t.userId));
  const now = ctx.clock.now();
  const leave = await createLeave(ctx.db, now, { teacherId: t.userId, ...range, candidateIds: [s1.userId, s2.userId] });
  await respondInvite(ctx.db, now, { teacherId: s1.userId, leaveId: leave.id, accept: true });
  const [choice] = await ctx.db.select().from(leaveChoices).where(eq(leaveChoices.relationId, rel.id));
  return { ctx, db: ctx.db, t, s1, s2, u, rel, leave, choice, now };
}
type World = Awaited<ReturnType<typeof world>>;

const decide = (w: World, body: object, who = w.u) =>
  call(w.ctx, 'POST', `/api/leave-choices/${w.choice.id}`, { token: who.token, body });
const revoke = (w: World, who: { token: string }, candidateId: number) =>
  call(w.ctx, 'POST', `/api/teacher/leaves/${w.leave.id}/candidates/${candidateId}/revoke`, { token: who.token });
const currentChoice = async (w: World) =>
  (await w.db.select().from(leaveChoices).where(eq(leaveChoices.id, w.choice.id)))[0];
async function sumBy(w: World, teacherId: number): Promise<number> {
  const rows = await w.db.select().from(accruals).where(eq(accruals.teacherId, teacherId));
  return rows.reduce((s, r) => s + r.amountCents, 0);
}

describe('学员选择代班', () => {
  test('学员看到待选择项，只列出已同意的代班老师', async () => {
    const w = await world();
    const res = (await call(w.ctx, 'GET', '/api/leave-choices', { token: w.u.token })).json();
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ status: 'pending', ownerName: `老师${w.t.userId}` });
    expect(res[0].candidates.map((c: { teacherId: number }) => c.teacherId)).toEqual([w.s1.userId]);
  });

  test('选择代班：暂停日改为代班分段，代班期间计提归代班老师', async () => {
    const w = await world();
    const res = await decide(w, { action: 'substitute', teacherId: w.s1.userId });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('substitute');
    expect(await loadSegments(w.db, w.rel.id)).toEqual([
      { kind: 'normal', teacherId: w.t.userId, startDate: '2026-11-01', endDate: '2026-11-09' },
      { kind: 'substitute', teacherId: w.s1.userId, startDate: '2026-11-10', endDate: '2026-11-14' },
      { kind: 'normal', teacherId: w.t.userId, startDate: '2026-11-15', endDate: '2026-11-30' },
    ]);
    expect(await noticesOf(w.db, w.s1.userId, 'substitute_assigned')).toHaveLength(1);
    expect(await noticesOf(w.db, w.t.userId, 'leave_choice')).toHaveLength(1);
    await accrueUpTo(w.db, '2026-11-30');
    expect(await sumBy(w, w.s1.userId)).toBe(500);
    expect(await sumBy(w, w.t.userId)).toBe(2500);
  });

  test('只能选已同意的老师；他人不可操作；不能重复选择', async () => {
    const w = await world();
    expect((await decide(w, { action: 'substitute', teacherId: w.s2.userId })).statusCode).toBe(400);
    expect((await decide(w, { action: 'other' })).statusCode).toBe(400);
    expect((await decide(w, { action: 'substitute' })).statusCode).toBe(400);
    const other = await loginUser(w.ctx, 'x');
    expect((await decide(w, { action: 'wait' }, other)).statusCode).toBe(404);
    expect((await decide(w, { action: 'wait' })).json().status).toBe('wait');
    expect((await decide(w, { action: 'substitute', teacherId: w.s1.userId })).statusCode).toBe(409);
    expect((await loadSegments(w.db, w.rel.id))[1].kind).toBe('paused');
  });

  test('请假已开始后才选择：自选定当日起改为代班', async () => {
    const w = await world({ startDate: '2026-11-01', endDate: '2026-11-05' });
    w.ctx.clock.set('2026-11-03T02:00:00Z');
    expect((await decide(w, { action: 'substitute', teacherId: w.s1.userId })).statusCode).toBe(200);
    expect(await loadSegments(w.db, w.rel.id)).toEqual([
      { kind: 'paused', teacherId: null, startDate: '2026-11-01', endDate: '2026-11-02' },
      { kind: 'substitute', teacherId: w.s1.userId, startDate: '2026-11-03', endDate: '2026-11-05' },
      { kind: 'normal', teacherId: w.t.userId, startDate: '2026-11-06', endDate: '2026-12-02' },
    ]);
  });
});

describe('选择过期', () => {
  test('超过 48 小时未选择：过期并保持暂停，之后不能再选', async () => {
    const w = await world();
    expect(await expireChoices(w.db, addMs(w.now, 47 * HOUR_MS))).toBe(0);
    expect(await expireChoices(w.db, addMs(w.now, 48 * HOUR_MS))).toBe(1);
    expect((await currentChoice(w)).status).toBe('expired');
    expect(await noticesOf(w.db, w.u.userId, 'leave_choice_expired')).toHaveLength(1);
    expect((await decide(w, { action: 'wait' })).statusCode).toBe(409);
    expect((await loadSegments(w.db, w.rel.id))[1].kind).toBe('paused');
  });

  test('期限已到但过期任务尚未执行：选择被拒绝', async () => {
    const w = await world();
    w.ctx.clock.set(addMs(w.now, 48 * HOUR_MS));
    expect((await decide(w, { action: 'wait' })).statusCode).toBe(409);
  });
});

describe('撤销代班', () => {
  test('分段改回暂停、代班预约取消、学员重新获得选择期', async () => {
    const w = await world();
    await setSchedule(w.db, w.s1.userId, [{ weekday: 2, start: '09:00', end: '12:00' }]);
    await decide(w, { action: 'substitute', teacherId: w.s1.userId });
    const a = await book(w.db, w.now, { userId: w.u.userId, relationId: w.rel.id, date: '2026-11-10', start: '09:00' });
    expect(a.teacherId).toBe(w.s1.userId);

    w.ctx.clock.set(addMs(w.now, HOUR_MS));
    const res = await revoke(w, w.t, w.s1.userId);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('revoked');
    expect((await loadSegments(w.db, w.rel.id))[1].kind).toBe('paused');
    const [r] = await w.db.select().from(serviceRelations);
    expect(r).toMatchObject({ endDate: '2026-12-05', callsLeft: 4 });
    expect((await getAppointment(w.db, a.id))?.status).toBe('cancelled');

    const ch = await currentChoice(w);
    expect(ch).toMatchObject({ status: 'pending', substituteTeacherId: null, decidedAt: null });
    expect(ch.deadlineAt.toISOString()).toBe(addMs(w.now, 49 * HOUR_MS).toISOString());
    expect(await noticesOf(w.db, w.u.userId, 'substitute_revoked')).toHaveLength(1);
    expect(await noticesOf(w.db, w.s1.userId, 'substitute_revoked')).toHaveLength(1);

    expect((await revoke(w, w.t, w.s1.userId)).statusCode).toBe(409);
    expect((await revoke(w, w.s1, w.s2.userId)).statusCode).toBe(404);
  });

  test('撤销与学员选择并发：最终不会留下被撤销老师的代班分段', async () => {
    const w = await world();
    const [d, r] = await Promise.all([
      decide(w, { action: 'substitute', teacherId: w.s1.userId }),
      revoke(w, w.t, w.s1.userId),
    ]);
    expect(r.statusCode).toBe(200);
    expect([200, 400]).toContain(d.statusCode);
    expect((await currentChoice(w)).status).toBe('pending');
    expect((await loadSegments(w.db, w.rel.id)).some((s) => s.kind === 'substitute')).toBe(false);
  });
});
