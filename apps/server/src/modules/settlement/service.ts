import { and, asc, desc, eq, getTableColumns, gte, isNull, lte, notInArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { accruals, serviceRelations, settings, settlements, teacherProfiles } from '../../db/schema.ts';
import type { Clock } from '../../lib/clock.ts';
import { previousWeek } from '../../lib/dates.ts';
import { HttpError } from '../../lib/errors.ts';
import { commissionOf } from '../../lib/money.ts';

export const COMMISSION_KEY = 'commission_bps';
export const DEFAULT_COMMISSION_BPS = 2000;

export type Settlement = typeof settlements.$inferSelect;
export type SettlementStatus = Settlement['status'];

export async function getCommissionBps(db: DbOrTx): Promise<number> {
  const [r] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, COMMISSION_KEY));
  return typeof r?.value === 'number' ? r.value : DEFAULT_COMMISSION_BPS;
}

export async function setCommissionBps(db: DbOrTx, bps: number): Promise<void> {
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) throw new HttpError(400, '抽成基点须为 0~9999 的整数');
  await db
    .insert(settings)
    .values({ key: COMMISSION_KEY, value: bps })
    .onConflictDoUpdate({ target: settings.key, set: { value: bps } });
}

export async function generateSettlements(
  db: DbOrTx,
  { periodStart, periodEnd }: { periodStart: string; periodEnd: string },
): Promise<Settlement[]> {
  if (periodStart > periodEnd) throw new HttpError(400, '结算区间非法');
  return db.transaction(async (tx) => {
    // 72001：结算专用咨询锁，事务结束自动释放
    await tx.execute(sql`SELECT pg_advisory_xact_lock(72001)`);
    const bps = await getCommissionBps(tx);
    const frozenIds = tx
      .select({ id: serviceRelations.id })
      .from(serviceRelations)
      .where(eq(serviceRelations.frozen, true));
    const unsettled = and(
      isNull(accruals.settlementId),
      gte(accruals.date, periodStart),
      lte(accruals.date, periodEnd),
      notInArray(accruals.relationId, frozenIds),
    );
    const rows = await tx
      .select({ teacherId: accruals.teacherId, gross: sql<number>`SUM(${accruals.amountCents})::bigint` })
      .from(accruals)
      .where(unsettled)
      .groupBy(accruals.teacherId)
      .orderBy(asc(accruals.teacherId));

    const out: Settlement[] = [];
    for (const r of rows) {
      const commissionCents = commissionOf(r.gross, bps);
      const [s] = await tx
        .insert(settlements)
        .values({
          teacherId: r.teacherId,
          periodStart,
          periodEnd,
          grossCents: r.gross,
          commissionBps: bps,
          commissionCents,
          netCents: r.gross - commissionCents,
        })
        .returning();
      await tx
        .update(accruals)
        .set({ settlementId: s.id })
        .where(and(unsettled, eq(accruals.teacherId, r.teacherId)));
      out.push(s);
    }
    return out;
  });
}

export async function runWeeklySettlement(db: DbOrTx, today: string): Promise<Settlement[]> {
  const [periodStart, periodEnd] = previousWeek(today);
  return generateSettlements(db, { periodStart, periodEnd });
}

export async function listSettlements(db: DbOrTx, status?: SettlementStatus) {
  return db
    .select({ ...getTableColumns(settlements), teacherName: teacherProfiles.displayName })
    .from(settlements)
    .innerJoin(teacherProfiles, eq(teacherProfiles.userId, settlements.teacherId))
    .where(status ? eq(settlements.status, status) : undefined)
    .orderBy(desc(settlements.id));
}

export async function markSettlementPaid(
  db: DbOrTx,
  clock: Clock,
  id: number,
  { proof, adminId }: { proof: string; adminId: number },
): Promise<Settlement> {
  const [s] = await db
    .update(settlements)
    .set({ status: 'paid', proof, operatorId: adminId, paidAt: clock.now() })
    .where(and(eq(settlements.id, id), eq(settlements.status, 'pending')))
    .returning();
  if (!s) throw new HttpError(409, '结算单不存在或已打款');
  return s;
}
