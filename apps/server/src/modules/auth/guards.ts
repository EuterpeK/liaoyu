import type { FastifyRequest } from 'fastify';
import type { Deps } from '../../deps.ts';
import { HttpError } from '../../lib/errors.ts';
import { verifyUserToken } from './tokens.ts';

export function userGuard(deps: Deps) {
  return async (req: FastifyRequest): Promise<void> => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!m) throw new HttpError(401, '未登录');
    try {
      req.userId = await verifyUserToken(deps.config, deps.clock, m[1]);
    } catch {
      throw new HttpError(401, '登录已失效');
    }
  };
}
