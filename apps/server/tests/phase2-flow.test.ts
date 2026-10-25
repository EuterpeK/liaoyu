import { describe, expect, test } from 'vitest';
import type { DbOrTx } from '../src/db/client.ts';
import { accruals, serviceRelations } from '../src/db/schema.ts';
import { runDailyJobs } from '../src/jobs/daily.ts';
import { runFrequentJobs } from '../src/jobs/frequent.ts';
import { addMs, HOUR_MS, MINUTE_MS } from '../src/lib/dates.ts';
import { book, getAppointment } from '../src/modules/appointments/service.ts';
import { createLeave } from '../src/modules/leaves/service.ts';
import { setSchedule } from '../src/modules/schedule/service.ts';
import { buyAndPay, call, insertPackage, loginTeacher, loginUser, setup } from './helpers.ts';

async function sumBy(db: DbOrTx, teacherId: number): Promise<number> {
  const rows = await db.select().from(accruals);
  return rows.filter((r) => r.teacherId === teacherId).reduce((s, r) => s + r.amountCents, 0);
}

describe('第二阶段', () => {
  test('runFrequentJobs 汇总各分钟级任务', async () => {
    const ctx = await setup();
    const now = ctx.clock.now();
    const t = await loginTeacher(ctx, 't');
    const s = await loginTeacher(ctx, 's');
    const u = await loginUser(ctx, 'u');
    await setSchedule(ctx.db, t.userId, [{ weekday: 1, start: '09:00', end: '12:00' }]);
    const rel = await buyAndPay(ctx, u.userId, await insertPackage(ctx.db, t.userId));
    const a = await book(ctx.db, now, { userId: u.userId, relationId: rel.id, date: '2026-11-02', start: '10:00' });
    await createLeave(ctx.db, now, {
      teacherId: t.userId,
      startDate: '2026-11-10',
      endDate: '2026-11-12',
      candidateIds: [s.userId],
    });

    expect(await runFrequentJobs(ctx.db, addMs(a.startAt, 15 * MINUTE_MS))).toEqual({
      expiredChoices: 0,
      noShows: 1,
      autoCompleted: 0,
      autoConfirmed: 0,
    });
    expect(await runFrequentJobs(ctx.db, addMs(now, 48 * HOUR_MS))).toEqual({
      expiredChoices: 1,
      noShows: 0,
      autoCompleted: 0,
      autoConfirmed: 0,
    });
  });

  test('全链路：排班 → 购买 → 预约 → 请假取消预约 → 选代班 → 与代班通话 → 计提归属', async () => {
    const ctx = await setup();
    const t = await loginTeacher(ctx, 't');
    const s = await loginTeacher(ctx, 's');
    const u = await loginUser(ctx, 'u');
    const as = (who: { token: string }) => ({ token: who.token });

    await call(ctx, 'PUT', '/api/teacher/schedule', {
      ...as(t),
      body: { items: [{ weekday: 2, start: '09:00', end: '12:00' }] },
    });
    await call(ctx, 'PUT', '/api/teacher/schedule', {
      ...as(s),
      body: { items: [{ weekday: 2, start: '14:00', end: '16:00' }] },
    });
    const pkg = (
      await call(ctx, 'POST', '/api/teacher/packages', {
        ...as(t),
        body: { type: 'month', title: '包月', priceCents: 3000, callQuota: 4, replyHours: 12 },
      })
    ).json();
    const order = (await call(ctx, 'POST', '/api/orders', { ...as(u), body: { packageId: pkg.id } })).json();
    await call(ctx, 'POST', '/api/pay/mock/confirm', { query: { out_trade_no: order.outTradeNo } });
    const [rel] = (await call(ctx, 'GET', '/api/relations', as(u))).json();

    const bookAt = (start: string) =>
      call(ctx, 'POST', '/api/appointments', { ...as(u), body: { relationId: rel.id, date: '2026-11-10', start } });
    const first = (await bookAt('10:00')).json();
    expect(first.teacherId).toBe(t.userId);

    const leave = (
      await call(ctx, 'POST', '/api/teacher/leaves', {
        ...as(t),
        body: { startDate: '2026-11-10', endDate: '2026-11-12', candidateIds: [s.userId] },
      })
    ).json();
    expect((await getAppointment(ctx.db, first.id))?.status).toBe('cancelled');
    await call(ctx, 'POST', `/api/teacher/substitute-invites/${leave.id}/respond`, {
      ...as(s),
      body: { accept: true },
    });

    const [choice] = (await call(ctx, 'GET', '/api/leave-choices', as(u))).json();
    await call(ctx, 'POST', `/api/leave-choices/${choice.id}`, {
      ...as(u),
      body: { action: 'substitute', teacherId: s.userId },
    });

    const slots = (
      await call(ctx, 'GET', '/api/appointments/slots', { ...as(u), query: { relationId: rel.id, date: '2026-11-10' } })
    ).json();
    expect(slots.teacherId).toBe(s.userId);
    const second = (await bookAt('14:00')).json();
    expect(second.teacherId).toBe(s.userId);

    const startAt = new Date(second.startAt);
    ctx.clock.set(addMs(startAt, -5 * MINUTE_MS));
    const contacts = (await call(ctx, 'GET', '/api/im/contacts', as(u))).json();
    expect(contacts.map((c: { userId: number }) => c.userId)).toEqual([t.userId, s.userId]);
    expect((await call(ctx, 'POST', `/api/teacher/appointments/${second.id}/join`, as(s))).statusCode).toBe(200);
    expect((await call(ctx, 'POST', `/api/appointments/${second.id}/join`, as(u))).statusCode).toBe(200);

    const done = await runFrequentJobs(ctx.db, addMs(new Date(second.endAt), 30 * MINUTE_MS));
    expect(done.autoCompleted).toBe(1);
    expect((await getAppointment(ctx.db, second.id))?.status).toBe('completed');

    await runDailyJobs(ctx.db, '2026-12-01');
    expect(await sumBy(ctx.db, s.userId)).toBe(300);
    expect(await sumBy(ctx.db, t.userId)).toBe(2700);
    const [r] = await ctx.db.select().from(serviceRelations);
    expect(r).toMatchObject({ callsLeft: 3, status: 'ended', endDate: '2026-11-30' });
  });
});
