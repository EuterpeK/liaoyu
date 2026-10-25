import { eq, sql } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { buyAndPay, insertPackage, insertTeacher, insertUser, setup } from '../../../tests/helpers.ts';
import type { DbOrTx } from '../../db/client.ts';
import { accruals, serviceRelations } from '../../db/schema.ts';
import { applyPause, applySubstitute } from '../../domain/segments.ts';
import { runDailyJobs } from '../../jobs/daily.ts';
import { rewriteSegments } from '../relations/service.ts';
import { accrueForDate, accrueUpTo } from './service.ts';

async function world(priceCents = 3000) {
  const ctx = await setup();
  const teacher = await insertTeacher(ctx.db, 'a');
  const sub = await insertTeacher(ctx.db, 'b');
  const user = await insertUser(ctx.db, 'u');
  const rel = await buyAndPay(ctx, user, await insertPackage(ctx.db, teacher, { priceCents }));
  return { ctx, db: ctx.db, teacher, sub, rel };
}

async function sumBy(db: DbOrTx, teacherId: number): Promise<number> {
  const [r] = await db
    .select({ s: sql<number>`COALESCE(SUM(${accruals.amountCents}), 0)::bigint` })
    .from(accruals)
    .where(eq(accruals.teacherId, teacherId));
  return r.s;
}

const setFrozen = (db: DbOrTx, frozen: boolean) => db.update(serviceRelations).set({ frozen });

describe('日计提', () => {
  test('按日计提且幂等', async () => {
    const w = await world();
    expect(await accrueForDate(w.db, '2026-11-01')).toBe(1);
    expect(await accrueForDate(w.db, '2026-11-01')).toBe(0);
    const [row] = await w.db.select().from(accruals);
    expect(row).toMatchObject({ amountCents: 100, teacherId: w.teacher, date: '2026-11-01' });
  });

  test('服务期外不计提', async () => {
    const w = await world();
    expect(await accrueForDate(w.db, '2026-10-31')).toBe(0);
    expect(await accrueForDate(w.db, '2026-12-01')).toBe(0);
  });

  test('代班期间计给代班老师', async () => {
    const w = await world();
    await rewriteSegments(w.db, w.rel.id, (s) =>
      applySubstitute(s, { from: '2026-11-10', to: '2026-11-12', teacherId: w.sub }),
    );
    await accrueUpTo(w.db, '2026-11-30');
    expect(await sumBy(w.db, w.sub)).toBe(300);
    expect(await sumBy(w.db, w.teacher)).toBe(2700);
  });

  test('暂停不计提并顺延，总额精确等于订单金额', async () => {
    const w = await world(1000);
    await rewriteSegments(w.db, w.rel.id, (s) => applyPause(s, { from: '2026-11-10', to: '2026-11-14' }));
    await accrueUpTo(w.db, '2026-12-05');
    expect(await w.db.$count(accruals, eq(accruals.date, '2026-11-10'))).toBe(0);
    const [d15] = await w.db.select().from(accruals).where(eq(accruals.date, '2026-11-15'));
    expect(d15.amountCents).toBe(34);
    expect(await w.db.$count(accruals)).toBe(30);
    expect(await sumBy(w.db, w.teacher)).toBe(1000);
  });

  test('冻结不计提，解冻后补算', async () => {
    const w = await world();
    await setFrozen(w.db, true);
    expect(await accrueUpTo(w.db, '2026-11-05')).toBe(0);
    await setFrozen(w.db, false);
    expect(await accrueUpTo(w.db, '2026-11-05')).toBe(5);
  });

  test('单次套餐不参与日计提', async () => {
    const ctx = await setup();
    const t = await insertTeacher(ctx.db, 'a');
    const pkg = await insertPackage(ctx.db, t, { type: 'single', days: 0, callQuota: 1, priceCents: 500 });
    await buyAndPay(ctx, await insertUser(ctx.db, 'u'), pkg);
    expect(await accrueUpTo(ctx.db, '2026-11-30')).toBe(0);
  });

  test('每日任务：计提到昨天并结束到期关系', async () => {
    const w = await world();
    expect(await runDailyJobs(w.db, '2026-12-01')).toEqual({ accrued: 30, ended: 1 });
    const [r] = await w.db.select().from(serviceRelations);
    expect(r.status).toBe('ended');
    expect(await sumBy(w.db, w.teacher)).toBe(3000);
    expect(await runDailyJobs(w.db, '2026-12-01')).toEqual({ accrued: 0, ended: 0 });
  });
});
