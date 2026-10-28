import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { adminRole } from '../../db/schema.ts';
import type { Deps } from '../../deps.ts';
import { audit } from '../../lib/audit.ts';
import { IdParam } from '../../lib/zod.ts';
import { createAdmin, listAdmins, resetPassword, updateAdmin } from './accounts.ts';
import { adminGuard } from './guard.ts';

const Password = z.string().min(10).max(128);

export const adminAccountRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const onRequest = adminGuard(deps, 'super');

    app.get('/', { onRequest }, async () => listAdmins(deps.db));

    app.post(
      '/',
      {
        onRequest,
        schema: {
          body: z.object({
            username: z.string().trim().min(2).max(40),
            password: Password,
            role: z.enum(adminRole.enumValues),
          }),
        },
      },
      async (req, reply) => {
        const row = await deps.db.transaction(async (tx) => {
          const a = await createAdmin(tx, req.body);
          await audit(tx, {
            adminId: req.adminId,
            action: 'admin.create',
            target: `admin:${a.id}`,
            detail: { username: a.username, role: a.role },
          });
          return a;
        });
        return reply.status(201).send(row);
      },
    );

    app.patch(
      '/:id',
      {
        onRequest,
        schema: {
          params: z.object({ id: IdParam }),
          body: z.object({ role: z.enum(adminRole.enumValues).optional(), disabled: z.boolean().optional() }),
        },
      },
      async (req) =>
        deps.db.transaction(async (tx) => {
          const row = await updateAdmin(tx, deps.clock.now(), req.adminId, req.params.id, req.body);
          await audit(tx, {
            adminId: req.adminId,
            action: 'admin.update',
            target: `admin:${row.id}`,
            detail: req.body,
          });
          return row;
        }),
    );

    app.post(
      '/:id/reset-password',
      { onRequest, schema: { params: z.object({ id: IdParam }), body: z.object({ password: Password }) } },
      async (req) =>
        deps.db.transaction(async (tx) => {
          await resetPassword(tx, req.params.id, req.body.password);
          await audit(tx, { adminId: req.adminId, action: 'admin.reset_password', target: `admin:${req.params.id}` });
          return { ok: true };
        }),
    );
  };
