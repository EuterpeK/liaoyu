import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { userGuard } from '../auth/guards.ts';
import { listNotifications, markRead } from './service.ts';

export const notificationRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.addHook('preHandler', userGuard(deps));

    app.get('/', { schema: { querystring: z.object({ unread: z.stringbool().optional() }) } }, async (req) =>
      listNotifications(deps.db, req.userId, req.query.unread ?? false),
    );

    app.post(
      '/read',
      { schema: { body: z.object({ ids: z.array(z.number().int().positive()).max(100).optional() }) } },
      async (req) => ({ updated: await markRead(deps.db, req.userId, req.body.ids) }),
    );
  };
