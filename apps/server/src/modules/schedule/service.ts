import { asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { schedules } from '../../db/schema.ts';
import { hhmmToMin, minToHhmm } from '../../lib/dates.ts';
import { HttpError } from '../../lib/errors.ts';
import { lockTeacher } from '../teachers/service.ts';

export interface ScheduleItem {
  weekday: number;
  start: string;
  end: string;
}

export function parseSchedule(items: readonly ScheduleItem[]) {
  const rows = items.map((it) => ({ weekday: it.weekday, startMin: hhmmToMin(it.start), endMin: hhmmToMin(it.end) }));
  if (rows.some((r) => r.startMin >= r.endMin)) throw new HttpError(400, '排班时段非法：结束须晚于开始');
  rows.sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].weekday === rows[i - 1].weekday && rows[i].startMin < rows[i - 1].endMin) {
      throw new HttpError(400, '排班时段重叠');
    }
  }
  return rows;
}

export async function setSchedule(db: DbOrTx, teacherId: number, items: readonly ScheduleItem[]): Promise<void> {
  const rows = parseSchedule(items);
  await db.transaction(async (tx) => {
    // 与预约（FOR SHARE）互斥，避免预约读到半新半旧的排班
    await lockTeacher(tx, teacherId);
    await tx.delete(schedules).where(eq(schedules.teacherId, teacherId));
    if (rows.length > 0) await tx.insert(schedules).values(rows.map((r) => ({ teacherId, ...r })));
  });
}

export async function getSchedule(db: DbOrTx, teacherId: number): Promise<ScheduleItem[]> {
  const rows = await db
    .select({ weekday: schedules.weekday, startMin: schedules.startMin, endMin: schedules.endMin })
    .from(schedules)
    .where(eq(schedules.teacherId, teacherId))
    .orderBy(asc(schedules.weekday), asc(schedules.startMin));
  return rows.map((r) => ({ weekday: r.weekday, start: minToHhmm(r.startMin), end: minToHhmm(r.endMin) }));
}
