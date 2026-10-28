import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { teacherStatus } from '../../db/schema.ts';
import type { Deps } from '../../deps.ts';
import { audit } from '../../lib/audit.ts';
import { IdParam } from '../../lib/zod.ts';
import { adminGuard } from '../admin/guard.ts';
import { listTeachersForAdmin, reviewTeacher } from './service.ts';

export const adminTeacherRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const onRequest = adminGuard(deps, 'ops');

    app.get(
      '/',
      { onRequest, schema: { querystring: z.object({ status: z.enum(teacherStatus.enumValues).optional() }) } },
      async (req) => listTeachersForAdmin(deps.db, deps.config.fieldKey, req.query.status),
    );

    app.post(
      '/:userId/review',
      {
        onRequest,
        schema: {
          params: z.object({ userId: IdParam }),
          body: z.object({ approve: z.boolean(), level: z.number().int().optional() }),
        },
      },
      async (req) =>
        deps.db.transaction(async (tx) => {
          const row = await reviewTeacher(tx, deps.clock, req.params.userId, req.body);
          await audit(tx, {
            adminId: req.adminId,
            action: req.body.approve ? 'teacher.approve' : 'teacher.reject',
            target: `teacher:${req.params.userId}`,
            detail: { level: req.body.level ?? null },
          });
          return row;
        }),
    );
  };
