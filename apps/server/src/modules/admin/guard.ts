import type { FastifyRequest } from 'fastify';
import type { AdminRole } from '../../db/schema.ts';
import type { Deps } from '../../deps.ts';
import { HttpError } from '../../lib/errors.ts';
import { ADMIN_COOKIE, resolveSession } from './service.ts';

/** onRequest 钩子：先认证再鉴权，早于参数校验。不传 roles = 任意已登录管理员；super 恒放行 */
export function adminGuard(deps: Deps, ...roles: AdminRole[]) {
  return async (req: FastifyRequest): Promise<void> => {
    const token = req.cookies[ADMIN_COOKIE];
    const session = token ? await resolveSession(deps.db, deps.clock.now(), token) : null;
    if (!session) throw new HttpError(401, '未登录或登录已过期');
    if (roles.length > 0 && session.role !== 'super' && !roles.includes(session.role)) {
      throw new HttpError(403, '无权限');
    }
    req.adminId = session.adminId;
    req.adminRole = session.role;
  };
}
