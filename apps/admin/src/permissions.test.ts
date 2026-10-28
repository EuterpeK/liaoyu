import { describe, expect, test } from 'vitest';
import { ACTIONS, type Action, can, canEnter } from './permissions.ts';

describe('permissions', () => {
  test('super 拥有全部动作', () => {
    for (const a of Object.keys(ACTIONS)) expect(can('super', a as Action)).toBe(true);
  });
  test('ops/finance 的边界', () => {
    expect(can('ops', 'teacher.review')).toBe(true);
    expect(can('ops', 'orders.export')).toBe(false);
    expect(can('finance', 'settlement.pay')).toBe(true);
    expect(can('finance', 'commission.edit')).toBe(false);
    expect(can('finance', 'teacher.review')).toBe(false);
    expect(can(null, 'orders.view')).toBe(false);
  });
  test('canEnter：未声明 roles 表示任何已登录角色；super 恒可进', () => {
    expect(canEnter(undefined, 'ops')).toBe(true);
    expect(canEnter(['finance'], 'ops')).toBe(false);
    expect(canEnter(['finance'], 'super')).toBe(true);
    expect(canEnter([], 'ops')).toBe(false);
    expect(canEnter(undefined, null)).toBe(false);
  });
});
