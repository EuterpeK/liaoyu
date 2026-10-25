import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Deps } from '../../deps.ts';
import { userGuard } from '../auth/guards.ts';
import { requireActiveTeacher } from '../teachers/service.ts';
import { listTeacherStudents, listUserRelations } from './service.ts';

export const relationRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.addHook('preHandler', userGuard(deps));
    app.get('/', async (req) => listUserRelations(deps.db, req.userId));
  };

export const teacherStudentRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.addHook('preHandler', userGuard(deps));
    app.get('/', async (req) => {
      await requireActiveTeacher(deps.db, req.userId);
      return listTeacherStudents(deps.db, req.userId);
    });
  };
