import { describe, expect, test } from 'vitest';
import { buyAndPay, call, insertPackage, loginTeacher, loginUser, noticesOf, setup } from '../../../tests/helpers.ts';
import { accruals, type packages, serviceRelations } from '../../db/schema.ts';
import { addMs, HOUR_MS, MINUTE_MS } from '../../lib/dates.ts';
import { setSchedule } from '../schedule/service.ts';
import { generateSettlements } from '../settlement/service.ts';
import { autoConfirm, book, getAppointment, onRoomDismissed, recordEnter } from './service.ts';

const SINGLE = { type: 'single', title: '单次咨询', days: 0, callQuota: 1, priceCents: 500 } as const;

async function world(pkg: Partial<typeof packages.$inferInsert> = SINGLE) {
  const ctx = await setup();
  const t = await loginTeacher(ctx, 't');
  const u = await loginUser(ctx, 'u');
  await setSchedule(ctx.db, t.userId, [{ weekday: 1, start: '09:00', end: '12:00' }]);
  const rel = await buyAndPay(ctx, u.userId, await insertPackage(ctx.db, t.userId, pkg));
  const a = await book(ctx.db, ctx.clock.now(), {
    userId: u.userId,
    relationId: rel.id,
    date: '2026-11-02',
    start: '10:00',
  });
  await recordEnter(ctx.db, a.id, t.userId, a.startAt);
  await recordEnter(ctx.db, a.id, u.userId, a.startAt);
  const ended = addMs(a.startAt, 50 * MINUTE_MS);
  await onRoomDismissed(ctx.db, a.id, ended);
  return { ctx, db: ctx.db, t, u, rel, a, ended };
}
type World = Awaited<ReturnType<typeof world>>;

const confirm = (w: World, ok: boolean) =>
  call(w.ctx, 'POST', `/api/appointments/${w.a.id}/confirm`, { token: w.u.token, body: { ok } });
const accrualRows = (w: World) =>
  w.db.select({ date: accruals.date, teacherId: accruals.teacherId, amountCents: accruals.amountCents }).from(accruals);
const confirmStatus = async (w: World) => (await getAppointment(w.db, w.a.id))?.confirmStatus;

describe('单次套餐通话确认', () => {
  test('通话完成后待用户确认，并通知用户', async () => {
    const w = await world();
    expect(await confirmStatus(w)).toBe('pending');
    expect(await noticesOf(w.db, w.u.userId, 'call_confirm_request')).toHaveLength(1);
    expect(await accrualRows(w)).toEqual([]);
  });

  test('用户确认 → 全额计给上课老师、服务关系结束、进入周结算；重复确认 409', async () => {
    const w = await world();
    const res = await confirm(w, true);
    expect(res.statusCode).toBe(200);
    expect(res.json().confirmStatus).toBe('confirmed');
    expect(await accrualRows(w)).toEqual([{ date: '2026-11-02', teacherId: w.t.userId, amountCents: 500 }]);
    const [r] = await w.db.select().from(serviceRelations);
    expect(r.status).toBe('ended');
    const [s] = await generateSettlements(w.db, { periodStart: '2026-11-01', periodEnd: '2026-11-07' });
    expect(s.grossCents).toBe(500);
    expect((await confirm(w, true)).statusCode).toBe(409);
  });

  test('用户提出异议 → 不计提，通知老师', async () => {
    const w = await world();
    expect((await confirm(w, false)).json().confirmStatus).toBe('disputed');
    expect(await accrualRows(w)).toEqual([]);
    expect(await noticesOf(w.db, w.t.userId, 'call_disputed')).toHaveLength(1);
  });

  test('完成 48 小时内无异议自动确认；与用户确认并发只计一次', async () => {
    const w = await world();
    expect(await autoConfirm(w.db, addMs(w.ended, 47 * HOUR_MS))).toBe(0);
    const [auto, manual] = await Promise.all([autoConfirm(w.db, addMs(w.ended, 48 * HOUR_MS)), confirm(w, true)]);
    expect(auto + (manual.statusCode === 200 ? 1 : 0)).toBe(1);
    expect(['auto', 'confirmed']).toContain(await confirmStatus(w));
    expect(await accrualRows(w)).toHaveLength(1);
  });

  test('周期套餐的通话不需要确认', async () => {
    const w = await world({});
    expect(await confirmStatus(w)).toBeNull();
    expect((await confirm(w, true)).statusCode).toBe(409);
  });
});
