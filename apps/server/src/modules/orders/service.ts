import { randomInt } from 'node:crypto';
import { eq, getTableColumns } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { orders, type PackageSnapshot, packages, teacherProfiles, users } from '../../db/schema.ts';
import type { Clock } from '../../lib/clock.ts';
import { formatDateTimeCN, todayCN } from '../../lib/dates.ts';
import { HttpError } from '../../lib/errors.ts';
import { createRelationForOrder } from '../relations/service.ts';

export type Order = typeof orders.$inferSelect;

export type FulfillResult = { ok: true; fulfilled: boolean } | { ok: false; reason: 'not_found' | 'amount_mismatch' };

export function genOutTradeNo(now: Date): string {
  return `${formatDateTimeCN(now).replace(/\D/g, '')}${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
}

export async function getOrderByOutTradeNo(db: DbOrTx, outTradeNo: string): Promise<Order | undefined> {
  const [o] = await db.select().from(orders).where(eq(orders.outTradeNo, outTradeNo));
  return o;
}

export async function createOrder(
  db: DbOrTx,
  clock: Clock,
  input: { userId: number; packageId: number; provider: string },
): Promise<Order> {
  const [pkg] = await db
    .select({ ...getTableColumns(packages), teacherStatus: teacherProfiles.status })
    .from(packages)
    .innerJoin(teacherProfiles, eq(teacherProfiles.userId, packages.teacherId))
    .where(eq(packages.id, input.packageId));
  if (!pkg || !pkg.onSale || pkg.teacherStatus !== 'active') throw new HttpError(400, '套餐不存在或已下架');
  if (pkg.teacherId === input.userId) throw new HttpError(400, '不能购买自己的套餐');

  const snapshot: PackageSnapshot = {
    type: pkg.type,
    title: pkg.title,
    priceCents: pkg.priceCents,
    days: pkg.days,
    callQuota: pkg.callQuota,
    replyHours: pkg.replyHours,
  };
  const now = clock.now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const [order] = await db
      .insert(orders)
      .values({
        outTradeNo: genOutTradeNo(now),
        userId: input.userId,
        teacherId: pkg.teacherId,
        packageId: pkg.id,
        packageSnapshot: snapshot,
        amountCents: pkg.priceCents,
        payProvider: input.provider,
        createdAt: now,
      })
      .onConflictDoNothing({ target: orders.outTradeNo })
      .returning();
    if (order) return order;
  }
  throw new Error('生成订单号失败');
}

export async function fulfillOrder(
  db: DbOrTx,
  clock: Clock,
  outTradeNo: string,
  paid: { tradeNo: string; paidCents: number },
): Promise<FulfillResult> {
  return db.transaction(async (tx): Promise<FulfillResult> => {
    const [order] = await tx.select().from(orders).where(eq(orders.outTradeNo, outTradeNo)).for('update');
    if (!order) return { ok: false, reason: 'not_found' };
    if (order.status === 'paid') return { ok: true, fulfilled: false };
    if (paid.paidCents !== order.amountCents) return { ok: false, reason: 'amount_mismatch' };

    await tx.select({ id: users.id }).from(users).where(eq(users.id, order.userId)).for('update');
    const now = clock.now();
    await tx.update(orders).set({ status: 'paid', tradeNo: paid.tradeNo, paidAt: now }).where(eq(orders.id, order.id));
    await createRelationForOrder(tx, order, todayCN(now));
    return { ok: true, fulfilled: true };
  });
}
