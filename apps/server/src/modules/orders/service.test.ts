import { asc } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { insertPackage, insertTeacher, insertUser, setup } from '../../../tests/helpers.ts';
import { orders, serviceRelations } from '../../db/schema.ts';
import { loadSegments } from '../relations/service.ts';
import { createOrder, fulfillOrder } from './service.ts';

async function world() {
  const ctx = await setup();
  const teacher = await insertTeacher(ctx.db, 't');
  const user = await insertUser(ctx.db, 'u');
  const month = await insertPackage(ctx.db, teacher, { priceCents: 3000 });
  const single = await insertPackage(ctx.db, teacher, { type: 'single', days: 0, callQuota: 1, priceCents: 500 });
  const order = (packageId: number, userId = user) =>
    createOrder(ctx.db, ctx.clock, { userId, packageId, provider: 'zpay' });
  const pay = (outTradeNo: string, paidCents: number) =>
    fulfillOrder(ctx.db, ctx.clock, outTradeNo, { tradeNo: 'T1', paidCents });
  const relations = () => ctx.db.select().from(serviceRelations).orderBy(asc(serviceRelations.startDate));
  return { ctx, db: ctx.db, teacher, user, month, single, order, pay, relations };
}

describe('下单与履约', () => {
  test('创建订单保存快照与金额', async () => {
    const w = await world();
    const o = await w.order(w.month);
    expect(o.status).toBe('pending');
    expect(o.amountCents).toBe(3000);
    expect(o.teacherId).toBe(w.teacher);
    expect(o.packageSnapshot.type).toBe('month');
    expect(o.outTradeNo).toMatch(/^20261101120000\d{6}$/);
  });

  test('下架套餐、自己的套餐不能下单', async () => {
    const w = await world();
    const off = await insertPackage(w.db, w.teacher, { onSale: false });
    await expect(w.order(off)).rejects.toThrow(/下架/);
    await expect(w.order(w.month, w.teacher)).rejects.toThrow(/自己/);
  });

  test('履约创建服务关系与初始分段，且幂等', async () => {
    const w = await world();
    const o = await w.order(w.month);
    expect(await w.pay(o.outTradeNo, 3000)).toEqual({ ok: true, fulfilled: true });
    expect(await w.pay(o.outTradeNo, 3000)).toEqual({ ok: true, fulfilled: false });

    const rels = await w.relations();
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({
      startDate: '2026-11-01',
      endDate: '2026-11-30',
      totalDays: 30,
      callsLeft: 4,
      replyHours: 12,
    });
    expect(await loadSegments(w.db, rels[0].id)).toEqual([
      { kind: 'normal', teacherId: w.teacher, startDate: '2026-11-01', endDate: '2026-11-30' },
    ]);
  });

  test('金额不符不履约；订单不存在返回 not_found', async () => {
    const w = await world();
    const o = await w.order(w.month);
    expect(await w.pay(o.outTradeNo, 1)).toEqual({ ok: false, reason: 'amount_mismatch' });
    const [row] = await w.db.select().from(orders);
    expect(row.status).toBe('pending');
    expect(await w.pay('NOPE', 1)).toEqual({ ok: false, reason: 'not_found' });
  });

  test('续费顺接：第二个包月从上一个结束次日开始', async () => {
    const w = await world();
    for (let i = 0; i < 2; i++) {
      const o = await w.order(w.month);
      await w.pay(o.outTradeNo, 3000);
    }
    const rels = await w.relations();
    expect(rels[1]).toMatchObject({ startDate: '2026-12-01', endDate: '2026-12-30' });
  });

  test('单次套餐：有效 30 天、1 次通话、不参与日计提', async () => {
    const w = await world();
    const o = await w.order(w.single);
    await w.pay(o.outTradeNo, 500);
    const [rel] = await w.relations();
    expect(rel).toMatchObject({ totalDays: 0, callsLeft: 1, endDate: '2026-11-30' });
  });

  test('并发重复回调只开通一次', async () => {
    const w = await world();
    const o = await w.order(w.month);
    const rs = await Promise.all([1, 2, 3, 4].map(() => w.pay(o.outTradeNo, 3000)));
    expect(rs.filter((r) => r.ok && r.fulfilled)).toHaveLength(1);
    expect(await w.relations()).toHaveLength(1);
  });

  test('并发续费不会产生重叠的服务期', async () => {
    const w = await world();
    const a = await w.order(w.month);
    const b = await w.order(w.month);
    await Promise.all([w.pay(a.outTradeNo, 3000), w.pay(b.outTradeNo, 3000)]);
    const rels = await w.relations();
    expect(rels.map((r) => [r.startDate, r.endDate])).toEqual([
      ['2026-11-01', '2026-11-30'],
      ['2026-12-01', '2026-12-30'],
    ]);
  });
});
