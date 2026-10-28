import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, configureHttp, request } from './http.ts';

const hooks = { onUnauthorized: vi.fn(), onForbidden: vi.fn(), onError: vi.fn() };
configureHttp(hooks);
const reply = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('request', () => {
  test('成功返回 JSON；POST 自动带 JSON 头；query 忽略空值', async () => {
    reply(200, { ok: 1 });
    expect(await request('/x', { method: 'POST', body: { a: 1 } })).toEqual({ ok: 1 });
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/admin/x');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.body).toBe('{"a":1}');

    reply(200, []);
    await request('/orders', { query: { status: 'paid', userId: undefined, from: '', limit: 20 } });
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/api/admin/orders?status=paid&limit=20');
  });

  test('401 触发 onUnauthorized 并抛错；登录接口的 401 只抛错', async () => {
    reply(401, { error: '未登录' });
    await expect(request('/orders')).rejects.toBeInstanceOf(ApiError);
    expect(hooks.onUnauthorized).toHaveBeenCalledOnce();

    reply(401, { error: '账号或密码错误' });
    await expect(request('/login', { method: 'POST', body: {}, silent: true })).rejects.toThrow('账号或密码错误');
    expect(hooks.onUnauthorized).toHaveBeenCalledOnce();
    expect(hooks.onError).not.toHaveBeenCalled();
  });

  test('403 触发 onForbidden；其他错误取后端 error 字段并触发 onError；silent 不触发', async () => {
    reply(403, { error: '无权限' });
    await expect(request('/x')).rejects.toMatchObject({ status: 403 });
    expect(hooks.onForbidden).toHaveBeenCalledOnce();

    reply(409, { error: '用户名已存在' });
    await expect(request('/x')).rejects.toThrow('用户名已存在');
    expect(hooks.onError).toHaveBeenCalledWith('用户名已存在');

    hooks.onError.mockClear();
    reply(500, { error: '服务器错误' });
    await expect(request('/x', { silent: true })).rejects.toThrow('服务器错误');
    expect(hooks.onError).not.toHaveBeenCalled();
  });

  test('响应体不是 JSON 时给出兜底文案', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 502 })));
    await expect(request('/x')).rejects.toThrow('请求失败');
  });
});
