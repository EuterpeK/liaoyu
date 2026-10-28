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
import { auditLogs } from '../../db/schema.ts';
import { createOrder } from './service.ts';

async function world() {
  const ctx = await setup();
  const a = await insertTeacher(ctx.db, 'a');
  const b = await insertTeacher(ctx.db, 'b');
  const u = await insertUser(ctx.db, 'u');
  await buyAndPay(ctx, u, await insertPackage(ctx.db, a, { priceCents: 3000, title: '包月, 情感' }));
  await createOrder(ctx.db, ctx.clock, {
    userId: u,
    packageId: await insertPackage(ctx.db, b, { priceCents: 500 }),
    provider: 'zpay',
  });
  const cookie = await adminCookie(ctx);
  const list = async (query: Record<string, string | number> = {}) =>
    (await call(ctx, 'GET', '/api/admin/orders', { cookie, query })).json();
  return { ctx, a, b, u, cookie, list };
}

describe('管理端订单查询与导出', () => {
  test('订单列表含用户、老师、套餐、金额，可按老师/用户/状态筛选；需管理员登录', async () => {
    const w = await world();
    expect((await call(w.ctx, 'GET', '/api/admin/orders')).statusCode).toBe(401);
    expect(await w.list()).toHaveLength(2);

    const byA = await w.list({ teacherId: w.a });
    expect(byA).toHaveLength(1);
    expect(byA[0]).toMatchObject({
      userId: w.u,
      teacherId: w.a,
      teacherName: `老师${w.a}`,
      packageTitle: '包月, 情感',
      amountCents: 3000,
      status: 'paid',
    });
    expect(await w.list({ userId: w.u })).toHaveLength(2);
    expect(await w.list({ status: 'pending' })).toHaveLength(1);
  });

  test('按北京时间日期筛选（含首尾）', async () => {
    const w = await world();
    expect(await w.list({ from: '2026-11-01', to: '2026-11-01' })).toHaveLength(2);
    expect(await w.list({ from: '2026-11-02' })).toHaveLength(0);
    expect(await w.list({ to: '2026-10-31' })).toHaveLength(0);
    expect(
      (await call(w.ctx, 'GET', '/api/admin/orders', { cookie: w.cookie, query: { from: '11/01' } })).statusCode,
    ).toBe(400);
  });

  test('分页：limit/offset 按 id 倒序切片；limit 超上限返回 400', async () => {
    const w = await world();
    const all = await w.list();
    const first = await w.list({ limit: 1 });
    const second = await w.list({ limit: 1, offset: 1 });
    expect(first.map((o: { outTradeNo: string }) => o.outTradeNo)).toEqual([all[0].outTradeNo]);
    expect(second.map((o: { outTradeNo: string }) => o.outTradeNo)).toEqual([all[1].outTradeNo]);
    expect(await w.list({ limit: 1, offset: 2 })).toHaveLength(0);
    expect(
      (await call(w.ctx, 'GET', '/api/admin/orders', { cookie: w.cookie, query: { limit: 501 } })).statusCode,
    ).toBe(400);
  });

  test('汇总：订单数/已支付数/收入/购买人数，不受分页影响', async () => {
    const w = await world();
    const res = await call(w.ctx, 'GET', '/api/admin/orders/summary', { cookie: w.cookie });
    expect(res.json()).toEqual({ orderCount: 2, paidCount: 1, revenueCents: 3000, buyerCount: 1 });
    expect((await call(w.ctx, 'GET', '/api/admin/orders/summary')).statusCode).toBe(401);
  });

  test('CSV 导出：BOM + 表头 + 北京时间 + 写审计', async () => {
    const w = await world();
    const res = await call(w.ctx, 'GET', '/api/admin/orders.csv', { cookie: w.cookie, query: { status: 'paid' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.body.startsWith('\ufeff')).toBe(true);
    const lines = res.body.slice(1).trimEnd().split('\n');
    expect(lines[0]).toBe('订单号,用户ID,用户昵称,老师ID,老师,套餐,金额(元),状态,支付时间');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/,"包月, 情感",30\.00,paid,2026-11-01 12:00:00$/);

    const logs = await w.ctx.db.select({ action: auditLogs.action }).from(auditLogs);
    expect(logs.map((l) => l.action)).toContain('orders.export');
  });

  test('计数：按同样筛选返回总数，不受分页影响', async () => {
    const w = await world();
    const count = async (query: Record<string, string | number> = {}) =>
      (await call(w.ctx, 'GET', '/api/admin/orders/count', { cookie: w.cookie, query })).json();
    expect(await count()).toEqual({ total: 2 });
    expect(await count({ status: 'paid' })).toEqual({ total: 1 });
    expect(await count({ teacherId: w.a })).toEqual({ total: 1 });
    expect((await call(w.ctx, 'GET', '/api/admin/orders/count')).statusCode).toBe(401);
  });
});
