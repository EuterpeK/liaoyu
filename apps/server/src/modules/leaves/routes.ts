import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { DateStr, IdParam } from '../../lib/zod.ts';
import { userGuard } from '../auth/guards.ts';
import { teacherGuard } from '../teachers/guard.ts';
import {
  createLeave,
  decideChoice,
  listChoices,
  listInvites,
  listLeaves,
  MAX_CANDIDATES,
  respondInvite,
  revokeSubstitute,
} from './service.ts';

const LeaveBody = z.object({
  startDate: DateStr,
  endDate: DateStr,
  reason: z.string().trim().max(200).optional(),
  candidateIds: z.array(z.number().int().positive()).min(1).max(MAX_CANDIDATES),
});

export const teacherLeaveRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.addHook('preHandler', teacherGuard(deps));

    app.post('/', { schema: { body: LeaveBody } }, async (req, reply) =>
      reply.status(201).send(await createLeave(deps.db, deps.clock.now(), { teacherId: req.userId, ...req.body })),
    );

    app.get('/', async (req) => listLeaves(deps.db, req.userId));

    app.post(
      '/:id/candidates/:teacherId/revoke',
      { schema: { params: z.object({ id: IdParam, teacherId: IdParam }) } },
      async (req) =>
        revokeSubstitute(deps.db, deps.clock.now(), {
          teacherId: req.userId,
          leaveId: req.params.id,
          candidateId: req.params.teacherId,
        }),
    );
  };

export const substituteInviteRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.addHook('preHandler', teacherGuard(deps));

    app.get('/', async (req) => listInvites(deps.db, req.userId));

    app.post(
      '/:leaveId/respond',
      { schema: { params: z.object({ leaveId: IdParam }), body: z.object({ accept: z.boolean() }) } },
      async (req) =>
        respondInvite(deps.db, deps.clock.now(), {
          teacherId: req.userId,
          leaveId: req.params.leaveId,
          accept: req.body.accept,
        }),
    );
  };

const Decision = z.discriminatedUnion('action', [
  z.object({ action: z.literal('wait') }),
  z.object({ action: z.literal('substitute'), teacherId: z.number().int().positive() }),
]);

export const leaveChoiceRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.addHook('preHandler', userGuard(deps));

    app.get('/', async (req) => listChoices(deps.db, req.userId));

    app.post('/:id', { schema: { params: z.object({ id: IdParam }), body: Decision } }, async (req) =>
      decideChoice(deps.db, deps.clock.now(), { userId: req.userId, choiceId: req.params.id, ...req.body }),
    );
  };
