import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { call, setup } from '../tests/helpers.ts';
import { HttpError } from './lib/errors.ts';

describe('应用骨架', () => {
  test('GET /api/health', async () => {
    const ctx = await setup();
    const res = await call(ctx, 'GET', '/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  test('HttpError 返回对应状态码', async () => {
    const ctx = await setup();
    ctx.app.get('/t/teapot', async () => {
      throw new HttpError(418, '茶壶');
    });
    const res = await call(ctx, 'GET', '/t/teapot');
    expect(res.statusCode).toBe(418);
    expect(res.json()).toEqual({ error: '茶壶' });
  });

  test('Zod 校验失败返回 400', async () => {
    const ctx = await setup();
    ctx.app.post('/t/echo', { schema: { body: z.object({ n: z.number().int() }) } }, async (req) => ({
      n: req.body.n,
    }));
    expect((await call(ctx, 'POST', '/t/echo', { body: { n: 1.5 } })).statusCode).toBe(400);
    expect((await call(ctx, 'POST', '/t/echo', { body: { n: 2 } })).json()).toEqual({ n: 2 });
  });

  test('未知异常返回 500 且不泄露细节', async () => {
    const ctx = await setup();
    ctx.app.get('/t/boom', async () => {
      throw new Error('secret detail');
    });
    const res = await call(ctx, 'GET', '/t/boom');
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: '服务器错误' });
  });

  test('非生产环境暴露 OpenAPI', async () => {
    const ctx = await setup();
    const res = await call(ctx, 'GET', '/api/openapi.json');
    expect(res.json().paths).toHaveProperty('/api/health');
  });
});
