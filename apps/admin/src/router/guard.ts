import { canEnter } from '../permissions.ts';
import type { Role } from '../types.ts';

export interface RouteInfo {
  path: string;
  fullPath: string;
  roles: readonly Role[] | undefined;
  public: boolean;
}

export type Decision = true | { path: string; query?: Record<string, string> };

export function decide(to: RouteInfo, role: Role | null): Decision {
  if (to.path === '/login') return role ? { path: '/overview' } : true;
  if (to.public) return true;
  if (!role) return { path: '/login', query: { redirect: to.fullPath } };
  return canEnter(to.roles, role) ? true : { path: '/403' };
}
