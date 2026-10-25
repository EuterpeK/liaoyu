import { and, eq, gte, isNull, lt } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { replyWaits } from '../../db/schema.ts';
import { HOUR_MS } from '../../lib/dates.ts';
import type { ChatLink } from './service.ts';

/** 学员发给当天负责老师 → 开始计时；老师发给学员 → 结束计时 */
export async function onMessage(tx: DbOrTx, pair: ChatLink, fromId: number, now: Date): Promise<void> {
  if (fromId === pair.studentId) {
    if (pair.responsible !== pair.teacherId) return;
    await tx
      .insert(replyWaits)
      .values({
        teacherId: pair.teacherId,
        userId: pair.studentId,
        relationId: pair.relation.id,
        replyHours: pair.relation.replyHours,
        askedAt: now,
      })
      // 命中部分唯一索引 reply_waits_open_uq：已有未回复的计时，不重复
      .onConflictDoNothing();
    return;
  }
  await tx
    .update(replyWaits)
    .set({ repliedAt: now })
    .where(
      and(
        eq(replyWaits.teacherId, pair.teacherId),
        eq(replyWaits.userId, pair.studentId),
        isNull(replyWaits.repliedAt),
      ),
    );
}

export interface ReplyStats {
  total: number;
  onTime: number;
  rate: number | null;
}

export async function replyStats(
  db: DbOrTx,
  teacherId: number,
  q: { from: Date; to: Date; now: Date },
): Promise<ReplyStats> {
  const rows = await db
    .select({ askedAt: replyWaits.askedAt, repliedAt: replyWaits.repliedAt, replyHours: replyWaits.replyHours })
    .from(replyWaits)
    .where(and(eq(replyWaits.teacherId, teacherId), gte(replyWaits.askedAt, q.from), lt(replyWaits.askedAt, q.to)));
  let total = 0;
  let onTime = 0;
  for (const r of rows) {
    const deadline = r.askedAt.getTime() + r.replyHours * HOUR_MS;
    if (r.repliedAt) {
      total += 1;
      if (r.repliedAt.getTime() <= deadline) onTime += 1;
    } else if (q.now.getTime() > deadline) {
      total += 1;
    }
  }
  return { total, onTime, rate: total ? onTime / total : null };
}
