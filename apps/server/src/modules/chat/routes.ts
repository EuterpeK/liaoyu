import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { addDays, dayStartCN, todayCN } from '../../lib/dates.ts';
import { HttpError } from '../../lib/errors.ts';
import { DateStr } from '../../lib/zod.ts';
import { teacherGuard } from '../teachers/guard.ts';
import { replyStats } from './replies.ts';

const DEFAULT_DAYS = 30;

export const teacherReplyStatsRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.addHook('preHandler', teacherGuard(deps));

    app.get(
      '/',
      { schema: { querystring: z.object({ from: DateStr.optional(), to: DateStr.optional() }) } },
      async (req) => {
        const now = deps.clock.now();
        const to = req.query.to ?? todayCN(now);
        const from = req.query.from ?? addDays(to, 1 - DEFAULT_DAYS);
        if (from > to) throw new HttpError(400, '统计区间非法');
        const stats = await replyStats(deps.db, req.userId, {
          from: dayStartCN(from),
          to: dayStartCN(addDays(to, 1)),
          now,
        });
        return { from, to, ...stats };
      },
    );
  };
