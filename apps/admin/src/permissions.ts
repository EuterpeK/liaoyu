import type { Role } from './types.ts';

/** 动作 → 允许的角色。键必须与后端 tests/admin-matrix.ts 一致（有漂移测试守护） */
export const ACTIONS = {
  'orders.view': ['super', 'ops', 'finance'],
  'orders.export': ['super', 'finance'],
  'teacher.view': ['super', 'ops'],
  'teacher.review': ['super', 'ops'],
  'commission.view': ['super', 'finance'],
  'commission.edit': ['super'],
  'settlement.view': ['super', 'finance'],
  'settlement.generate': ['super', 'finance'],
  'settlement.pay': ['super', 'finance'],
  'audit.view': ['super'],
  'admins.manage': ['super'],
} as const satisfies Record<string, readonly Role[]>;

export type Action = keyof typeof ACTIONS;

export function can(role: Role | null | undefined, action: Action): boolean {
  if (!role) return false;
  return role === 'super' || (ACTIONS[action] as readonly Role[]).includes(role);
}

/** 路由 meta.roles：未声明 = 任何已登录角色；[] = 仅 super */
export function canEnter(roles: readonly Role[] | undefined, role: Role | null | undefined): boolean {
  if (!role) return false;
  return role === 'super' || !roles || roles.includes(role);
}
