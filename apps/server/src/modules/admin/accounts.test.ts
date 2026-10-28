import { describe, expect, test } from 'vitest';
import { adminCookie, call, setup } from '../../../tests/helpers.ts';
import { auditLogs } from '../../db/schema.ts';

async function world() {
  const ctx = await setup();
  const cookie = await adminCookie(ctx, 'boss', 'password-123', 'super');
  const api = (method: 'GET' | 'POST' | 'PATCH', url: string, body?: object, c = cookie) =>
    call(ctx, method, `/api/admin/admins${url}`, { cookie: c, body });
  return { ctx, cookie, api };
}

describe('管理员账号管理', () => {
  test('新建、列表（不含密码哈希）、重名 409、弱密码 400', async () => {
    const w = await world();
    const created = await w.api('POST', '', { username: 'ops1', password: 'password-123', role: 'ops' });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ username: 'ops1', role: 'ops' });
    expect((await w.api('POST', '', { username: 'ops1', password: 'password-123', role: 'ops' })).statusCode).toBe(409);
    expect((await w.api('POST', '', { username: 'xx', password: 'short', role: 'ops' })).statusCode).toBe(400);
    const list = (await w.api('GET', '')).json();
    expect(list.map((a: { username: string }) => a.username).sort()).toEqual(['boss', 'ops1']);
    expect(JSON.stringify(list)).not.toMatch(/passwordHash|argon2/);
  });

  test('改角色；停用后会话失效、启用后可再登录；重置密码清会话', async () => {
    const w = await world();
    const id = (await w.api('POST', '', { username: 'fin', password: 'password-123', role: 'finance' })).json().id;
    const finCookie = await adminCookie(w.ctx, 'fin', 'password-123', 'finance');
    expect((await w.api('PATCH', `/${id}`, { role: 'ops' })).json().role).toBe('ops');

    await w.api('PATCH', `/${id}`, { disabled: true });
    expect((await call(w.ctx, 'GET', '/api/admin/me', { cookie: finCookie })).statusCode).toBe(401);
    await w.api('PATCH', `/${id}`, { disabled: false });
    const relogin = await call(w.ctx, 'POST', '/api/admin/login', {
      body: { username: 'fin', password: 'password-123' },
    });
    expect(relogin.statusCode).toBe(200);

    const cookie2 = `ly_admin=${relogin.cookies[0].value}`;
    expect((await w.api('POST', `/${id}/reset-password`, { password: 'new-password-456' })).statusCode).toBe(200);
    expect((await call(w.ctx, 'GET', '/api/admin/me', { cookie: cookie2 })).statusCode).toBe(401);
    const login = await call(w.ctx, 'POST', '/api/admin/login', {
      body: { username: 'fin', password: 'new-password-456' },
    });
    expect(login.statusCode).toBe(200);
  });

  test('护栏：不能停用/降级自己；不能让系统没有启用的 super', async () => {
    const w = await world();
    const me = (await call(w.ctx, 'GET', '/api/admin/me', { cookie: w.cookie })).json();
    expect((await w.api('PATCH', `/${me.id}`, { disabled: true })).statusCode).toBe(400);
    expect((await w.api('PATCH', `/${me.id}`, { role: 'ops' })).statusCode).toBe(400);

    const id2 = (await w.api('POST', '', { username: 'boss2', password: 'password-123', role: 'super' })).json().id;
    const c2 = await adminCookie(w.ctx, 'boss2', 'password-123', 'super');
    expect((await w.api('PATCH', `/${me.id}`, { role: 'ops' }, c2)).statusCode).toBe(200);
    // boss2 现在是唯一启用的 super，自己不能动
    expect((await w.api('PATCH', `/${id2}`, { disabled: true }, c2)).statusCode).toBe(400);
  });

  test('操作写审计且不含密码；非 super 403', async () => {
    const w = await world();
    const id = (await w.api('POST', '', { username: 'opsx', password: 'password-123', role: 'ops' })).json().id;
    await w.api('PATCH', `/${id}`, { role: 'finance' });
    await w.api('POST', `/${id}/reset-password`, { password: 'new-password-456' });
    const logs = await w.ctx.db.select().from(auditLogs);
    expect(logs.map((l) => l.action)).toEqual(
      expect.arrayContaining(['admin.create', 'admin.update', 'admin.reset_password']),
    );
    expect(JSON.stringify(logs)).not.toMatch(/password-123|new-password-456/);
    const opsCookie = await adminCookie(w.ctx, 'opsx', 'new-password-456', 'ops');
    expect((await w.api('GET', '', undefined, opsCookie)).statusCode).toBe(403);
  });
});
