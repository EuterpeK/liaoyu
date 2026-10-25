import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Deps } from '../../deps.ts';
import { imCredential } from '../../providers/tencent.ts';
import { userGuard } from '../auth/guards.ts';

export const imRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    // 后续 Task 在此追加：IM 回调

    await app.register(async (authed) => {
      authed.addHook('preHandler', userGuard(deps));

      authed.get('/usersig', async (req) => imCredential(deps.config.tencent, req.userId, deps.clock.now()));

      // 后续 Task 在此追加：联系人
    });
  };
