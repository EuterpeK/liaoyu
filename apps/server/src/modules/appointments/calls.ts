import { and, asc, eq, isNotNull, isNull, lte, type SQL, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { accruals, appointments, serviceRelations } from '../../db/schema.ts';
import { addMs, HOUR_MS, MINUTE_MS } from '../../lib/dates.ts';
import { HttpError } from '../../lib/errors.ts';
import { notify } from '../../lib/notify.ts';
import { imCredential, type TencentConfig } from '../../providers/tencent.ts';
import { lockRelation } from '../relations/service.ts';
import { type Appointment, getAppointment, releaseCall } from './service.ts';

export const JOIN_EARLY_MINUTES = 10;
export const NO_SHOW_MINUTES = 15;
export const AUTO_COMPLETE_MINUTES = 30;

export interface JoinTicket {
  mock: boolean;
  sdkAppId: number;
  roomId: number;
  imId: string;
  userSig: string;
}

/** 记录最早一次进房时间。PostgreSQL 的 LEAST 忽略 NULL，回调乱序时也保留最早值 */
export async function recordEnter(db: DbOrTx, appointmentId: number, userId: number, at: Date): Promise<boolean> {
  const a = await getAppointment(db, appointmentId);
  if (a?.status !== 'booked') return false;
  const set =
    userId === a.teacherId
      ? { teacherJoinedAt: sql`LEAST(${appointments.teacherJoinedAt}, ${at}::timestamptz)` }
      : userId === a.userId
        ? { userJoinedAt: sql`LEAST(${appointments.userJoinedAt}, ${at}::timestamptz)` }
        : null;
  if (!set) return false;
  const rows = await db
    .update(appointments)
    .set(set)
    .where(and(eq(appointments.id, a.id), eq(appointments.status, 'booked')))
    .returning({ id: appointments.id });
  return rows.length > 0;
}

export async function joinCall(
  db: DbOrTx,
  now: Date,
  tc: TencentConfig,
  q: { userId: number; id: number; asTeacher: boolean },
): Promise<JoinTicket> {
  const a = await getAppointment(db, q.id);
  if (!a || (q.asTeacher ? a.teacherId : a.userId) !== q.userId) throw new HttpError(404, '预约不存在');
  if (a.status !== 'booked') throw new HttpError(409, '该预约不可进入');
  const t = now.getTime();
  if (t < a.startAt.getTime() - JOIN_EARLY_MINUTES * MINUTE_MS || t > a.endAt.getTime()) {
    throw new HttpError(409, `请在开始前 ${JOIN_EARLY_MINUTES} 分钟至结束前进入`);
  }
  const cred = imCredential(tc, q.userId, now);
  if (cred.mock) await recordEnter(db, a.id, q.userId, now);
  return { mock: cred.mock, sdkAppId: cred.sdkAppId, roomId: a.id, imId: cred.imId, userSig: cred.userSig };
}

/** 置为完成（要求老师进过房，extra 为附加条件）。单次套餐进入待确认并通知学员 */
async function completeCall(db: DbOrTx, a: Appointment, endedAt: Date, extra?: SQL): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rel = await lockRelation(tx, a.relationId);
    const single = rel?.packageType === 'single';
    const rows = await tx
      .update(appointments)
      .set({ status: 'completed', endedAt, confirmStatus: single ? 'pending' : null })
      .where(
        and(
          eq(appointments.id, a.id),
          eq(appointments.status, 'booked'),
          isNotNull(appointments.teacherJoinedAt),
          extra,
        ),
      )
      .returning({ id: appointments.id });
    if (rows.length === 0) return false;
    if (single) {
      await notify(tx, { userId: a.userId, type: 'call_confirm_request', payload: { appointmentId: a.id } });
    }
    return true;
  });
}

export async function onRoomDismissed(db: DbOrTx, appointmentId: number, at: Date): Promise<boolean> {
  const a = await getAppointment(db, appointmentId);
  if (!a) return false;
  return completeCall(db, a, at, isNotNull(appointments.userJoinedAt));
}

