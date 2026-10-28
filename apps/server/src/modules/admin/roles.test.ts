import { describe, expect, test } from 'vitest';
import { MATRIX } from '../../../tests/admin-matrix.ts';
import { adminCookie, call, setup } from '../../../tests/helpers.ts';
import type { AdminRole } from '../../db/schema.ts';

const ROLES: AdminRole[] = ['super', 'ops', 'finance'];

describe('管理端角色矩阵', () => {
  for (const [action, row] of Object.entries(MATRIX)) {
    test(`${action}: ${row.method} ${row.url}`, async () => {
      const ctx = await setup();
      const body = row.method === 'GET' ? undefined : {};
      expect((await call(ctx, row.method, row.url, { body })).statusCode).toBe(401);
      for (const role of ROLES) {
        const cookie = await adminCookie(ctx, `u-${role}`, 'password-123', role);
        const res = await call(ctx, row.method, row.url, { cookie, body });
        if (row.roles.includes(role)) {
          expect([401, 403], `${role} 应被放行`).not.toContain(res.statusCode);
        } else {
          expect(res.statusCode, `${role} 应被拒绝`).toBe(403);
        }
      }
    });
  }

  test('任何已登录角色都能访问 /me，并返回 role', async () => {
    const ctx = await setup();
    for (const role of ROLES) {
      const cookie = await adminCookie(ctx, `m-${role}`, 'password-123', role);
      const res = await call(ctx, 'GET', '/api/admin/me', { cookie });
      expect(res.json().role).toBe(role);
    }
  });
});
