import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { teacherProfiles, users } from '../../db/schema.ts';
import type { Deps } from '../../deps.ts';
import { userGuard } from './guards.ts';
import { signUserToken } from './tokens.ts';

export const authRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.post('/wxlogin', { schema: { body: z.object({ code: z.string().min(1) }) } }, async (req) => {
      const { openid } = await deps.wechat.code2Session(req.body.code);
      const [user] = await deps.db
        .insert(users)
        .values({ openid })
        .onConflictDoUpdate({ target: users.openid, set: { openid } })
        .returning({ id: users.id, nickname: users.nickname });
      return { token: await signUserToken(deps.config, deps.clock, user.id), user };
    });

    app.get('/me', { preHandler: userGuard(deps) }, async (req) => {
      const [user] = await deps.db
        .select({ id: users.id, nickname: users.nickname })
        .from(users)
        .where(eq(users.id, req.userId));
      const [teacher] = await deps.db
        .select({
          status: teacherProfiles.status,
          level: teacherProfiles.level,
          displayName: teacherProfiles.displayName,
        })
        .from(teacherProfiles)
        .where(eq(teacherProfiles.userId, req.userId));
      return { user, teacher: teacher ?? null };
    });
  };
