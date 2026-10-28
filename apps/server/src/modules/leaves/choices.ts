import { and, asc, desc, eq, getTableColumns, inArray, lte } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { leaveChoices, leaves, serviceRelations, substituteCandidates, teacherProfiles } from '../../db/schema.ts';
import { pauseFromSubstitute, substituteFromPause } from '../../domain/segments.ts';
import { addMs, HOUR_MS, todayCN } from '../../lib/dates.ts';
import { HttpError } from '../../lib/errors.ts';
import { type Notice, notify } from '../../lib/notify.ts';
import { cancelAppointments } from '../appointments/service.ts';
import { rewriteSegments } from '../relations/service.ts';
import { lockTeacher } from '../teachers/service.ts';
import { type Candidate, CHOICE_HOURS, getCandidate, getLeave, leaveBlocker } from './service.ts';

const later = (a: string, b: string): string => (a > b ? a : b);

export type Choice = typeof leaveChoices.$inferSelect;
export type ChoiceDecision = { action: 'wait' } | { action: 'substitute'; teacherId: number };

export async function listChoices(db: DbOrTx, userId: number) {
  const rows = await db
    .select({
      ...getTableColumns(leaveChoices),
      startDate: leaves.startDate,
      endDate: leaves.endDate,
      ownerId: leaves.teacherId,
      ownerName: teacherProfiles.displayName,
    })
    .from(leaveChoices)
    .innerJoin(leaves, eq(leaves.id, leaveChoices.leaveId))
    .innerJoin(serviceRelations, eq(serviceRelations.id, leaveChoices.relationId))
    .innerJoin(teacherProfiles, eq(teacherProfiles.userId, leaves.teacherId))
    .where(eq(serviceRelations.userId, userId))
    .orderBy(desc(leaveChoices.id));
  if (rows.length === 0) return [];
  const cands = await db
    .select({
      leaveId: substituteCandidates.leaveId,
      teacherId: substituteCandidates.teacherId,
      displayName: teacherProfiles.displayName,
      level: teacherProfiles.level,
    })
    .from(substituteCandidates)
    .innerJoin(teacherProfiles, eq(teacherProfiles.userId, substituteCandidates.teacherId))
    .where(
      and(
        inArray(substituteCandidates.leaveId, [...new Set(rows.map((r) => r.leaveId))]),
        eq(substituteCandidates.status, 'accepted'),
      ),
    )
    .orderBy(asc(substituteCandidates.id));
  return rows.map((r) => ({ ...r, candidates: cands.filter((c) => c.leaveId === r.leaveId) }));
}

export async function decideChoice(
  db: DbOrTx,
  now: Date,
  q: { userId: number; choiceId: number } & ChoiceDecision,
): Promise<Choice> {
  const [head] = await db
    .select({ ownerId: leaves.teacherId })
    .from(leaveChoices)
    .innerJoin(leaves, eq(leaves.id, leaveChoices.leaveId))
    .where(eq(leaveChoices.id, q.choiceId));
  if (!head) throw new HttpError(404, '选择项不存在');
  const ownerId = head.ownerId;

  return db.transaction(async (tx) => {
    // 与撤销代班（原老师行 FOR UPDATE）互斥
    await lockTeacher(tx, ownerId, 'share');
    const [c] = await tx
      .select({
        ...getTableColumns(leaveChoices),
        userId: serviceRelations.userId,
        startDate: leaves.startDate,
        endDate: leaves.endDate,
      })
      .from(leaveChoices)
      .innerJoin(serviceRelations, eq(serviceRelations.id, leaveChoices.relationId))
      .innerJoin(leaves, eq(leaves.id, leaveChoices.leaveId))
      .where(eq(leaveChoices.id, q.choiceId))
      .for('update', { of: leaveChoices });
    if (!c || c.userId !== q.userId) throw new HttpError(404, '选择项不存在');
    if (c.status !== 'pending') throw new HttpError(409, '已处理过该选择');
    if (now.getTime() >= c.deadlineAt.getTime()) throw new HttpError(409, '已超过选择期限，服务已暂停顺延');
    const today = todayCN(now);
    if (c.endDate < today) throw new HttpError(409, '请假已结束');

    const notices: Notice[] = [
      {
        userId: ownerId,
        type: 'leave_choice',
        payload: { leaveId: c.leaveId, relationId: c.relationId, action: q.action },
      },
    ];
    let patch: Partial<typeof leaveChoices.$inferInsert>;
    if (q.action === 'wait') {
      patch = { status: 'wait', decidedAt: now };
    } else {
      const teacherId = q.teacherId;
      const cand = await getCandidate(tx, c.leaveId, teacherId);
      if (cand?.status !== 'accepted') throw new HttpError(400, '该老师不是可选的代班老师');
      const from = later(c.startDate, today);
      const blocked = await leaveBlocker(tx, ownerId);
      await rewriteSegments(tx, c.relationId, (s) =>
        substituteFromPause(s, { from, to: c.endDate, teacherId, ownerId, blocked }),
      );
      patch = { status: 'substitute', substituteTeacherId: teacherId, decidedAt: now };
      notices.push({
        userId: teacherId,
        type: 'substitute_assigned',
        payload: { leaveId: c.leaveId, relationId: c.relationId, userId: q.userId, from, to: c.endDate },
      });
    }
    const [row] = await tx.update(leaveChoices).set(patch).where(eq(leaveChoices.id, c.id)).returning();
    await notify(tx, ...notices);
    return row;
  });
}

