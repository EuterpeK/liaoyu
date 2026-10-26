import { desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { admins, auditLogs } from '../../db/schema.ts';
import type { Deps } from '../../deps.ts';
import { audit } from '../../lib/audit.ts';
import { HttpError } from '../../lib/errors.ts';
import { adminGuard } from './guard.ts';
import { ADMIN_COOKIE, createSession, deleteSession, SESSION_TTL_MS, verifyAdminLogin } from './service.ts';

export const adminAuthRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.post(
      '/login',
      { schema: { body: z.object({ username: z.string().min(1), password: z.string().min(1) }) } },
      async (req, reply) => {
        const admin = await verifyAdminLogin(deps.db, req.body.username, req.body.password);
        if (!admin) throw new HttpError(401, '账号或密码错误');
        const token = await createSession(deps.db, deps.clock.now(), admin.id);
        await audit(deps.db, {
          adminId: admin.id,
          action: 'admin.login',
          target: `admin:${admin.id}`,
          detail: { ip: req.ip },
        });
        reply.setCookie(ADMIN_COOKIE, token, {
          httpOnly: true,
          sameSite: 'strict',
          secure: deps.config.cookieSecure,
          path: '/api/admin',
          maxAge: SESSION_TTL_MS / 1000,
        });
        return admin;
      },
    );

    app.post('/logout', async (req, reply) => {
      const token = req.cookies[ADMIN_COOKIE];
      if (token) await deleteSession(deps.db, token);
      reply.clearCookie(ADMIN_COOKIE, { path: '/api/admin' });
      return { ok: true };
    });

    app.get('/me', { preHandler: adminGuard(deps) }, async (req) => {
      const [a] = await deps.db
        .select({ id: admins.id, username: admins.username })
        .from(admins)
        .where(eq(admins.id, req.adminId));
      return a;
    });

    app.get(
      '/audit-logs',
      {
        preHandler: adminGuard(deps),
        schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }) },
      },
      async (req) =>
        deps.db
          .select({
            id: auditLogs.id,
            adminId: auditLogs.adminId,
            action: auditLogs.action,
            target: auditLogs.target,
            detail: auditLogs.detail,
            createdAt: auditLogs.createdAt,
          })
          .from(auditLogs)
          .orderBy(desc(auditLogs.id))
          .limit(req.query.limit),
    );
  };
