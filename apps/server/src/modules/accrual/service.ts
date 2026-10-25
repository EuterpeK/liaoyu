import { and, eq, gte, lte, min, ne } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { accruals, serviceRelations } from '../../db/schema.ts';
import { activeDayIndex, segmentOn } from '../../domain/segments.ts';
import { eachDay } from '../../lib/dates.ts';
import { splitEvenly } from '../../lib/money.ts';
import { loadSegments } from '../relations/service.ts';

/** 参与日计提的服务关系：进行中、未冻结、非单次 */
export const accruable = and(
  eq(serviceRelations.status, 'active'),
  eq(serviceRelations.frozen, false),
  ne(serviceRelations.packageType, 'single'),
);

export async function accrueForDate(db: DbOrTx, date: string): Promise<number> {
  const rels = await db
    .select({
      id: serviceRelations.id,
      amountCents: serviceRelations.amountCents,
      totalDays: serviceRelations.totalDays,
    })
    .from(serviceRelations)
    .where(and(accruable, lte(serviceRelations.startDate, date), gte(serviceRelations.endDate, date)));

  let created = 0;
  for (const r of rels) {
    created += await db.transaction(async (tx) => {
      // 与 rewriteSegments 的 FOR UPDATE 互斥，保证读到一致的分段
      await tx
        .select({ id: serviceRelations.id })
        .from(serviceRelations)
        .where(eq(serviceRelations.id, r.id))
        .for('share');
      const segs = await loadSegments(tx, r.id);
      const seg = segmentOn(segs, date);
      if (!seg || seg.teacherId === null) return 0;
      const idx = activeDayIndex(segs, date);
      if (idx >= r.totalDays) return 0;
      const rows = await tx
        .insert(accruals)
        .values({
          relationId: r.id,
          date,
          teacherId: seg.teacherId,
          amountCents: splitEvenly(r.amountCents, r.totalDays, idx),
        })
        .onConflictDoNothing({ target: [accruals.relationId, accruals.date] })
        .returning({ id: accruals.id });
      return rows.length;
    });
  }
  return created;
}

/** 从最早的可计提开始日补齐到 date（含），幂等 */
export async function accrueUpTo(db: DbOrTx, date: string): Promise<number> {
  const [row] = await db
    .select({ first: min(serviceRelations.startDate) })
    .from(serviceRelations)
    .where(accruable);
  if (!row?.first || row.first > date) return 0;
  let n = 0;
  for (const d of eachDay(row.first, date)) n += await accrueForDate(db, d);
  return n;
}
