import { readFile } from 'node:fs/promises';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyError } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Deps } from './deps.ts';
import { HttpError } from './lib/errors.ts';
import { type App, registerRoutes } from './routes.ts';

declare module 'fastify' {
  interface FastifyRequest {
    userId: number;
    adminId: number;
  }
}

export async function buildApp(deps: Deps): Promise<App> {
  const app = Fastify({
    logger: deps.config.nodeEnv === 'test' ? false : { level: 'info' },
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('userId', 0);
  app.decorateRequest('adminId', 0);

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({ error: '参数错误', details: err.validation });
    }
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
    req.log.error(err);
    return reply.status(500).send({ error: '服务器错误' });
  });

  await app.register(cookie);
  await app.register(formbody);
  await app.register(swagger, {
    openapi: { info: { title: 'LiaoYu API', version: '0.1.0' } },
    transform: jsonSchemaTransform,
  });

  app.get('/api/health', async () => ({ ok: true }));
  if (deps.config.nodeEnv !== 'production') {
    app.get('/api/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  }

  app.get('/admin', { schema: { hide: true } }, async (_req, reply) => {
    const html = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  await registerRoutes(app, deps);
  return app;
}
