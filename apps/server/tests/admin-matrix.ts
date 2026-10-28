import type { AdminRole } from '../src/db/schema.ts';

export interface MatrixRow {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  url: string;
  roles: AdminRole[];
}

/** 服务端角色归属的唯一事实来源（测试侧）。键 = 前端 permissions.ts 的动作 id */
export const MATRIX: Record<string, MatrixRow> = {
  'orders.view': { method: 'GET', url: '/api/admin/orders', roles: ['super', 'ops', 'finance'] },
  'orders.export': { method: 'GET', url: '/api/admin/orders.csv', roles: ['super', 'finance'] },
  'teacher.view': { method: 'GET', url: '/api/admin/teachers', roles: ['super', 'ops'] },
  'teacher.review': { method: 'POST', url: '/api/admin/teachers/1/review', roles: ['super', 'ops'] },
  'commission.view': { method: 'GET', url: '/api/admin/settings/commission-bps', roles: ['super', 'finance'] },
  'commission.edit': { method: 'PUT', url: '/api/admin/settings/commission-bps', roles: ['super'] },
  'settlement.view': { method: 'GET', url: '/api/admin/settlements', roles: ['super', 'finance'] },
  'settlement.generate': { method: 'POST', url: '/api/admin/settlements/generate', roles: ['super', 'finance'] },
  'settlement.pay': { method: 'POST', url: '/api/admin/settlements/1/pay', roles: ['super', 'finance'] },
  'audit.view': { method: 'GET', url: '/api/admin/audit-logs', roles: ['super'] },
};
