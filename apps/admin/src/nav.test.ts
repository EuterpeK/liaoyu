import { describe, expect, test } from 'vitest';
import { menuFor, NAV } from './nav.ts';

describe('菜单按角色过滤', () => {
  test.each([
    ['super', ['overview', 'teachers', 'orders', 'settlements', 'audit', 'admins']],
    ['ops', ['overview', 'teachers', 'orders']],
    ['finance', ['overview', 'orders', 'settlements']],
  ] as const)('%s', (role, names) => {
    expect(menuFor(role).map((m) => m.name)).toEqual(names);
  });

  test('未登录没有菜单；路径唯一', () => {
    expect(menuFor(null)).toEqual([]);
    expect(new Set(NAV.map((n) => n.path)).size).toBe(NAV.length);
  });
});
