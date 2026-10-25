import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { notifications } from '../../db/schema.ts';

export async function listNotifications(db: DbOrTx, userId: number, unread = false) {
  return db
    .select()
    .from(notifications)
    .where(
      unread
        ? and(eq(notifications.userId, userId), eq(notifications.isRead, false))
        : eq(notifications.userId, userId),
    )
    .orderBy(desc(notifications.id))
    .limit(50);
}

export async function markRead(db: DbOrTx, userId: number, ids?: number[]): Promise<number> {
  const rows = await db
    .update(notifications)
    .set({ isRead: true })
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.isRead, false),
        ids?.length ? inArray(notifications.id, ids) : undefined,
      ),
    )
    .returning({ id: notifications.id });
  return rows.length;
}
