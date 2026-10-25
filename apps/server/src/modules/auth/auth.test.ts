import { describe, expect, test } from 'vitest';
import { call, loginUser, setup } from '../../../tests/helpers.ts';
import { buildApp } from '../../app.ts';
import { createDeps } from '../../deps.ts';
import { fixedClock } from '../../lib/clock.ts';

describe('微信登录与用户鉴权', () => {
  test('同一 code 登录得到同一用户（MOCK）', async () => {
    const ctx = await setup();
    const a = await loginUser(ctx, 'code-1');
    const b = await loginUser(ctx, 'code-1');
    expect(a.token).toBeTruthy();
    expect(a.userId).toBe(b.userId);
  });

  test('缺少 code 返回 400', async () => {
    const ctx = await setup();
    expect((await call(ctx, 'POST', '/api/auth/wxlogin', { body: {} })).statusCode).toBe(400);
  });

  test('/me 需要登录，返回用户与老师身份', async () => {
    const ctx = await setup();
    expect((await call(ctx, 'GET', '/api/auth/me')).statusCode).toBe(401);
    const { token, userId } = await loginUser(ctx, 'code-1');
    const res = await call(ctx, 'GET', '/api/auth/me', { token });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(userId);
    expect(res.json().teacher).toBeNull();
  });

  test('篡改或过期的 token 返回 401', async () => {
    const ctx = await setup();
    const { token } = await loginUser(ctx, 'code-1');
    expect((await call(ctx, 'GET', '/api/auth/me', { token: `${token}x` })).statusCode).toBe(401);

    const later = await buildApp(createDeps({ ...ctx.deps, clock: fixedClock('2026-12-02T04:00:00Z') }));
    expect((await call({ app: later }, 'GET', '/api/auth/me', { token })).statusCode).toBe(401);
  });
});
