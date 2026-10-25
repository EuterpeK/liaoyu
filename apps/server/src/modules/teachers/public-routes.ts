import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { IdParam } from '../../lib/zod.ts';
import { getPublicTeacher, listPublicTeachers } from './service.ts';

export const publicTeacherRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      '/',
      {
        schema: {
          querystring: z.object({
            direction: z.string().min(1).optional(),
            level: z.coerce.number().int().min(1).max(5).optional(),
          }),
        },
      },
      async (req) => listPublicTeachers(deps.db, req.query),
    );

    app.get('/:id', { schema: { params: z.object({ id: IdParam }) } }, async (req) =>
      getPublicTeacher(deps.db, req.params.id),
    );
  };
