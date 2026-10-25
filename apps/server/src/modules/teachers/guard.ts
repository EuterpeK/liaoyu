import type { FastifyRequest } from 'fastify';
import type { Deps } from '../../deps.ts';
import { userGuard } from '../auth/guards.ts';
import { requireActiveTeacher } from './service.ts';

/** 用户登录 + 必须是已认证老师；供老师侧路由 addHook('preHandler') 使用 */
export function teacherGuard(deps: Deps) {
  const ensureUser = userGuard(deps);
  return async (req: FastifyRequest): Promise<void> => {
    await ensureUser(req);
    await requireActiveTeacher(deps.db, req.userId);
  };
}
