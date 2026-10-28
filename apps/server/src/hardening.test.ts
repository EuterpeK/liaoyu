import { describe, expect, test } from 'vitest';
import { call, setup } from '../tests/helpers.ts';
import { upsertAdmin } from './modules/admin/service.ts';

describe('安全加固', () => {
  test('响应带基础安全头', async () => {
    const ctx = await setup();
    const health = await call(ctx, 'GET', '/api/health');
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    expect(health.headers['x-frame-options']).toBe('DENY');
    expect(health.headers['referrer-policy']).toBe('no-referrer');
    expect(health.headers['strict-transport-security']).toBeUndefined();
  });

  test('COOKIE_SECURE 开启时下发 HSTS', async () => {
    const ctx = await setup({ config: { cookieSecure: true } });
    const res = await call(ctx, 'GET', '/api/health');
    expect(String(res.headers['strict-transport-security'])).toContain('max-age=');
  });

  test('wxlogin 按 IP 限流：第 31 次起 429 并带 Retry-After', async () => {
    const ctx = await setup();
    for (let i = 0; i < 30; i++) {
      expect((await call(ctx, 'POST', '/api/auth/wxlogin', { body: { code: `c${i}` } })).statusCode).toBe(200);
    }
    const res = await call(ctx, 'POST', '/api/auth/wxlogin', { body: { code: 'c-over' } });
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  test('管理员登录：同一账号连续 5 次失败后锁定，即使密码正确也 429', async () => {
    const ctx = await setup();
    await upsertAdmin(ctx.db, 'boss', 'password-123');
    const login = (password: string) => call(ctx, 'POST', '/api/admin/login', { body: { username: 'boss', password } });
    for (let i = 0; i < 5; i++) expect((await login('wrong')).statusCode).toBe(401);
    expect((await login('password-123')).statusCode).toBe(429);
  });

  test('管理员登录：成功后清零失败计数', async () => {
    const ctx = await setup();
    await upsertAdmin(ctx.db, 'boss', 'password-123');
    const login = (password: string) => call(ctx, 'POST', '/api/admin/login', { body: { username: 'boss', password } });
    for (let i = 0; i < 4; i++) await login('wrong');
    expect((await login('password-123')).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login('wrong')).statusCode).toBe(401);
  });

  test('生产环境即使 payment 为 mock 也不开放模拟收银台', async () => {
    const ctx = await setup({ config: { nodeEnv: 'production' } });
    expect(ctx.deps.payment.isMock).toBe(true);
    const res = await call(ctx, 'POST', '/api/pay/mock/confirm', { query: { out_trade_no: 'x' } });
    expect(res.statusCode).toBe(404);
  });
});
