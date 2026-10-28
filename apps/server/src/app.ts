import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyError } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { AdminRole } from './db/schema.ts';
import type { Deps } from './deps.ts';
import { HttpError } from './lib/errors.ts';
import { type App, registerRoutes } from './routes.ts';

/** Vite 产物是外链脚本，不需要 script 内联；TDesign 会注入内联样式，故 style 保留 */
const ADMIN_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const DEFAULT_ADMIN_DIST = fileURLToPath(new URL('../../admin/dist', import.meta.url));

export interface BuildAppOpts {
  /** 管理台构建产物目录；不存在则不挂载 /admin */
  adminDist?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    userId: number;
    adminId: number;
    adminRole: AdminRole;
  }
}

export async function buildApp(deps: Deps, opts: BuildAppOpts = {}): Promise<App> {
  const app = Fastify({
    logger: deps.config.nodeEnv === 'test' ? false : { level: 'info' },
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('userId', 0);
  app.decorateRequest('adminId', 0);
  app.decorateRequest('adminRole', 'super');

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({ error: '参数错误', details: err.validation });
    }
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
    req.log.error(err);
    return reply.status(500).send({ error: '服务器错误' });
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-resource-policy', 'same-origin');
    if (deps.config.cookieSecure) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
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

  const adminDist = opts.adminDist ?? DEFAULT_ADMIN_DIST;
  if (existsSync(adminDist)) {
    app.addHook('onSend', async (req, reply) => {
      if (req.url === '/admin' || req.url.startsWith('/admin/')) reply.header('content-security-policy', ADMIN_CSP);
    });
    await app.register(fastifyStatic, {
      root: adminDist,
      prefix: '/admin/',
      wildcard: true,
      setHeaders(reply, path) {
        if (path.endsWith('index.html')) reply.header('cache-control', 'no-store');
        else if (path.includes('/assets/')) reply.header('cache-control', 'public, max-age=31536000, immutable');
      },
    });
    app.get('/admin', { schema: { hide: true } }, async (_req, reply) => reply.redirect('/admin/'));
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0];
      if (path.startsWith('/admin/') && !(path.split('/').pop() ?? '').includes('.')) {
        return reply.header('cache-control', 'no-store').sendFile('index.html');
      }
      return reply.status(404).send({ error: '不存在' });
    });
  }

  await registerRoutes(app, deps);
  return app;
}
