import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { pgError } from '../../tests/db-utils.ts';
import { buyAndPay, insertPackage, insertTeacher, insertUser, setup } from '../../tests/helpers.ts';
import { appointments, leaves, replyWaits, schedules } from './schema.ts';

async function world() {
  const ctx = await setup();
  const teacherId = await insertTeacher(ctx.db, 't');
  const userId = await insertUser(ctx.db, 'u');
  const rel = await buyAndPay(ctx, userId, await insertPackage(ctx.db, teacherId));
  return { db: ctx.db, teacherId, userId, relationId: rel.id };
}

const at = (iso: string) => new Date(iso);

describe('第二阶段数据库约束', () => {
  test('迁移后包含第二阶段全部表', async () => {
    const { db } = await world();
    const { rows } = await db.$client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    const names = rows.map((r) => r.tablename);
    for (const t of [
      'notifications',
      'schedules',
      'appointments',
      'leaves',
      'substitute_candidates',
      'leave_choices',
      'crisis_events',
      'risk_events',
      'reply_waits',
    ]) {
      expect(names).toContain(t);
    }
  });

  test('同一老师的有效预约时段不得重叠；相邻可以；取消后可再约', async () => {
    const w = await world();
    const appt = (startAt: string, endAt: string) =>
      w.db
        .insert(appointments)
        .values({
          relationId: w.relationId,
          userId: w.userId,
          teacherId: w.teacherId,
          date: '2026-11-02',
          startAt: at(startAt),
          endAt: at(endAt),
        })
        .returning({ id: appointments.id });
    const [a] = await appt('2026-11-02T02:00:00Z', '2026-11-02T03:00:00Z');
    expect((await pgError(appt('2026-11-02T02:30:00Z', '2026-11-02T03:30:00Z'))).constraint).toBe(
      'appointments_teacher_no_overlap',
    );
    await appt('2026-11-02T03:00:00Z', '2026-11-02T04:00:00Z');
    await w.db.update(appointments).set({ status: 'cancelled' }).where(eq(appointments.id, a.id));
    await appt('2026-11-02T02:00:00Z', '2026-11-02T03:00:00Z');
  });

  test('同一老师请假日期不得重叠（首尾同日也算）', async () => {
    const w = await world();
    const leave = (startDate: string, endDate: string) =>
      w.db.insert(leaves).values({ teacherId: w.teacherId, startDate, endDate });
    await leave('2026-11-10', '2026-11-14');
    expect((await pgError(leave('2026-11-14', '2026-11-16'))).constraint).toBe('leaves_no_overlap');
    await leave('2026-11-15', '2026-11-16');
  });

  test('同一老师同一天排班时段不得重叠，相邻可以', async () => {
    const w = await world();
    const slot = (weekday: number, startMin: number, endMin: number) =>
      w.db.insert(schedules).values({ teacherId: w.teacherId, weekday, startMin, endMin });
    await slot(1, 540, 660);
    await slot(1, 660, 720);
    await slot(2, 600, 700);
    expect((await pgError(slot(1, 600, 700))).constraint).toBe('schedules_no_overlap');
    expect((await pgError(slot(7, 0, 60))).constraint).toBe('schedule_weekday');
  });

  test('同一对师生同时只能有一条未回复的计时', async () => {
    const w = await world();
    const wait = () =>
      w.db.insert(replyWaits).values({
        teacherId: w.teacherId,
        userId: w.userId,
        relationId: w.relationId,
        replyHours: 12,
        askedAt: at('2026-11-01T04:00:00Z'),
      });
    await wait();
    expect((await pgError(wait())).constraint).toBe('reply_waits_open_uq');
    await w.db.update(replyWaits).set({ repliedAt: at('2026-11-01T05:00:00Z') });
    await wait();
  });
});
