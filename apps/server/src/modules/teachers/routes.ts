import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { userGuard } from '../auth/guards.ts';
import { applyTeacher } from './service.ts';

const ApplyBody = z.object({
  displayName: z.string().trim().min(1).max(30),
  realName: z.string().trim().min(1).max(30),
  intro: z.string().max(2000).default(''),
  directions: z.array(z.string().trim().min(1)).min(1).max(5),
  credentials: z.array(z.string().trim().min(1)).max(10).default([]),
});

export const teacherRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.addHook('preHandler', userGuard(deps));

    app.post('/apply', { schema: { body: ApplyBody } }, async (req, reply) => {
      await applyTeacher(deps.db, deps.config.fieldKey, req.userId, req.body);
      return reply.status(201).send({ status: 'pending' });
    });
  };
