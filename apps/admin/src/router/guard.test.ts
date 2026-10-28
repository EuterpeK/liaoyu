import { describe, expect, test } from 'vitest';
import { decide } from './guard.ts';

const route = (o: Partial<Parameters<typeof decide>[0]> & { path: string }) => ({
  fullPath: o.path,
  roles: undefined,
  public: false,
  ...o,
});

describe('路由守卫决策', () => {
  test('未登录访问受保护页 → 登录页并带 redirect', () => {
    expect(decide(route({ path: '/orders', fullPath: '/orders?x=1' }), null)).toEqual({
      path: '/login',
      query: { redirect: '/orders?x=1' },
    });
  });
  test('已登录访问登录页 → 首页；未登录访问登录页放行', () => {
    expect(decide(route({ path: '/login', public: true }), 'ops')).toEqual({ path: '/overview' });
    expect(decide(route({ path: '/login', public: true }), null)).toBe(true);
  });
  test('角色不足 → /403；足够或 super → 放行', () => {
    expect(decide(route({ path: '/audit', roles: [] }), 'ops')).toEqual({ path: '/403' });
    expect(decide(route({ path: '/audit', roles: [] }), 'super')).toBe(true);
    expect(decide(route({ path: '/settlements', roles: ['finance'] }), 'finance')).toBe(true);
    expect(decide(route({ path: '/settlements', roles: ['finance'] }), 'ops')).toEqual({ path: '/403' });
    expect(decide(route({ path: '/orders' }), 'finance')).toBe(true);
  });
  test('公开页（/403）对任何人放行', () => {
    expect(decide(route({ path: '/403', public: true }), null)).toBe(true);
  });
});
