import { buildApp } from '../src/app.ts';
import { type Config, loadConfig } from '../src/config.ts';
import type { DbOrTx } from '../src/db/client.ts';
import { packages, type TeacherStatus, teacherProfiles, users } from '../src/db/schema.ts';
import { createDeps } from '../src/deps.ts';
import { fixedClock } from '../src/lib/clock.ts';
import { encryptField } from '../src/lib/crypto.ts';
import { ADMIN_COOKIE, upsertAdmin } from '../src/modules/admin/service.ts';
import { resetDb, testDb } from './db-utils.ts';
import { TEST_DATABASE_URL } from './test-env.ts';

/** 北京时间 2026-11-01 12:00（周日） */
export const FIXED_NOW = '2026-11-01T04:00:00Z';

export function testConfig(override: Partial<Config> = {}): Config {
  const base = loadConfig({ NODE_ENV: 'test', DATABASE_URL: TEST_DATABASE_URL, PUBLIC_BASE_URL: 'http://test.local' });
  return { ...base, ...override };
}

export async function setup(opts: { config?: Partial<Config>; now?: string } = {}) {
  const db = testDb();
  await resetDb(db);
  const config = testConfig(opts.config);
  const clock = fixedClock(opts.now ?? FIXED_NOW);
  const deps = createDeps({ config, clock, db });
  const app = await buildApp(deps);
  return { db, config, clock, deps, app };
}

export type Ctx = Awaited<ReturnType<typeof setup>>;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface CallOpts {
  body?: object;
  query?: Record<string, string | number>;
  token?: string;
  cookie?: string;
}

export function call(ctx: Pick<Ctx, 'app'>, method: Method, url: string, o: CallOpts = {}) {
  const headers: Record<string, string> = {};
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.cookie) headers.cookie = o.cookie;
  const query = o.query ? Object.fromEntries(Object.entries(o.query).map(([k, v]) => [k, String(v)])) : undefined;
  return ctx.app.inject({ method, url, headers, payload: o.body, query });
}

export async function insertUser(db: DbOrTx, openid: string): Promise<number> {
  const [u] = await db.insert(users).values({ openid }).returning({ id: users.id });
  return u.id;
}

export async function makeTeacherProfile(
  db: DbOrTx,
  userId: number,
  o: { level?: number; status?: TeacherStatus; directions?: string[] } = {},
): Promise<void> {
  await db.insert(teacherProfiles).values({
    userId,
    displayName: `老师${userId}`,
    realNameEnc: encryptField(testConfig().fieldKey, `实名${userId}`),
    directions: o.directions ?? ['情感'],
    level: o.level ?? 2,
    status: o.status ?? 'active',
  });
}

export async function insertTeacher(
  db: DbOrTx,
  openid: string,
  o: Parameters<typeof makeTeacherProfile>[2] = {},
): Promise<number> {
  const id = await insertUser(db, openid);
  await makeTeacherProfile(db, id, o);
  return id;
}

export async function insertPackage(
  db: DbOrTx,
  teacherId: number,
  o: Partial<typeof packages.$inferInsert> = {},
): Promise<number> {
  const [p] = await db
    .insert(packages)
    .values({
      teacherId,
      type: 'month',
      title: '包月陪伴',
      priceCents: 3000,
      days: 30,
      callQuota: 4,
      replyHours: 12,
      onSale: true,
      ...o,
    })
    .returning({ id: packages.id });
  return p.id;
}

export async function loginUser(ctx: Ctx, code: string): Promise<{ token: string; userId: number }> {
  const res = await call(ctx, 'POST', '/api/auth/wxlogin', { body: { code } });
  const body = res.json();
  return { token: body.token, userId: body.user.id };
}

export async function adminCookie(ctx: Ctx, username = 'boss', password = 'password-123'): Promise<string> {
  await upsertAdmin(ctx.db, username, password);
  const res = await call(ctx, 'POST', '/api/admin/login', { body: { username, password } });
  const c = res.cookies.find((x) => x.name === ADMIN_COOKIE);
  if (!c) throw new Error(`管理员登录失败: ${res.body}`);
  return `${c.name}=${c.value}`;
}
