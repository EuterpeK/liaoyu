import { describe, expect, test } from 'vitest';
import { type Ctx, call, loginUser, makeTeacherProfile, setup } from '../../../tests/helpers.ts';

async function teacher(ctx: Ctx, code: string, level: number) {
  const u = await loginUser(ctx, code);
  await makeTeacherProfile(ctx.db, u.userId, { level });
  return u;
}

const PKG_URL = '/api/teacher/packages';

describe('老师套餐', () => {
  test('非老师不能建套餐', async () => {
    const ctx = await setup();
    const { token } = await loginUser(ctx, 'u1');
    const res = await call(ctx, 'POST', PKG_URL, { token, body: { type: 'month', title: '包月', priceCents: 3000 } });
    expect(res.statusCode).toBe(403);
  });

  test('建包月套餐，天数自动为 30', async () => {
    const ctx = await setup();
    const t = await teacher(ctx, 't1', 2);
    const res = await call(ctx, 'POST', PKG_URL, {
      token: t.token,
      body: { type: 'month', title: '包月', priceCents: 3000, callQuota: 4, replyHours: 12 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ days: 30, callQuota: 4, replyHours: 12, onSale: true });
  });

  test('单次套餐通话次数强制为 1', async () => {
    const ctx = await setup();
    const t = await teacher(ctx, 't1', 1);
    const res = await call(ctx, 'POST', PKG_URL, {
      token: t.token,
      body: { type: 'single', title: '单次', priceCents: 500, callQuota: 9 },
    });
    expect(res.json().callQuota).toBe(1);
  });

  test('年包仅 L3 及以上', async () => {
    const ctx = await setup();
    const low = await teacher(ctx, 't1', 2);
    const high = await teacher(ctx, 't2', 3);
    const body = { type: 'year', title: '包年', priceCents: 300000 };
    expect((await call(ctx, 'POST', PKG_URL, { token: low.token, body })).statusCode).toBe(403);
    expect((await call(ctx, 'POST', PKG_URL, { token: high.token, body })).statusCode).toBe(201);
  });

  test('价格非法返回 400', async () => {
    const ctx = await setup();
    const t = await teacher(ctx, 't1', 2);
    const res = await call(ctx, 'POST', PKG_URL, {
      token: t.token,
      body: { type: 'month', title: '包月', priceCents: 12.5 },
    });
    expect(res.statusCode).toBe(400);
  });

  test('下架自己的套餐；不能改别人的套餐；空修改 400', async () => {
    const ctx = await setup();
    const a = await teacher(ctx, 't1', 2);
    const b = await teacher(ctx, 't2', 2);
    const created = await call(ctx, 'POST', PKG_URL, {
      token: a.token,
      body: { type: 'month', title: '包月', priceCents: 3000 },
    });
    const id = created.json().id;
    const off = await call(ctx, 'PATCH', `${PKG_URL}/${id}`, { token: a.token, body: { onSale: false } });
    expect(off.json().onSale).toBe(false);
    expect((await call(ctx, 'PATCH', `${PKG_URL}/${id}`, { token: b.token, body: { onSale: true } })).statusCode).toBe(
      404,
    );
    expect((await call(ctx, 'PATCH', `${PKG_URL}/${id}`, { token: a.token, body: {} })).statusCode).toBe(400);
    expect((await call(ctx, 'GET', PKG_URL, { token: a.token })).json()).toHaveLength(1);
  });
});
