import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { adminCookie, call, loginUser, setup } from '../../../tests/helpers.ts';
import { buildApp } from '../../app.ts';
import { admins, auditLogs } from '../../db/schema.ts';
import { createDeps } from '../../deps.ts';
import { fixedClock } from '../../lib/clock.ts';
import { ADMIN_COOKIE, upsertAdmin } from './service.ts';

describe('管理员登录', () => {
  test('密码错误返回 401', async () => {
    const ctx = await setup();
    await upsertAdmin(ctx.db, 'boss', 'password-123');
    const res = await call(ctx, 'POST', '/api/admin/login', { body: { username: 'boss', password: 'wrong' } });
    expect(res.statusCode).toBe(401);
  });

  test('登录下发安全 Cookie，凭 Cookie 访问 /me', async () => {
    const ctx = await setup();
    await upsertAdmin(ctx.db, 'boss', 'password-123');
    const login = await call(ctx, 'POST', '/api/admin/login', { body: { username: 'boss', password: 'password-123' } });
    expect(login.statusCode).toBe(200);
    const c = login.cookies.find((x) => x.name === ADMIN_COOKIE);
    expect(c?.httpOnly).toBe(true);
    expect(c?.sameSite).toBe('Strict');
    expect(c?.path).toBe('/api/admin');

    const me = await call(ctx, 'GET', '/api/admin/me', { cookie: `${ADMIN_COOKIE}=${c?.value}` });
    expect(me.json().username).toBe('boss');
  });

  test('用户 token 不能访问管理接口', async () => {
    const ctx = await setup();
    const { token } = await loginUser(ctx, 'u1');
    expect((await call(ctx, 'GET', '/api/admin/me', { token })).statusCode).toBe(401);
  });

  test('登出后会话失效', async () => {
    const ctx = await setup();
    const cookie = await adminCookie(ctx);
    await call(ctx, 'POST', '/api/admin/logout', { cookie });
    expect((await call(ctx, 'GET', '/api/admin/me', { cookie })).statusCode).toBe(401);
  });

  test('会话 12 小时后过期', async () => {
    const ctx = await setup();
    const cookie = await adminCookie(ctx);
    const later = await buildApp(createDeps({ ...ctx.deps, clock: fixedClock('2026-11-01T16:00:01Z') }));
    expect((await call({ app: later }, 'GET', '/api/admin/me', { cookie })).statusCode).toBe(401);
  });

  test('登录写审计日志', async () => {
    const ctx = await setup();
    await adminCookie(ctx);
    const logs = await ctx.db.select().from(auditLogs);
    expect(logs.map((l) => l.action)).toEqual(['admin.login']);
  });

  test('审计日志按时间倒序返回，未登录 401', async () => {
    const ctx = await setup();
    expect((await call(ctx, 'GET', '/api/admin/audit-logs')).statusCode).toBe(401);
    const cookie = await adminCookie(ctx);
    await adminCookie(ctx); // 第二次登录再产生一条
    const res = await call(ctx, 'GET', '/api/admin/audit-logs', { cookie });
    expect(res.statusCode).toBe(200);
    const logs = res.json();
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs[0].action).toBe('admin.login');
    expect(new Date(logs[0].createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(logs[logs.length - 1].createdAt).getTime(),
    );
  });
});

describe('管理员角色', () => {
  test('默认 super，可指定角色；login 返回 role', async () => {
    const ctx = await setup();
    await upsertAdmin(ctx.db, 'boss', 'password-123');
    await upsertAdmin(ctx.db, 'fin', 'password-123', 'finance');
    const rows = await ctx.db.select().from(admins);
    expect(Object.fromEntries(rows.map((r) => [r.username, r.role]))).toEqual({ boss: 'super', fin: 'finance' });
    const login = await call(ctx, 'POST', '/api/admin/login', { body: { username: 'fin', password: 'password-123' } });
    expect(login.json()).toMatchObject({ username: 'fin', role: 'finance' });
  });

  test('停用账号：不能登录，已有会话立即失效', async () => {
    const ctx = await setup();
    const cookie = await adminCookie(ctx, 'ops1', 'password-123', 'ops');
    expect((await call(ctx, 'GET', '/api/admin/me', { cookie })).statusCode).toBe(200);
    await ctx.db.update(admins).set({ disabledAt: new Date() }).where(eq(admins.username, 'ops1'));
    expect((await call(ctx, 'GET', '/api/admin/me', { cookie })).statusCode).toBe(401);
    const res = await call(ctx, 'POST', '/api/admin/login', { body: { username: 'ops1', password: 'password-123' } });
    expect(res.statusCode).toBe(401);
  });
});
