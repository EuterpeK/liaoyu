import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { adminCookie, call, loginUser, setup } from '../../../tests/helpers.ts';
import { auditLogs, teacherProfiles } from '../../db/schema.ts';

const APPLY = {
  displayName: '小林老师',
  realName: '林某',
  intro: '十年情感咨询',
  directions: ['情感'],
  credentials: ['证书A'],
};

describe('老师入驻与审核', () => {
  test('入驻申请 → 待审核，重复申请 409', async () => {
    const ctx = await setup();
    const { token } = await loginUser(ctx, 't1');
    const r1 = await call(ctx, 'POST', '/api/teacher/apply', { token, body: APPLY });
    expect(r1.statusCode).toBe(201);
    expect(r1.json().status).toBe('pending');
    expect((await call(ctx, 'POST', '/api/teacher/apply', { token, body: APPLY })).statusCode).toBe(409);
  });

  test('缺少擅长方向返回 400', async () => {
    const ctx = await setup();
    const { token } = await loginUser(ctx, 't1');
    const res = await call(ctx, 'POST', '/api/teacher/apply', { token, body: { ...APPLY, directions: [] } });
    expect(res.statusCode).toBe(400);
  });

  test('真实姓名加密入库', async () => {
    const ctx = await setup();
    const { token, userId } = await loginUser(ctx, 't1');
    await call(ctx, 'POST', '/api/teacher/apply', { token, body: APPLY });
    const [row] = await ctx.db.select().from(teacherProfiles).where(eq(teacherProfiles.userId, userId));
    expect(row.realNameEnc.startsWith('v1:')).toBe(true);
    expect(row.realNameEnc).not.toContain('林某');
  });

  test('管理员审核通过并定级，写审计日志', async () => {
    const ctx = await setup();
    const { token, userId } = await loginUser(ctx, 't1');
    await call(ctx, 'POST', '/api/teacher/apply', { token, body: APPLY });
    const cookie = await adminCookie(ctx);

    const list = await call(ctx, 'GET', '/api/admin/teachers', { cookie, query: { status: 'pending' } });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].userId).toBe(userId);
    expect(list.json()[0].realName).toBe('林某');
    expect(list.json()[0].realNameEnc).toBeUndefined();

    const url = `/api/admin/teachers/${userId}/review`;
    expect((await call(ctx, 'POST', url, { cookie, body: { approve: true, level: 4 } })).statusCode).toBe(400);
    const ok = await call(ctx, 'POST', url, { cookie, body: { approve: true, level: 3 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'active', level: 3 });
    expect((await call(ctx, 'POST', url, { cookie, body: { approve: true, level: 3 } })).statusCode).toBe(409);

    const me = await call(ctx, 'GET', '/api/auth/me', { token });
    expect(me.json().teacher.status).toBe('active');

    const logs = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, 'teacher.approve'));
    expect(logs).toHaveLength(1);
  });

  test('被拒绝后可重新申请；审核不存在的申请 404', async () => {
    const ctx = await setup();
    const { token, userId } = await loginUser(ctx, 't1');
    await call(ctx, 'POST', '/api/teacher/apply', { token, body: APPLY });
    const cookie = await adminCookie(ctx);
    await call(ctx, 'POST', `/api/admin/teachers/${userId}/review`, { cookie, body: { approve: false } });
    expect((await call(ctx, 'POST', '/api/teacher/apply', { token, body: APPLY })).statusCode).toBe(201);
    expect(
      (await call(ctx, 'POST', '/api/admin/teachers/999/review', { cookie, body: { approve: false } })).statusCode,
    ).toBe(404);
  });
});
