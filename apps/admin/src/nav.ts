import { canEnter } from './permissions.ts';
import type { Role } from './types.ts';

export interface NavItem {
  name: string;
  path: string;
  title: string;
  /** tdesign-icons-vue-next 图标名（kebab-case） */
  icon: string;
  /** 未声明 = 任何已登录角色；[] = 仅 super（super 恒可进） */
  roles?: readonly Role[];
}

export const NAV: NavItem[] = [
  { name: 'overview', path: '/overview', title: '概览', icon: 'dashboard' },
  { name: 'teachers', path: '/teachers', title: '老师管理', icon: 'user-circle', roles: ['ops'] },
  { name: 'orders', path: '/orders', title: '订单', icon: 'view-list' },
  { name: 'settlements', path: '/settlements', title: '结算', icon: 'money', roles: ['finance'] },
  { name: 'audit', path: '/audit', title: '审计日志', icon: 'history', roles: [] },
  { name: 'admins', path: '/admins', title: '管理员账号', icon: 'secured', roles: [] },
];

export const menuFor = (role: Role | null): NavItem[] => NAV.filter((n) => canEnter(n.roles, role));

export const ROLE_LABEL: Record<Role, string> = { super: '超级管理员', ops: '运营', finance: '财务' };
