import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import {
  buyAndPay,
  call,
  insertPackage,
  insertTeacher,
  insertUser,
  loginUser,
  makeTeacherProfile,
  setup,
} from '../../../tests/helpers.ts';
import type { Config } from '../../config.ts';
import { orders, serviceRelations } from '../../db/schema.ts';
import { zpaySign } from '../../providers/payment/zpay.ts';

const ZPAY = { pid: 'p1', key: 'k1', gateway: 'https://z-pay.cn' };

async function world(config?: Partial<Config>) {
  const ctx = await setup({ config });
  const teacher = await insertTeacher(ctx.db, 't');
  const pkg = await insertPackage(ctx.db, teacher, { priceCents: 3000 });
  const { token } = await loginUser(ctx, 'u1');
  const createOrder = () => call(ctx, 'POST', '/api/orders', { token, body: { packageId: pkg } });
  return { ctx, teacher, pkg, token, createOrder };
}

describe('订单、支付回调与我的服务接口', () => {
  test('MOCK：下单 → 模拟确认 → 订单已付 → 我的服务出现', async () => {
    const w = await world();
    const created = await w.createOrder();
    expect(created.statusCode).toBe(201);
    const { outTradeNo, payUrl, ...rest } = created.json();
    expect(rest).toEqual({ amountCents: 3000, mock: true });
    expect(payUrl).toBe(`http://test.local/api/pay/mock?out_trade_no=${outTradeNo}`);

    const status = async () => (await call(w.ctx, 'GET', `/api/orders/${outTradeNo}`, { token: w.token })).json();
    expect((await status()).paid).toBe(false);

    const page = await call(w.ctx, 'GET', '/api/pay/mock', { query: { out_trade_no: outTradeNo } });
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.body).toContain('30.00');
    const confirm = await call(w.ctx, 'POST', '/api/pay/mock/confirm', { query: { out_trade_no: outTradeNo } });
    expect(confirm.statusCode).toBe(200);
    expect((await status()).paid).toBe(true);

    const rels = (await call(w.ctx, 'GET', '/api/relations', { token: w.token })).json();
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({ teacherId: w.teacher, teacherName: `老师${w.teacher}`, status: 'active' });
  });

  test('他人订单不可查', async () => {
    const w = await world();
    const { outTradeNo } = (await w.createOrder()).json();
    const other = await loginUser(w.ctx, 'u2');
    expect((await call(w.ctx, 'GET', `/api/orders/${outTradeNo}`, { token: other.token })).statusCode).toBe(404);
  });

  test('真实模式：返回 ZPAY 收银台链接，mock 接口不可用', async () => {
    const w = await world({ zpay: ZPAY });
    const { outTradeNo, payUrl, mock } = (await w.createOrder()).json();
    expect(mock).toBe(false);
    expect(payUrl.startsWith('https://z-pay.cn/submit.php?')).toBe(true);
    expect(new URL(payUrl).searchParams.get('notify_url')).toBe('http://test.local/api/pay/zpay/notify');
    expect((await call(w.ctx, 'GET', '/api/pay/mock', { query: { out_trade_no: outTradeNo } })).statusCode).toBe(404);
    expect(
      (await call(w.ctx, 'POST', '/api/pay/mock/confirm', { query: { out_trade_no: outTradeNo } })).statusCode,
    ).toBe(404);
  });

  test('notify：验签失败/金额不符 → fail；正确 → success 并只履约一次；非成功状态 → success', async () => {
    const w = await world({ zpay: ZPAY });
    const { outTradeNo } = (await w.createOrder()).json();
    const signed = (p: Record<string, string>) => ({ ...p, sign: zpaySign(p, 'k1'), sign_type: 'MD5' });
    const base = { pid: 'p1', trade_no: 'Z1', out_trade_no: outTradeNo, type: 'alipay', name: '包月陪伴' };
    const notify = async (query: Record<string, string>) =>
      (await call(w.ctx, 'GET', '/api/pay/zpay/notify', { query })).body;

    expect(await notify(signed({ ...base, money: '30.00', trade_status: 'WAIT_BUYER_PAY' }))).toBe('success');
    expect(
      await notify({ ...signed({ ...base, money: '30.00', trade_status: 'TRADE_SUCCESS' }), sign: 'x'.repeat(32) }),
    ).toBe('fail');
    expect(await notify(signed({ ...base, money: '0.01', trade_status: 'TRADE_SUCCESS' }))).toBe('fail');
    const [pending] = await w.ctx.db.select().from(orders).where(eq(orders.outTradeNo, outTradeNo));
    expect(pending.status).toBe('pending');

    const ok = signed({ ...base, money: '30.00', trade_status: 'TRADE_SUCCESS' });
    expect(await notify(ok)).toBe('success');
    expect(await notify(ok)).toBe('success');
    const [paid] = await w.ctx.db.select().from(orders).where(eq(orders.outTradeNo, outTradeNo));
    expect(paid).toMatchObject({ status: 'paid', tradeNo: 'Z1' });
    expect(await w.ctx.db.$count(serviceRelations)).toBe(1);
  });

  test('老师查看名下学员；非老师 403', async () => {
    const ctx = await setup();
    const t = await loginUser(ctx, 'teacher-login');
    await makeTeacherProfile(ctx.db, t.userId);
    const u = await insertUser(ctx.db, 'u');
    await buyAndPay(ctx, u, await insertPackage(ctx.db, t.userId));

    const res = await call(ctx, 'GET', '/api/teacher/students', { token: t.token });
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0]).toMatchObject({ userId: u, userNickname: '' });

    const nobody = await loginUser(ctx, 'nobody');
    expect((await call(ctx, 'GET', '/api/teacher/students', { token: nobody.token })).statusCode).toBe(403);
  });

  test('我的订单：只返回本人订单，含老师名与套餐名，需登录', async () => {
    const w = await world();
    await w.createOrder();
    const other = await loginUser(w.ctx, 'u2');
    await call(w.ctx, 'POST', '/api/orders', { token: other.token, body: { packageId: w.pkg } });

    expect((await call(w.ctx, 'GET', '/api/orders')).statusCode).toBe(401);
    const mine = (await call(w.ctx, 'GET', '/api/orders', { token: w.token })).json();
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      teacherId: w.teacher,
      teacherName: `老师${w.teacher}`,
      packageTitle: '包月陪伴',
      packageType: 'month',
      amountCents: 3000,
      status: 'pending',
    });
  });
});
