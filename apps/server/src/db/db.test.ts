import { describe, expect, test } from 'vitest';
import { pgError, resetDb, testDb } from '../../tests/db-utils.ts';
import { accruals, auditLogs, orders, packages, serviceRelations, serviceSegments, users } from './schema.ts';

async function seedRelation() {
  const db = testDb();
  await resetDb(db);
  const [t] = await db.insert(users).values({ openid: 't' }).returning();
  const [u] = await db.insert(users).values({ openid: 'u' }).returning();
  const [p] = await db
    .insert(packages)
    .values({ teacherId: t.id, type: 'month', title: '包月', priceCents: 3000, days: 30 })
    .returning();
  const [o] = await db
    .insert(orders)
    .values({
      outTradeNo: 'O1',
      userId: u.id,
      teacherId: t.id,
      packageId: p.id,
      packageSnapshot: { type: 'month', title: '包月', priceCents: 3000, days: 30, callQuota: 0, replyHours: 24 },
      amountCents: 3000,
      payProvider: 'zpay',
    })
    .returning();
  const [r] = await db
    .insert(serviceRelations)
    .values({
      orderId: o.id,
      userId: u.id,
      teacherId: t.id,
      packageType: 'month',
      amountCents: 3000,
      totalDays: 30,
      startDate: '2026-11-01',
      endDate: '2026-11-30',
    })
    .returning();
  return { db, teacherId: t.id, relationId: r.id };
}

describe('数据库约束', () => {
  test('迁移后包含全部业务表', async () => {
    const { rows } = await testDb().$client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    const names = rows.map((r) => r.tablename);
    for (const t of [
      'users',
      'admins',
      'admin_sessions',
      'audit_logs',
      'settings',
      'teacher_profiles',
      'packages',
      'orders',
      'service_relations',
      'service_segments',
      'settlements',
      'accruals',
    ]) {
      expect(names).toContain(t);
    }
  });

  test('同一服务关系的分段日期不得重叠', async () => {
    const { db, teacherId, relationId } = await seedRelation();
    const seg = (startDate: string, endDate: string) =>
      db.insert(serviceSegments).values({ relationId, kind: 'normal', teacherId, startDate, endDate });
    await seg('2026-11-01', '2026-11-10');
    expect((await pgError(seg('2026-11-10', '2026-11-15'))).constraint).toBe('service_segments_no_overlap');
    await seg('2026-11-11', '2026-11-15');
  });

  test('暂停分段不能有老师，其他分段必须有老师', async () => {
    const { db, teacherId, relationId } = await seedRelation();
    const base = { relationId, startDate: '2026-11-01', endDate: '2026-11-02' };
    expect((await pgError(db.insert(serviceSegments).values({ ...base, kind: 'paused', teacherId }))).constraint).toBe(
      'segment_teacher',
    );
    expect(
      (await pgError(db.insert(serviceSegments).values({ ...base, kind: 'normal', teacherId: null }))).constraint,
    ).toBe('segment_teacher');
  });

  test('计提按 (relation_id, date) 唯一', async () => {
    const { db, teacherId, relationId } = await seedRelation();
    const row = { relationId, date: '2026-11-01', teacherId, amountCents: 100 };
    await db.insert(accruals).values(row);
    expect((await pgError(db.insert(accruals).values(row))).constraint).toBe('accruals_relation_date_uq');
  });

  test('审计日志只能追加', async () => {
    const db = testDb();
    await resetDb(db);
    await db.insert(auditLogs).values({ action: 'x', target: 'y' });
    expect((await pgError(db.update(auditLogs).set({ action: 'z' }))).message).toMatch(/append-only/);
    expect((await pgError(db.delete(auditLogs))).message).toMatch(/append-only/);
  });

  test('bigint 金额读出为 number，date 读出为字符串', async () => {
    const { db } = await seedRelation();
    const [r] = await db.select().from(serviceRelations);
    expect(r.amountCents).toBe(3000);
    expect(r.startDate).toBe('2026-11-01');
  });
});
