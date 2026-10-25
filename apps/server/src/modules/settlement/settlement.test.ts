import { asc } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import {
  adminCookie,
  buyAndPay,
  call,
  insertPackage,
  insertTeacher,
  insertUser,
  setup,
} from '../../../tests/helpers.ts';
import { auditLogs, serviceRelations } from '../../db/schema.ts';
import { accrueUpTo } from '../accrual/service.ts';
import { generateSettlements, runWeeklySettlement } from './service.ts';

const WEEK = { periodStart: '2026-11-01', periodEnd: '2026-11-07' };

async function world() {
  const ctx = await setup();
  const teacher = await insertTeacher(ctx.db, 'a');
  const user = await insertUser(ctx.db, 'u');
  await buyAndPay(ctx, user, await insertPackage(ctx.db, teacher, { priceCents: 3000 }));
  await accrueUpTo(ctx.db, '2026-11-08');
  return { ctx, db: ctx.db, teacher };
}

describe('周结算', () => {
  test('默认抽成 20%，重复生成不重复计入', async () => {
    const w = await world();
    const [s] = await generateSettlements(w.db, WEEK);
    expect(s).toMatchObject({
      teacherId: w.teacher,
      grossCents: 700,
      commissionBps: 2000,
      commissionCents: 140,
      netCents: 560,
      status: 'pending',
    });
    expect(await generateSettlements(w.db, WEEK)).toEqual([]);
  });

  test('冻结关系的计提不进入结算', async () => {
    const w = await world();
    await w.db.update(serviceRelations).set({ frozen: true });
    expect(await generateSettlements(w.db, WEEK)).toEqual([]);
  });

  test('并发生成只结算一次', async () => {
    const w = await world();
    const rs = await Promise.all([1, 2, 3].map(() => generateSettlements(w.db, WEEK)));
    expect(rs.flat()).toHaveLength(1);
  });

  test('周任务结算上周一到上周日', async () => {
    const w = await world();
    const [s] = await runWeeklySettlement(w.db, '2026-11-09');
    expect(s).toMatchObject({ periodStart: '2026-11-02', periodEnd: '2026-11-08', grossCents: 700 });
  });

  test('管理接口：改抽成 → 生成 → 列表 → 登记打款 → 重复登记 409，全程审计', async () => {
    const w = await world();
    const cookie = await adminCookie(w.ctx);
    const bpsUrl = '/api/admin/settings/commission-bps';

    expect((await call(w.ctx, 'PUT', bpsUrl, { cookie, body: { bps: 10000 } })).statusCode).toBe(400);
    expect((await call(w.ctx, 'PUT', bpsUrl, { cookie, body: { bps: 3000 } })).statusCode).toBe(200);
    expect((await call(w.ctx, 'GET', bpsUrl, { cookie })).json()).toEqual({ bps: 3000 });

    const gen = await call(w.ctx, 'POST', '/api/admin/settlements/generate', { cookie, body: WEEK });
    expect(gen.statusCode).toBe(201);
    expect(gen.json()[0]).toMatchObject({ commissionBps: 3000, commissionCents: 210, netCents: 490 });

    const list = await call(w.ctx, 'GET', '/api/admin/settlements', { cookie, query: { status: 'pending' } });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].teacherName).toBe(`老师${w.teacher}`);

    const payUrl = `/api/admin/settlements/${gen.json()[0].id}/pay`;
    const paid = await call(w.ctx, 'POST', payUrl, { cookie, body: { proof: '支付宝转账单号 123' } });
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toMatchObject({ status: 'paid', proof: '支付宝转账单号 123' });
    expect((await call(w.ctx, 'POST', payUrl, { cookie, body: { proof: 'x' } })).statusCode).toBe(409);

    const logs = await w.db.select({ action: auditLogs.action }).from(auditLogs).orderBy(asc(auditLogs.id));
    expect(logs.map((l) => l.action)).toEqual([
      'admin.login',
      'settings.commission_bps',
      'settlement.generate',
      'settlement.pay',
    ]);
  });

  test('参数校验：缺少凭证、区间颠倒均返回 400', async () => {
    const w = await world();
    const cookie = await adminCookie(w.ctx);
    const [s] = await generateSettlements(w.db, WEEK);
    expect((await call(w.ctx, 'POST', `/api/admin/settlements/${s.id}/pay`, { cookie, body: {} })).statusCode).toBe(
      400,
    );
    const bad = { periodStart: '2026-11-07', periodEnd: '2026-11-01' };
    expect((await call(w.ctx, 'POST', '/api/admin/settlements/generate', { cookie, body: bad })).statusCode).toBe(400);
  });
});
