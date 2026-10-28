import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { call, setup } from '../tests/helpers.ts';
import { buildApp } from './app.ts';

function fakeDist() {
  const dir = mkdtempSync(join(tmpdir(), 'admin-dist-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>spa</title>');
  writeFileSync(join(dir, 'assets', 'a.js'), 'console.log(1)');
  return dir;
}

async function appWithDist() {
  const ctx = await setup();
  return { app: await buildApp(ctx.deps, { adminDist: fakeDist() }) };
}

describe('管理台静态托管', () => {
  test('/admin 重定向到 /admin/；/admin/ 与深层路由回退 index.html，带严格 CSP 且不缓存', async () => {
    const ctx = await appWithDist();
    expect((await call(ctx, 'GET', '/admin')).statusCode).toBe(302);
    for (const url of ['/admin/', '/admin/orders', '/admin/settlements/1']) {
      const res = await call(ctx, 'GET', url);
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toContain('<title>spa</title>');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-security-policy']).toContain("script-src 'self';");
      expect(res.headers['content-security-policy']).not.toMatch(/script-src[^;]*unsafe-inline/);
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    }
  });

  test('资源文件原样返回且长缓存；缺失的资源 404 而不是回退成 HTML', async () => {
    const ctx = await appWithDist();
    const ok = await call(ctx, 'GET', '/admin/assets/a.js');
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('console.log(1)');
    expect(ok.headers['cache-control']).toContain('immutable');
    expect((await call(ctx, 'GET', '/admin/assets/missing.js')).statusCode).toBe(404);
  });

  test('API 的 404 不受影响，且不带管理台 CSP', async () => {
    const ctx = await appWithDist();
    const res = await call(ctx, 'GET', '/api/nope');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-security-policy']).toBeUndefined();
  });
});
