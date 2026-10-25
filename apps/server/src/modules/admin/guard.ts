import type { FastifyRequest } from 'fastify';
import type { Deps } from '../../deps.ts';
import { HttpError } from '../../lib/errors.ts';
import { ADMIN_COOKIE, resolveSession } from './service.ts';

export function adminGuard(deps: Deps) {
  return async (req: FastifyRequest): Promise<void> => {
    const token = req.cookies[ADMIN_COOKIE];
    const adminId = token ? await resolveSession(deps.db, deps.clock.now(), token) : null;
    if (!adminId) throw new HttpError(401, '未登录或登录已过期');
    req.adminId = adminId;
  };
}