export async function revokeSubstitute(
  db: DbOrTx,
  now: Date,
  q: { teacherId: number; leaveId: number; candidateId: number },
): Promise<Candidate> {
  return db.transaction(async (tx) => {
    await lockTeacher(tx, q.teacherId);
    const leave = await getLeave(tx, q.leaveId);
    if (!leave || leave.teacherId !== q.teacherId) throw new HttpError(404, '请假不存在');
    const [cand] = await tx
      .select()
      .from(substituteCandidates)
      .where(and(eq(substituteCandidates.leaveId, q.leaveId), eq(substituteCandidates.teacherId, q.candidateId)))
      .for('update');
    if (cand?.status !== 'accepted') throw new HttpError(409, '该老师不在已同意代班状态');
    const today = todayCN(now);
    if (leave.endDate < today) throw new HttpError(409, '请假已结束');

    const from = later(leave.startDate, today);
    const deadlineAt = addMs(now, CHOICE_HOURS * HOUR_MS);
    const [row] = await tx
      .update(substituteCandidates)
      .set({ status: 'revoked', respondedAt: now })
      .where(eq(substituteCandidates.id, cand.id))
      .returning();

    const choices = await tx
      .select({ id: leaveChoices.id, relationId: leaveChoices.relationId, userId: serviceRelations.userId })
      .from(leaveChoices)
      .innerJoin(serviceRelations, eq(serviceRelations.id, leaveChoices.relationId))
      .where(
        and(
          eq(leaveChoices.leaveId, leave.id),
          eq(leaveChoices.status, 'substitute'),
          eq(leaveChoices.substituteTeacherId, q.candidateId),
        ),
      )
      .orderBy(asc(leaveChoices.id))
      .for('update', { of: leaveChoices });
    const blocked = await leaveBlocker(tx, q.teacherId);
    const notices: Notice[] = [{ userId: q.candidateId, type: 'substitute_revoked', payload: { leaveId: leave.id } }];
    for (const ch of choices) {
      // biome-ignore lint/performance/noAwaitInLoops: 事务内顺序执行
      await rewriteSegments(tx, ch.relationId, (s) =>
        pauseFromSubstitute(s, { from, to: leave.endDate, teacherId: q.candidateId, ownerId: q.teacherId, blocked }),
      );
      await cancelAppointments(
        tx,
        { teacherId: q.candidateId, from, to: leave.endDate, relationId: ch.relationId },
        'leave',
      );
      await tx
        .update(leaveChoices)
        .set({ status: 'pending', substituteTeacherId: null, deadlineAt, decidedAt: null })
        .where(eq(leaveChoices.id, ch.id));
      notices.push({
        userId: ch.userId,
        type: 'substitute_revoked',
        payload: { leaveId: leave.id, relationId: ch.relationId, deadlineAt: deadlineAt.toISOString() },
      });
    }
    await notify(tx, ...notices);
    return row;
  });
}

/** 到期未选择的置为 expired（保持暂停）。分钟级任务调用，幂等 */
export async function expireChoices(db: DbOrTx, now: Date): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: leaveChoices.id,
        leaveId: leaveChoices.leaveId,
        relationId: leaveChoices.relationId,
        userId: serviceRelations.userId,
      })
      .from(leaveChoices)
      .innerJoin(serviceRelations, eq(serviceRelations.id, leaveChoices.relationId))
      .where(and(eq(leaveChoices.status, 'pending'), lte(leaveChoices.deadlineAt, now)))
      .orderBy(asc(leaveChoices.id))
      .for('update', { of: leaveChoices, skipLocked: true });
    if (rows.length === 0) return 0;
    await tx
      .update(leaveChoices)
      .set({ status: 'expired', decidedAt: now })
      .where(
        inArray(
          leaveChoices.id,
          rows.map((r) => r.id),
        ),
      );
    await notify(
      tx,
      ...rows.map(
        (r): Notice => ({
          userId: r.userId,
          type: 'leave_choice_expired',
          payload: { leaveId: r.leaveId, relationId: r.relationId },
        }),
      ),
    );
    return rows.length;
  });
}
