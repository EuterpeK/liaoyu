import { and, asc, desc, eq, getTableColumns, max, ne } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { type orders, serviceRelations, serviceSegments, teacherProfiles, users } from '../../db/schema.ts';
import { initialSegments, type Segment } from '../../domain/segments.ts';
import { addDays } from '../../lib/dates.ts';
import { HttpError } from '../../lib/errors.ts';

export const SINGLE_VALID_DAYS = 30;

type Order = typeof orders.$inferSelect;

export async function loadSegments(db: DbOrTx, relationId: number): Promise<Segment[]> {
  return db
    .select({
      kind: serviceSegments.kind,
      teacherId: serviceSegments.teacherId,
      startDate: serviceSegments.startDate,
      endDate: serviceSegments.endDate,
    })
    .from(serviceSegments)
    .where(eq(serviceSegments.relationId, relationId))
    .orderBy(asc(serviceSegments.startDate));
}

/** 调用方必须处于事务中，且已锁住该服务关系行 */
async function replaceSegments(tx: DbOrTx, relationId: number, segments: readonly Segment[]): Promise<void> {
  const last = segments.at(-1);
  if (!last) throw new Error('分段不能为空');
  await tx.delete(serviceSegments).where(eq(serviceSegments.relationId, relationId));
  await tx.insert(serviceSegments).values(segments.map((s) => ({ relationId, ...s })));
  await tx.update(serviceRelations).set({ endDate: last.endDate }).where(eq(serviceRelations.id, relationId));
}

export async function rewriteSegments(
  db: DbOrTx,
  relationId: number,
  change: (segments: Segment[]) => Segment[],
): Promise<Segment[]> {
  return db.transaction(async (tx) => {
    const [rel] = await tx
      .select({ id: serviceRelations.id })
      .from(serviceRelations)
      .where(eq(serviceRelations.id, relationId))
      .for('update');
    if (!rel) throw new HttpError(404, '服务关系不存在');
    const next = change(await loadSegments(tx, relationId));
    await replaceSegments(tx, relationId, next);
    return next;
  });
}

/** 调用方必须处于事务中，且已锁住该用户行（保证续费顺接不重叠） */
export async function createRelationForOrder(tx: DbOrTx, order: Order, today: string): Promise<number> {
  const snap = order.packageSnapshot;
  const isSingle = snap.type === 'single';
  let start = today;
  if (!isSingle) {
    const [row] = await tx
      .select({ last: max(serviceRelations.endDate) })
      .from(serviceRelations)
      .where(
        and(
          eq(serviceRelations.userId, order.userId),
          eq(serviceRelations.teacherId, order.teacherId),
          eq(serviceRelations.status, 'active'),
          ne(serviceRelations.packageType, 'single'),
        ),
      );
    if (row?.last && row.last >= today) start = addDays(row.last, 1);
  }
  const totalDays = isSingle ? 0 : snap.days;
  const end = addDays(start, (isSingle ? SINGLE_VALID_DAYS : totalDays) - 1);
  const [rel] = await tx
    .insert(serviceRelations)
    .values({
      orderId: order.id,
      userId: order.userId,
      teacherId: order.teacherId,
      packageType: snap.type,
      amountCents: order.amountCents,
      totalDays,
      startDate: start,
      endDate: end,
      callsLeft: snap.callQuota,
      replyHours: snap.replyHours,
    })
    .returning({ id: serviceRelations.id });
  await replaceSegments(tx, rel.id, initialSegments(order.teacherId, start, end));
  return rel.id;
}

export async function listUserRelations(db: DbOrTx, userId: number) {
  return db
    .select({ ...getTableColumns(serviceRelations), teacherName: teacherProfiles.displayName })
    .from(serviceRelations)
    .innerJoin(teacherProfiles, eq(teacherProfiles.userId, serviceRelations.teacherId))
    .where(eq(serviceRelations.userId, userId))
    .orderBy(desc(serviceRelations.id));
}

export async function listTeacherStudents(db: DbOrTx, teacherId: number) {
  return db
    .select({ ...getTableColumns(serviceRelations), userNickname: users.nickname })
    .from(serviceRelations)
    .innerJoin(users, eq(users.id, serviceRelations.userId))
    .where(eq(serviceRelations.teacherId, teacherId))
    .orderBy(asc(serviceRelations.status), asc(serviceRelations.endDate));
}
