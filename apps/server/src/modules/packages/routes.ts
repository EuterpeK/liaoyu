import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { packageType } from '../../db/schema.ts';
import type { Deps } from '../../deps.ts';
import { IdParam } from '../../lib/zod.ts';
import { userGuard } from '../auth/guards.ts';
import { createPackage, listOwnPackages, updateOwnPackage } from './service.ts';

const Title = z.string().trim().min(1).max(50);
const Price = z.number().int().positive();

export const teacherPackageRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.addHook('preHandler', userGuard(deps));

    app.post(
      '/',
      {
        schema: {
          body: z.object({
            type: z.enum(packageType.enumValues),
            title: Title,
            priceCents: Price,
            callQuota: z.number().int().min(0).default(0),
            replyHours: z.number().int().positive().default(24),
          }),
        },
      },
      async (req, reply) => reply.status(201).send(await createPackage(deps.db, req.userId, req.body)),
    );

    app.get('/', async (req) => listOwnPackages(deps.db, req.userId));

    app.patch(
      '/:id',
      {
        schema: {
          params: z.object({ id: IdParam }),
          body: z
            .object({ onSale: z.boolean().optional(), priceCents: Price.optional(), title: Title.optional() })
            .refine((o) => Object.keys(o).length > 0, '至少修改一项'),
        },
      },
      async (req) => updateOwnPackage(deps.db, req.userId, req.params.id, req.body),
    );
  };
