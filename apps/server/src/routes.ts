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
}
