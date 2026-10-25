import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Deps } from './deps.ts';
import { adminAuthRoutes } from './modules/admin/routes.ts';
import { authRoutes } from './modules/auth/routes.ts';
import { teacherPackageRoutes } from './modules/packages/routes.ts';
import { adminTeacherRoutes } from './modules/teachers/admin-routes.ts';
import { publicTeacherRoutes } from './modules/teachers/public-routes.ts';
import { teacherRoutes } from './modules/teachers/routes.ts';

export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export async function registerRoutes(app: App, deps: Deps): Promise<void> {
  await app.register(authRoutes(deps), { prefix: '/api/auth' });
  await app.register(adminAuthRoutes(deps), { prefix: '/api/admin' });
  await app.register(teacherRoutes(deps), { prefix: '/api/teacher' });
  await app.register(teacherPackageRoutes(deps), { prefix: '/api/teacher/packages' });
  await app.register(adminTeacherRoutes(deps), { prefix: '/api/admin/teachers' });
  await app.register(publicTeacherRoutes(deps), { prefix: '/api/teachers' });
}