export async function markNoShows(db: DbOrTx, now: Date): Promise<number> {
  const cutoff = addMs(now, -NO_SHOW_MINUTES * MINUTE_MS);
  const rows = await db
    .select()
    .from(appointments)
    .where(
      and(eq(appointments.status, 'booked'), isNull(appointments.teacherJoinedAt), lte(appointments.startAt, cutoff)),
    )
    .orderBy(asc(appointments.id));
  let n = 0;
  for (const a of rows) {
    // biome-ignore lint/performance/noAwaitInLoops: 逐条独立事务
    const done = await db.transaction(async (tx) => {
      const row = await releaseCall(tx, a, { status: 'teacher_no_show' }, isNull(appointments.teacherJoinedAt));
      if (!row) return false;
      const payload = { appointmentId: a.id };
      await notify(
        tx,
        { userId: a.userId, type: 'teacher_no_show', payload },
        { userId: a.teacherId, type: 'teacher_no_show', payload },
      );
      return true;
    });
    if (done) n += 1;
  }
  return n;
}

export async function autoComplete(db: DbOrTx, now: Date): Promise<number> {
  const cutoff = addMs(now, -AUTO_COMPLETE_MINUTES * MINUTE_MS);
  const rows = await db
    .select()
    .from(appointments)
    .where(
      and(eq(appointments.status, 'booked'), isNotNull(appointments.teacherJoinedAt), lte(appointments.endAt, cutoff)),
    )
    .orderBy(asc(appointments.id));
  let n = 0;
  for (const a of rows) {
    // biome-ignore lint/performance/noAwaitInLoops: 逐条独立事务
    if (await completeCall(db, a, a.endAt)) n += 1;
  }
  return n;
}

export const CONFIRM_HOURS = 48;

/** 单次套餐：全额计给上课老师并结束服务关系。调用方须在事务中且已锁服务关系行 */
async function accrueSingle(tx: DbOrTx, a: Appointment): Promise<void> {
  const [rel] = await tx.select().from(serviceRelations).where(eq(serviceRelations.id, a.relationId));
  if (rel?.packageType !== 'single') return;
  await tx
    .insert(accruals)
    .values({ relationId: rel.id, date: a.date, teacherId: a.teacherId, amountCents: rel.amountCents })
    .onConflictDoNothing({ target: [accruals.relationId, accruals.date] });
  await tx
    .update(serviceRelations)
    .set({ status: 'ended' })
    .where(and(eq(serviceRelations.id, rel.id), eq(serviceRelations.status, 'active')));
}

/** 待确认 → confirmed/disputed/auto；已不是 pending 时返回 null。调用方须在事务中 */
async function settleConfirm(
  tx: DbOrTx,
  a: Appointment,
  to: 'confirmed' | 'disputed' | 'auto',
): Promise<Appointment | null> {
  await lockRelation(tx, a.relationId);
  const [row] = await tx
    .update(appointments)
    .set({ confirmStatus: to })
    .where(
      and(eq(appointments.id, a.id), eq(appointments.status, 'completed'), eq(appointments.confirmStatus, 'pending')),
    )
    .returning();
  if (!row) return null;
  if (to === 'disputed') {
    await notify(tx, { userId: a.teacherId, type: 'call_disputed', payload: { appointmentId: a.id } });
  } else {
    await accrueSingle(tx, row);
  }
  return row;
}

export async function confirmCall(db: DbOrTx, q: { userId: number; id: number; ok: boolean }): Promise<Appointment> {
  const a = await getAppointment(db, q.id);
  if (!a || a.userId !== q.userId) throw new HttpError(404, '预约不存在');
  return db.transaction(async (tx) => {
    const row = await settleConfirm(tx, a, q.ok ? 'confirmed' : 'disputed');
    if (!row) throw new HttpError(409, '该通话无需确认');
    return row;
  });
}

export async function autoConfirm(db: DbOrTx, now: Date): Promise<number> {
  const cutoff = addMs(now, -CONFIRM_HOURS * HOUR_MS);
  const rows = await db
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.status, 'completed'),
        eq(appointments.confirmStatus, 'pending'),
        lte(appointments.endedAt, cutoff),
      ),
    )
    .orderBy(asc(appointments.id));
  let n = 0;
  for (const a of rows) {
    // biome-ignore lint/performance/noAwaitInLoops: 逐条独立事务
    if (await db.transaction((tx) => settleConfirm(tx, a, 'auto'))) n += 1;
  }
  return n;
}
