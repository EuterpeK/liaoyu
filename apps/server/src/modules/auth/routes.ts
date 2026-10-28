import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { teacherProfiles, users } from '../../db/schema.ts';
import type { Deps } from '../../deps.ts';
import { createRateLimiter, ipRateLimit } from '../../lib/rate-limit.ts';
import { userGuard } from './guards.ts';
import { signUserToken } from './tokens.ts';

export const authRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const loginLimit = ipRateLimit(createRateLimiter({ max: 30, windowMs: 60_000 }));
    const userCols = { id: users.id, nickname: users.nickname };

    async function findOrCreateUser(openid: string) {
      const [existing] = await deps.db.select(userCols).from(users).where(eq(users.openid, openid));
      if (existing) return existing;
      const [created] = await deps.db
        .insert(users)
        .values({ openid })
        .onConflictDoNothing({ target: users.openid })
        .returning(userCols);
      if (created) return created;
      // 并发注册：对方先插入成功，回查即可
      const [raced] = await deps.db.select(userCols).from(users).where(eq(users.openid, openid));
      return raced;
    }

    app.post(
      '/wxlogin',
      { preHandler: loginLimit, schema: { body: z.object({ code: z.string().min(1) }) } },
      async (req) => {
        const { openid } = await deps.wechat.code2Session(req.body.code);
        const user = await findOrCreateUser(openid);
        return { token: await signUserToken(deps.config, deps.clock, user.id), user };
      },
    );

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
