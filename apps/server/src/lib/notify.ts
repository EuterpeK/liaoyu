import type { DbOrTx } from '../db/client.ts';
import { notifications } from '../db/schema.ts';

export type NotificationType = (typeof notifications.$inferSelect)['type'];

export interface Notice {
  userId: number;
  type: NotificationType;
  payload: Record<string, unknown>;
}

/** 站内通知。事务内调用；一条失败整批回滚 */
export async function notify(db: DbOrTx, ...items: Notice[]): Promise<void> {
  if (items.length === 0) return;
  await db.insert(notifications).values(items);
}
