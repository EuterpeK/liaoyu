import { afterEach, describe, expect, test, vi } from 'vitest';
import { createAdmin, listAdmins, resetAdminPassword, updateAdmin } from './admins.ts';

afterEach(() => vi.unstubAllGlobals());

const stub = (body: unknown = {}) =>
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
const call = () => (fetch as ReturnType<typeof vi.fn>).mock.calls[0];

describe('admins api', () => {
  test('列表 GET /admins', async () => {
    stub([]);
    await listAdmins();
    expect(call()[0]).toBe('/api/admin/admins');
  });

  test('新建 POST，body 含用户名/密码/角色', async () => {
    stub();
    await createAdmin({ username: 'ops1', password: 'password-123', role: 'ops' });
    expect(call()[0]).toBe('/api/admin/admins');
    expect(call()[1].method).toBe('POST');
    expect(JSON.parse(call()[1].body)).toEqual({ username: 'ops1', password: 'password-123', role: 'ops' });
  });

  test('更新 PATCH：停用与改角色', async () => {
    stub();
    await updateAdmin(2, { disabled: true });
    expect(call()[0]).toBe('/api/admin/admins/2');
    expect(call()[1].method).toBe('PATCH');
    expect(call()[1].body).toBe('{"disabled":true}');
    stub();
    await updateAdmin(2, { role: 'finance' });
    expect(call()[1].body).toBe('{"role":"finance"}');
  });

  test('重置密码 POST', async () => {
    stub();
    await resetAdminPassword(2, 'new-password-456');
    expect(call()[0]).toBe('/api/admin/admins/2/reset-password');
    expect(call()[1].body).toBe('{"password":"new-password-456"}');
  });
});
