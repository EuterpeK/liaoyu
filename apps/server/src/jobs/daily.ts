import { and, eq, lt } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { serviceRelations } from '../db/schema.ts';
import { addDays } from '../lib/dates.ts';
import { accrueUpTo } from '../modules/accrual/service.ts';

export async function runDailyJobs(db: DbOrTx, today: string): Promise<{ accrued: number; ended: number }> {
  const accrued = await accrueUpTo(db, addDays(today, -1));
  const ended = await db
    .update(serviceRelations)
    .set({ status: 'ended' })
    .where(
      and(
        eq(serviceRelations.status, 'active'),
        eq(serviceRelations.frozen, false),
        lt(serviceRelations.endDate, today),
      ),
    )
    .returning({ id: serviceRelations.id });
  return { accrued, ended: ended.length };
}
