import { and, asc, desc, eq, getTableColumns, gte, lte, type SQL, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import {
  appointments,
  type CancelActor,
  leaves,
  schedules,
  serviceRelations,
  teacherProfiles,
  users,
} from '../../db/schema.ts';
import { segmentOn } from '../../domain/segments.ts';
import { addDays, cnTime, HOUR_MS, hhmmToMin, MINUTE_MS, minToHhmm, todayCN, weekdayOf } from '../../lib/dates.ts';
import { HttpError } from '../../lib/errors.ts';
import { notify } from '../../lib/notify.ts';
import { pgConstraint } from '../../lib/pg-errors.ts';
import { loadSegments, lockRelation } from '../relations/service.ts';
import { lockTeacher } from '../teachers/service.ts';

export const CALL_MINUTES = 60;
export const SLOT_STEP_MINUTES = 30;
export const BOOK_LEAD_MINUTES = 60;
export const BOOK_WINDOW_DAYS = 14;
export const USER_CANCEL_HOURS = 12;

export type Appointment = typeof appointments.$inferSelect;
type Relation = typeof serviceRelations.$inferSelect;

export async function getAppointment(db: DbOrTx, id: number): Promise<Appointment | undefined> {
  const [a] = await db.select().from(appointments).where(eq(appointments.id, id));
  return a;
}

export async function teacherOnLeave(db: DbOrTx, teacherId: number, date: string): Promise<boolean> {
  const rows = await db
    .select({ id: leaves.id })
    .from(leaves)
    .where(and(eq(leaves.teacherId, teacherId), lte(leaves.startDate, date), gte(leaves.endDate, date)))
    .limit(1);
  return rows.length > 0;
}

export async function availableSlots(db: DbOrTx, now: Date, teacherId: number, date: string): Promise<string[]> {
  const today = todayCN(now);
  if (date < today || date > addDays(today, BOOK_WINDOW_DAYS)) return [];
  if (await teacherOnLeave(db, teacherId, date)) return [];
  const windows = await db
    .select({ startMin: schedules.startMin, endMin: schedules.endMin })
    .from(schedules)
    .where(and(eq(schedules.teacherId, teacherId), eq(schedules.weekday, weekdayOf(date))))
    .orderBy(asc(schedules.startMin));
  const busy = await db
    .select({ startAt: appointments.startAt, endAt: appointments.endAt })
    .from(appointments)
    .where(and(eq(appointments.teacherId, teacherId), eq(appointments.date, date), eq(appointments.status, 'booked')));

  const earliest = now.getTime() + BOOK_LEAD_MINUTES * MINUTE_MS;
  const out: string[] = [];
  for (const w of windows) {
    const first = Math.ceil(w.startMin / SLOT_STEP_MINUTES) * SLOT_STEP_MINUTES;
    for (let m = first; m + CALL_MINUTES <= w.endMin; m += SLOT_STEP_MINUTES) {
      const s = cnTime(date, m).getTime();
      const e = s + CALL_MINUTES * MINUTE_MS;
      if (s < earliest) continue;
      if (busy.some((b) => b.startAt.getTime() < e && s < b.endAt.getTime())) continue;
      out.push(minToHhmm(m));
    }
  }
  return out;
}

/** 某日负责该服务关系的老师；暂停日或不在服务期内为 null */
export async function responsibleTeacher(db: DbOrTx, relationId: number, date: string): Promise<number | null> {
  const seg = segmentOn(await loadSegments(db, relationId), date);
  return seg && seg.kind !== 'paused' ? seg.teacherId : null;
}

async function getUserRelation(db: DbOrTx, relationId: number, userId: number): Promise<Relation> {
  const [r] = await db
    .select()
    .from(serviceRelations)
    .where(and(eq(serviceRelations.id, relationId), eq(serviceRelations.userId, userId)));
  if (!r) throw new HttpError(404, '服务不存在');
  return r;
}

function assertBookable(rel: Relation, date: string): void {
  if (rel.status !== 'active' || rel.frozen) throw new HttpError(409, '该服务当前不可预约');
  if (date < rel.startDate || date > rel.endDate) throw new HttpError(400, '预约日期不在服务期内');
  if (rel.callsLeft <= 0) throw new HttpError(409, '通话次数已用完');
}

export async function slotsForRelation(
  db: DbOrTx,
  now: Date,
  q: { userId: number; relationId: number; date: string },
): Promise<{ teacherId: number | null; slots: string[] }> {
  const rel = await getUserRelation(db, q.relationId, q.userId);
  if (rel.status !== 'active' || rel.frozen || q.date < rel.startDate || q.date > rel.endDate) {
    return { teacherId: null, slots: [] };
  }
  const teacherId = await responsibleTeacher(db, rel.id, q.date);
  return { teacherId, slots: teacherId === null ? [] : await availableSlots(db, now, teacherId, q.date) };
}

export async function book(
  db: DbOrTx,
  now: Date,
  input: { userId: number; relationId: number; date: string; start: string },
): Promise<Appointment> {
  assertBookable(await getUserRelation(db, input.relationId, input.userId), input.date);
  const teacherId = await responsibleTeacher(db, input.relationId, input.date);
  if (teacherId === null) throw new HttpError(409, '该日期服务暂停，不可预约');

  try {
    return await db.transaction(async (tx) => {
      await lockTeacher(tx, teacherId, 'share');
      const rel = await lockRelation(tx, input.relationId);
      if (!rel || rel.userId !== input.userId) throw new HttpError(404, '服务不存在');
      assertBookable(rel, input.date);
      if ((await responsibleTeacher(tx, rel.id, input.date)) !== teacherId) {
        throw new HttpError(409, '服务安排已变化，请刷新后重试');
      }
      if (!(await availableSlots(tx, now, teacherId, input.date)).includes(input.start)) {
        throw new HttpError(409, '该时段不可预约');
      }
      const startAt = cnTime(input.date, hhmmToMin(input.start));
      const [a] = await tx
        .insert(appointments)
        .values({
          relationId: rel.id,
          userId: input.userId,
          teacherId,
          date: input.date,
          startAt,
          endAt: new Date(startAt.getTime() + CALL_MINUTES * MINUTE_MS),
        })
        .returning();
      await tx
        .update(serviceRelations)
        .set({ callsLeft: sql`${serviceRelations.callsLeft} - 1` })
        .where(eq(serviceRelations.id, rel.id));
      await notify(tx, {
        userId: teacherId,
        type: 'appointment_booked',
        payload: { appointmentId: a.id, date: input.date, start: input.start },
      });
      return a;
    });
  } catch (e) {
    if (pgConstraint(e) === 'appointments_teacher_no_overlap') throw new HttpError(409, '该时段已被预约');
    throw e;
  }
}

/**
 * 释放一个仍为 booked 的预约（取消 / 爽约），退还次数。
 * 调用方须在事务中；按「服务关系 → 预约」顺序加锁。已不是 booked 时返回 null。
 */
export async function releaseCall(
  tx: DbOrTx,
  a: Appointment,
  patch: Partial<typeof appointments.$inferInsert>,
  extra?: SQL,
): Promise<Appointment | null> {
  await lockRelation(tx, a.relationId);
  const [row] = await tx
    .update(appointments)
    .set(patch)
    .where(and(eq(appointments.id, a.id), eq(appointments.status, 'booked'), extra))
    .returning();
  if (!row) return null;
  await tx
    .update(serviceRelations)
    .set({ callsLeft: sql`${serviceRelations.callsLeft} + 1` })
    .where(eq(serviceRelations.id, a.relationId));
  return row;
}

async function cancelOwn(db: DbOrTx, a: Appointment, by: 'user' | 'teacher'): Promise<Appointment> {
  return db.transaction(async (tx) => {
    const row = await releaseCall(tx, a, { status: 'cancelled', cancelBy: by });
    if (!row) throw new HttpError(409, '该预约不可取消');
    await notify(tx, {
      userId: by === 'user' ? a.teacherId : a.userId,
      type: 'appointment_cancelled',
      payload: { appointmentId: a.id, by },
    });
    return row;
  });
}

export async function cancelByUser(db: DbOrTx, now: Date, q: { userId: number; id: number }): Promise<Appointment> {
  const a = await getAppointment(db, q.id);
  if (!a || a.userId !== q.userId) throw new HttpError(404, '预约不存在');
  if (a.status !== 'booked') throw new HttpError(409, '该预约不可取消');
  if (a.startAt.getTime() - now.getTime() < USER_CANCEL_HOURS * HOUR_MS) {
    throw new HttpError(409, `开始前 ${USER_CANCEL_HOURS} 小时内不可取消，请联系老师`);
  }
  return cancelOwn(db, a, 'user');
}

export async function cancelByTeacher(
  db: DbOrTx,
  now: Date,
  q: { teacherId: number; id: number },
): Promise<Appointment> {
  const a = await getAppointment(db, q.id);
  if (!a || a.teacherId !== q.teacherId) throw new HttpError(404, '预约不存在');
  if (a.status !== 'booked') throw new HttpError(409, '该预约不可取消');
  if (a.startAt.getTime() <= now.getTime()) throw new HttpError(409, '已开始的预约不可取消');
  return cancelOwn(db, a, 'teacher');
}

/** 批量取消某老师在日期区间内的预约（请假 / 撤销代班使用）。调用方须在事务中 */
export async function cancelAppointments(
  tx: DbOrTx,
  f: { teacherId: number; from: string; to: string; relationId?: number },
  by: CancelActor,
): Promise<number> {
  const rows = await tx
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.status, 'booked'),
        eq(appointments.teacherId, f.teacherId),
        gte(appointments.date, f.from),
        lte(appointments.date, f.to),
        f.relationId ? eq(appointments.relationId, f.relationId) : undefined,
      ),
    )
    .orderBy(asc(appointments.relationId), asc(appointments.id));
  let n = 0;
  for (const a of rows) {
    if (!(await releaseCall(tx, a, { status: 'cancelled', cancelBy: by }))) continue;
    n += 1;
    await notify(tx, { userId: a.userId, type: 'appointment_cancelled', payload: { appointmentId: a.id, by } });
  }
  return n;
}

export async function listForUser(db: DbOrTx, userId: number) {
  return db
    .select({ ...getTableColumns(appointments), teacherName: teacherProfiles.displayName })
    .from(appointments)
    .innerJoin(teacherProfiles, eq(teacherProfiles.userId, appointments.teacherId))
    .where(eq(appointments.userId, userId))
    .orderBy(desc(appointments.startAt));
}

export async function listForTeacher(db: DbOrTx, teacherId: number) {
  return db
    .select({ ...getTableColumns(appointments), userNickname: users.nickname })
    .from(appointments)
    .innerJoin(users, eq(users.id, appointments.userId))
    .where(eq(appointments.teacherId, teacherId))
    .orderBy(desc(appointments.startAt));
}
