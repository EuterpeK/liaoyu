import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { HhMm } from '../../lib/zod.ts';
import { teacherGuard } from '../teachers/guard.ts';
import { getSchedule, setSchedule } from './service.ts';

const Item = z.object({ weekday: z.number().int().min(0).max(6), start: HhMm, end: HhMm });

export const teacherScheduleRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.addHook('preHandler', teacherGuard(deps));

    app.get('/', async (req) => getSchedule(deps.db, req.userId));

    app.put('/', { schema: { body: z.object({ items: z.array(Item).max(50) }) } }, async (req) => {
      await setSchedule(deps.db, req.userId, req.body.items);
      return getSchedule(deps.db, req.userId);
    });
  };
