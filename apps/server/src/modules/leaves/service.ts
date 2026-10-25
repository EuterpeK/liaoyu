import { and, asc, desc, eq, exists, getTableColumns, gt, gte, inArray, lte, ne, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import {
  leaveChoices,
  leaves,
  serviceRelations,
  serviceSegments,
  substituteCandidates,
  teacherProfiles,
} from '../../db/schema.ts';
import { type DayPredicate, pauseFromSubstitute, pauseRange, substituteFromPause } from '../../domain/segments.ts';
import { addMs, diffDays, HOUR_MS, todayCN } from '../../lib/dates.ts';
import { HttpError } from '../../lib/errors.ts';
import { type Notice, notify } from '../../lib/notify.ts';
import { pgConstraint } from '../../lib/pg-errors.ts';
import { cancelAppointments } from '../appointments/service.ts';
import { rewriteSegments } from '../relations/service.ts';
import { lockTeacher } from '../teachers/service.ts';

export const MAX_LEAVE_DAYS = 60;
export const MAX_CANDIDATES = 3;
export const CHOICE_HOURS = 48;

export type Leave = typeof leaves.$inferSelect;
export type Candidate = typeof substituteCandidates.$inferSelect;

export async function getLeave(db: DbOrTx, id: number): Promise<Leave | undefined> {
  const [l] = await db.select().from(leaves).where(eq(leaves.id, id));
  return l;
}

export async function getCandidate(db: DbOrTx, leaveId: number, teacherId: number): Promise<Candidate | undefined> {
  const [c] = await db
    .select()
    .from(substituteCandidates)
    .where(and(eq(substituteCandidates.leaveId, leaveId), eq(substituteCandidates.teacherId, teacherId)));
  return c;
}

const leaveOverlaps = (from: string, to: string) => and(lte(leaves.startDate, to), gte(leaves.endDate, from));

async function onLeave(db: DbOrTx, teacherId: number, from: string, to: string): Promise<boolean> {
  return (await db.$count(leaves, and(eq(leaves.teacherId, teacherId), leaveOverlaps(from, to)))) > 0;
}

async function substitutingDuring(db: DbOrTx, teacherId: number, from: string, to: string): Promise<boolean> {
  const rows = await db
    .select({ id: substituteCandidates.id })
    .from(substituteCandidates)
    .innerJoin(leaves, eq(leaves.id, substituteCandidates.leaveId))
    .where(
      and(
        eq(substituteCandidates.teacherId, teacherId),
        eq(substituteCandidates.status, 'accepted'),
        leaveOverlaps(from, to),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** 原老师的全部请假日：分段尾部补齐时跳过 */
export async function leaveBlocker(db: DbOrTx, teacherId: number): Promise<DayPredicate> {
  const ranges = await db
    .select({ from: leaves.startDate, to: leaves.endDate })
    .from(leaves)
    .where(eq(leaves.teacherId, teacherId));
  return (d) => ranges.some((r) => r.from <= d && d <= r.to);
}

async function affectedRelations(tx: DbOrTx, teacherId: number, from: string, to: string) {
  return tx
    .select({ id: serviceRelations.id, userId: serviceRelations.userId })
    .from(serviceRelations)
    .where(
      and(
        eq(serviceRelations.teacherId, teacherId),
        eq(serviceRelations.status, 'active'),
        or(ne(serviceRelations.packageType, 'single'), gt(serviceRelations.callsLeft, 0)),
        exists(
          tx
            .select({ one: sql`1` })
            .from(serviceSegments)
            .where(
              and(
                eq(serviceSegments.relationId, serviceRelations.id),
                eq(serviceSegments.kind, 'normal'),
                lte(serviceSegments.startDate, to),
                gte(serviceSegments.endDate, from),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(serviceRelations.id));
}

export interface LeaveInput {
  teacherId: number;
  startDate: string;
  endDate: string;
  reason?: string;
  candidateIds: number[];
}

export async function createLeave(db: DbOrTx, now: Date, input: LeaveInput): Promise<Leave> {
  const { teacherId, startDate, endDate } = input;
  if (startDate > endDate) throw new HttpError(400, '请假结束日期不能早于开始日期');
  if (startDate < todayCN(now)) throw new HttpError(400, '请假开始日期不能早于今天');
  if (diffDays(startDate, endDate) + 1 > MAX_LEAVE_DAYS) throw new HttpError(400, `单次请假最长 ${MAX_LEAVE_DAYS} 天`);
  const ids = [...new Set(input.candidateIds)];
  if (ids.length < 1 || ids.length > MAX_CANDIDATES) throw new HttpError(400, `请指定 1~${MAX_CANDIDATES} 位代班老师`);
  if (ids.includes(teacherId)) throw new HttpError(400, '不能指定自己代班');

  try {
    return await db.transaction(async (tx) => {
      const me = await lockTeacher(tx, teacherId);
      if (!me || me.status !== 'active') throw new HttpError(403, '仅已认证老师可操作');
      if (await onLeave(tx, teacherId, startDate, endDate)) throw new HttpError(409, '与已有请假时间重叠');
      if (await substitutingDuring(tx, teacherId, startDate, endDate)) {
        throw new HttpError(409, '你已答应该时段的代班，请先联系原老师撤销');
      }
      const cands = await tx
        .select({ userId: teacherProfiles.userId, level: teacherProfiles.level, status: teacherProfiles.status })
        .from(teacherProfiles)
        .where(inArray(teacherProfiles.userId, ids));
      for (const id of ids) {
        const c = cands.find((x) => x.userId === id);
        if (!c || c.status !== 'active') throw new HttpError(400, '代班老师不存在或未认证');
        if (c.level < me.level) throw new HttpError(400, '代班老师须为同级或更高级');
        // biome-ignore lint/performance/noAwaitInLoops: 事务内顺序执行
        if (await onLeave(tx, id, startDate, endDate)) throw new HttpError(400, '代班老师该时段也在请假');
      }

      const [leave] = await tx
        .insert(leaves)
        .values({ teacherId, startDate, endDate, reason: input.reason ?? '', createdAt: now })
        .returning();

      // 自己请假期间无法代班：自动拒绝未处理且时段重叠的邀请
      await tx
        .update(substituteCandidates)
        .set({ status: 'rejected', respondedAt: now })
        .where(
          and(
            eq(substituteCandidates.teacherId, teacherId),
            eq(substituteCandidates.status, 'invited'),
            inArray(
              substituteCandidates.leaveId,
              tx.select({ id: leaves.id }).from(leaves).where(leaveOverlaps(startDate, endDate)),
            ),
          ),
        );

      await tx.insert(substituteCandidates).values(ids.map((id) => ({ leaveId: leave.id, teacherId: id })));
      await cancelAppointments(tx, { teacherId, from: startDate, to: endDate }, 'leave');

      const blocked = await leaveBlocker(tx, teacherId);
      const deadlineAt = addMs(now, CHOICE_HOURS * HOUR_MS);
      const notices: Notice[] = ids.map((id) => ({
        userId: id,
        type: 'substitute_invite',
        payload: { leaveId: leave.id, fromTeacherId: teacherId, startDate, endDate },
      }));
      for (const r of await affectedRelations(tx, teacherId, startDate, endDate)) {
        // biome-ignore lint/performance/noAwaitInLoops: 事务内顺序执行
        await rewriteSegments(tx, r.id, (s) =>
          pauseRange(s, { from: startDate, to: endDate, ownerId: teacherId, blocked }),
        );
        await tx.insert(leaveChoices).values({ leaveId: leave.id, relationId: r.id, deadlineAt });
        notices.push({
          userId: r.userId,
          type: 'leave_notice',
          payload: { leaveId: leave.id, relationId: r.id, startDate, endDate, deadlineAt: deadlineAt.toISOString() },
        });
      }
      await notify(tx, ...notices);
      return leave;
    });
  } catch (e) {
    if (pgConstraint(e) === 'leaves_no_overlap') throw new HttpError(409, '与已有请假时间重叠');
    throw e;
  }
}

export async function listLeaves(db: DbOrTx, teacherId: number) {
  const rows = await db.select().from(leaves).where(eq(leaves.teacherId, teacherId)).orderBy(desc(leaves.startDate));
  if (rows.length === 0) return [];
  const ids = rows.map((l) => l.id);
  const cands = await db
    .select({
      leaveId: substituteCandidates.leaveId,
      teacherId: substituteCandidates.teacherId,
      status: substituteCandidates.status,
      displayName: teacherProfiles.displayName,
      level: teacherProfiles.level,
    })
    .from(substituteCandidates)
    .innerJoin(teacherProfiles, eq(teacherProfiles.userId, substituteCandidates.teacherId))
    .where(inArray(substituteCandidates.leaveId, ids))
    .orderBy(asc(substituteCandidates.id));
  const choices = await db
    .select({
      id: leaveChoices.id,
      leaveId: leaveChoices.leaveId,
      relationId: leaveChoices.relationId,
      userId: serviceRelations.userId,
      status: leaveChoices.status,
      substituteTeacherId: leaveChoices.substituteTeacherId,
      deadlineAt: leaveChoices.deadlineAt,
    })
    .from(leaveChoices)
    .innerJoin(serviceRelations, eq(serviceRelations.id, leaveChoices.relationId))
    .where(inArray(leaveChoices.leaveId, ids))
    .orderBy(asc(leaveChoices.id));
  return rows.map((l) => ({
    ...l,
    candidates: cands.filter((c) => c.leaveId === l.id),
    choices: choices.filter((c) => c.leaveId === l.id),
  }));
}

export async function listInvites(db: DbOrTx, teacherId: number) {
  return db
    .select({
      leaveId: substituteCandidates.leaveId,
      status: substituteCandidates.status,
      startDate: leaves.startDate,
      endDate: leaves.endDate,
      reason: leaves.reason,
      ownerId: leaves.teacherId,
      ownerName: teacherProfiles.displayName,
    })
    .from(substituteCandidates)
    .innerJoin(leaves, eq(leaves.id, substituteCandidates.leaveId))
    .innerJoin(teacherProfiles, eq(teacherProfiles.userId, leaves.teacherId))
    .where(eq(substituteCandidates.teacherId, teacherId))
    .orderBy(desc(leaves.startDate));
}

export async function respondInvite(
  db: DbOrTx,
  now: Date,
  q: { teacherId: number; leaveId: number; accept: boolean },
): Promise<Candidate> {
  return db.transaction(async (tx) => {
    // 与本人提交请假互斥（见「并发」）
    await lockTeacher(tx, q.teacherId);
    const [c] = await tx
      .select()
      .from(substituteCandidates)
      .where(and(eq(substituteCandidates.leaveId, q.leaveId), eq(substituteCandidates.teacherId, q.teacherId)))
      .for('update');
    if (!c) throw new HttpError(404, '邀请不存在');
    if (c.status !== 'invited') throw new HttpError(409, '该邀请已处理');
    const leave = await getLeave(tx, q.leaveId);
    if (!leave || leave.endDate < todayCN(now)) throw new HttpError(409, '请假已结束');
    if (q.accept && (await onLeave(tx, q.teacherId, leave.startDate, leave.endDate))) {
      throw new HttpError(409, '你在该时段有请假，不能代班');
    }

    const [row] = await tx
      .update(substituteCandidates)
      .set({ status: q.accept ? 'accepted' : 'rejected', respondedAt: now })
      .where(eq(substituteCandidates.id, c.id))
      .returning();
    const notices: Notice[] = [
      {
        userId: leave.teacherId,
        type: 'substitute_response',
        payload: { leaveId: leave.id, teacherId: q.teacherId, accept: q.accept },
      },
    ];
    if (q.accept) {
      const waiting = await tx
        .select({ userId: serviceRelations.userId })
        .from(leaveChoices)
        .innerJoin(serviceRelations, eq(serviceRelations.id, leaveChoices.relationId))
        .where(and(eq(leaveChoices.leaveId, leave.id), eq(leaveChoices.status, 'pending')));
      for (const u of waiting) {
        notices.push({
          userId: u.userId,
          type: 'substitute_available',
          payload: { leaveId: leave.id, teacherId: q.teacherId },
        });
      }
    }
    await notify(tx, ...notices);
    return row;
  });
}

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
      if (!cand || cand.status !== 'accepted') throw new HttpError(400, '该老师不是可选的代班老师');
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
    if (!cand || cand.status !== 'accepted') throw new HttpError(409, '该老师不在已同意代班状态');
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
