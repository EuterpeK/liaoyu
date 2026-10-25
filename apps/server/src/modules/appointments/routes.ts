import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { DateStr, HhMm, IdParam } from '../../lib/zod.ts';
import { userGuard } from '../auth/guards.ts';
import { teacherGuard } from '../teachers/guard.ts';
import { book, cancelByTeacher, cancelByUser, listForTeacher, listForUser, slotsForRelation } from './service.ts';

const ById = { params: z.object({ id: IdParam }) };

export const appointmentRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.addHook('preHandler', userGuard(deps));

    app.get('/slots', { schema: { querystring: z.object({ relationId: IdParam, date: DateStr }) } }, async (req) =>
      slotsForRelation(deps.db, deps.clock.now(), { userId: req.userId, ...req.query }),
    );

    app.post(
      '/',
      { schema: { body: z.object({ relationId: z.number().int().positive(), date: DateStr, start: HhMm }) } },
      async (req, reply) =>
        reply.status(201).send(await book(deps.db, deps.clock.now(), { userId: req.userId, ...req.body })),
    );

    app.get('/', async (req) => listForUser(deps.db, req.userId));

    app.post('/:id/cancel', { schema: ById }, async (req) =>
      cancelByUser(deps.db, deps.clock.now(), { userId: req.userId, id: req.params.id }),
    );

    // 后续 Task 在此追加：进入通话、确认通话
  };

export const teacherAppointmentRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.addHook('preHandler', teacherGuard(deps));

    app.get('/', async (req) => listForTeacher(deps.db, req.userId));

    app.post('/:id/cancel', { schema: ById }, async (req) =>
      cancelByTeacher(deps.db, deps.clock.now(), { teacherId: req.userId, id: req.params.id }),
    );

    // 后续 Task 在此追加：老师进入通话
  };
