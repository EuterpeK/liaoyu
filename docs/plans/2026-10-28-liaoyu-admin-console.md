# LiaoYu 管理台重做 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把单文件 `admin.html` 换成 Vue3 + TDesign 管理台工程，带路由、布局、三角色（super/ops/finance）权限，并新增管理员账号管理。

**Architecture:** 新增 `apps/admin`（Vite 构建），产物由 Fastify 用 `@fastify/static` 托管于 `/admin/`（同源，Cookie 策略不变）。后端 `admins` 加 `role/disabled_at`，`adminGuard(deps, ...roles)` 以路由级 `onRequest` 钩子校验角色（认证先于参数校验）。前端 `permissions.ts` 动作表仅用于体验，服务端 `tests/admin-matrix.ts` 与之做漂移对照。

**Tech Stack:** Vue 3.5、Vite 7、TypeScript、TDesign Vue Next、Pinia、vue-router、Vitest + @vue/test-utils + happy-dom；后端沿用 Fastify 5 / Drizzle / Vitest。

**设计文档:** `docs/plans/2026-10-28-liaoyu-admin-console-design.md`

**通用约定**
- 新 shell 先 `source ~/.nvm/nvm.sh && nvm use 24`。
- 后端测试需要 `pnpm db:up`；vitest 输出用 `| grep -a` 避免 ANSI 截断。
- 同一文件的多处修改必须串行，不要并行 replace。
- 全局门禁：`pnpm check`（Biome + tsc + Vitest）。
- 每个 Task 末尾提交一次。
- 页面类 Task（F5~F10）给出 API、列、交互与测试，实现代码在执行时按同一风格写出。

---

## Part B 后端

### Task B1: 角色字段、迁移与服务层

**Files:**
- Modify: `apps/server/src/db/schema.ts`（admins 表、枚举）
- Create: `apps/server/src/db/migrations/0005_*.sql`（drizzle-kit 生成）
- Modify: `apps/server/src/modules/admin/service.ts`
- Modify: `apps/server/tests/helpers.ts`（`adminCookie` 加 role）
- Test: `apps/server/src/modules/admin/admin.test.ts`

**Step 1: 写失败测试**（追加到 `admin.test.ts` 末尾，并更新 import：`import { ADMIN_COOKIE, createSession, upsertAdmin, resolveSession } from './service.ts';`、`import { admins } from '../../db/schema.ts';`、`import { eq } from 'drizzle-orm';`）

```ts
describe('管理员角色', () => {
  test('默认 super，可指定角色；login 与 /me 返回 role', async () => {
    const ctx = await setup();
    await upsertAdmin(ctx.db, 'boss', 'password-123');
    await upsertAdmin(ctx.db, 'fin', 'password-123', 'finance');
    const rows = await ctx.db.select().from(admins);
    expect(Object.fromEntries(rows.map((r) => [r.username, r.role]))).toEqual({ boss: 'super', fin: 'finance' });
    const login = await call(ctx, 'POST', '/api/admin/login', { body: { username: 'fin', password: 'password-123' } });
    expect(login.json()).toMatchObject({ username: 'fin', role: 'finance' });
  });

  test('停用账号：不能登录，已有会话立即失效', async () => {
    const ctx = await setup();
    const cookie = await adminCookie(ctx, 'ops1', 'password-123', 'ops');
    expect((await call(ctx, 'GET', '/api/admin/me', { cookie })).statusCode).toBe(200);
    await ctx.db.update(admins).set({ disabledAt: new Date() }).where(eq(admins.username, 'ops1'));
    expect((await call(ctx, 'GET', '/api/admin/me', { cookie })).statusCode).toBe(401);
    const res = await call(ctx, 'POST', '/api/admin/login', { body: { username: 'ops1', password: 'password-123' } });
    expect(res.statusCode).toBe(401);
  });
});
```

**Step 2: 运行确认失败**

Run: `cd apps/server && pnpm vitest run src/modules/admin/admin.test.ts | grep -a -E "✓|✗|FAIL|passed|failed"`
Expected: FAIL（`upsertAdmin` 不接受 role / `role` 列不存在）

**Step 3: 实现**

`schema.ts`：在其它 `pgEnum` 旁加

```ts
export const adminRole = pgEnum('admin_role', ['super', 'ops', 'finance']);
export type AdminRole = (typeof adminRole.enumValues)[number];
```

`admins` 表改为

```ts
export const admins = pgTable('admins', {
  id: id(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: adminRole('role').notNull().default('super'),
  disabledAt: tstz('disabled_at'),
  createdAt: createdAt(),
});
```

生成迁移：`cd apps/server && pnpm db:generate --name admin_roles`，检查生成的 SQL 只含 `CREATE TYPE "admin_role"` 与两个 `ALTER TABLE "admins" ADD COLUMN`。

`service.ts` 改为（保留未列出的函数）：

```ts
import { and, eq, gt, isNull } from 'drizzle-orm';
import { type AdminRole, adminSessions, admins } from '../../db/schema.ts';

export interface AdminIdentity {
  id: number;
  username: string;
  role: AdminRole;
}

export async function upsertAdmin(
  db: DbOrTx,
  username: string,
  password: string,
  role: AdminRole = 'super',
): Promise<number> {
  const passwordHash = await hash(password);
  const [a] = await db
    .insert(admins)
    .values({ username, passwordHash, role })
    .onConflictDoUpdate({ target: admins.username, set: { passwordHash, role } })
    .returning({ id: admins.id });
  return a.id;
}

export async function verifyAdminLogin(db: DbOrTx, username: string, password: string): Promise<AdminIdentity | null> {
  const [a] = await db.select().from(admins).where(eq(admins.username, username));
  if (!a || a.disabledAt || !(await verify(a.passwordHash, password))) return null;
  return { id: a.id, username: a.username, role: a.role };
}

export async function resolveSession(
  db: DbOrTx,
  now: Date,
  token: string,
): Promise<{ adminId: number; role: AdminRole } | null> {
  const [s] = await db
    .select({ adminId: adminSessions.adminId, role: admins.role })
    .from(adminSessions)
    .innerJoin(admins, eq(admins.id, adminSessions.adminId))
    .where(and(eq(adminSessions.tokenHash, sha256(token)), gt(adminSessions.expiresAt, now), isNull(admins.disabledAt)));
  return s ?? null;
}

export async function deleteSessionsOf(db: DbOrTx, adminId: number): Promise<void> {
  await db.delete(adminSessions).where(eq(adminSessions.adminId, adminId));
}
```

`guard.ts` 先做最小适配，使其编译通过（B2 再扩展）：

```ts
const session = token ? await resolveSession(deps.db, deps.clock.now(), token) : null;
if (!session) throw new HttpError(401, '未登录或登录已过期');
req.adminId = session.adminId;
```

`admin/routes.ts` 的 `/me` 返回改为 `{ id, username, role }`（select 增加 `role: admins.role`）。

`tests/helpers.ts`：

```ts
export async function adminCookie(
  ctx: Ctx,
  username = 'boss',
  password = 'password-123',
  role: AdminRole = 'super',
): Promise<string> {
  await upsertAdmin(ctx.db, username, password, role);
  ...
```
（并 `import type { AdminRole }`）

**Step 4: 运行确认通过**

Run: `cd apps/server && pnpm typecheck && pnpm vitest run src/modules/admin | grep -a -E "passed|failed"`
Expected: PASS（含原有 admin 测试）

**Step 5: Commit**

```bash
git add apps/server && git commit -m "feat(server): 管理员角色与停用字段"
```

---

### Task B2: 角色守卫与现有路由归属

**Files:**
- Modify: `apps/server/src/modules/admin/guard.ts`
- Modify: `apps/server/src/modules/admin/routes.ts`（audit-logs 仅 super）
- Modify: `apps/server/src/modules/orders/admin-routes.ts`
- Modify: `apps/server/src/modules/teachers/admin-routes.ts`
- Modify: `apps/server/src/modules/settlement/admin-routes.ts`
- Modify: `apps/server/src/app.ts`（`FastifyRequest.adminRole`）
- Create: `apps/server/tests/admin-matrix.ts`
- Test: `apps/server/src/modules/admin/roles.test.ts`

**Step 1: 写失败测试**

`tests/admin-matrix.ts`（前端漂移测试也会用它；键即前端动作 id）：

```ts
import type { AdminRole } from '../src/db/schema.ts';

export interface MatrixRow {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  url: string;
  roles: AdminRole[];
}

/** 服务端角色归属的唯一事实来源（测试侧）。键 = 前端 permissions.ts 的动作 id */
export const MATRIX: Record<string, MatrixRow> = {
  'orders.view': { method: 'GET', url: '/api/admin/orders', roles: ['super', 'ops', 'finance'] },
  'orders.export': { method: 'GET', url: '/api/admin/orders.csv', roles: ['super', 'finance'] },
  'teacher.view': { method: 'GET', url: '/api/admin/teachers', roles: ['super', 'ops'] },
  'teacher.review': { method: 'POST', url: '/api/admin/teachers/1/review', roles: ['super', 'ops'] },
  'commission.view': { method: 'GET', url: '/api/admin/settings/commission-bps', roles: ['super', 'finance'] },
  'commission.edit': { method: 'PUT', url: '/api/admin/settings/commission-bps', roles: ['super'] },
  'settlement.view': { method: 'GET', url: '/api/admin/settlements', roles: ['super', 'finance'] },
  'settlement.generate': { method: 'POST', url: '/api/admin/settlements/generate', roles: ['super', 'finance'] },
  'settlement.pay': { method: 'POST', url: '/api/admin/settlements/1/pay', roles: ['super', 'finance'] },
  'audit.view': { method: 'GET', url: '/api/admin/audit-logs', roles: ['super'] },
  'admins.manage': { method: 'GET', url: '/api/admin/admins', roles: ['super'] },
};
```

`roles.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import { adminCookie, call, setup } from '../../../tests/helpers.ts';
import { MATRIX } from '../../../tests/admin-matrix.ts';
import type { AdminRole } from '../../db/schema.ts';

const ROLES: AdminRole[] = ['super', 'ops', 'finance'];

describe('管理端角色矩阵', () => {
  for (const [action, row] of Object.entries(MATRIX)) {
    test(`${action}: ${row.method} ${row.url}`, async () => {
      const ctx = await setup();
      expect((await call(ctx, row.method, row.url, { body: row.method === 'GET' ? undefined : {} })).statusCode).toBe(401);
      for (const role of ROLES) {
        const cookie = await adminCookie(ctx, `u-${role}`, 'password-123', role);
        const res = await call(ctx, row.method, row.url, { cookie, body: row.method === 'GET' ? undefined : {} });
        if (row.roles.includes(role)) {
          expect([401, 403], `${role} 应被放行`).not.toContain(res.statusCode);
        } else {
          expect(res.statusCode, `${role} 应被拒绝`).toBe(403);
        }
      }
    });
  }

  test('任何已登录角色都能访问 /me', async () => {
    const ctx = await setup();
    for (const role of ROLES) {
      const cookie = await adminCookie(ctx, `m-${role}`, 'password-123', role);
      const res = await call(ctx, 'GET', '/api/admin/me', { cookie });
      expect(res.json().role).toBe(role);
    }
  });
});
```
注：`admins.manage` 行在 B3 完成前会得到 404（对 super 放行判定仍通过，对 ops/finance 因路由不存在得 404 而非 403）。因此 B2 阶段先在 MATRIX 里**不加** `admins.manage`，B3 时再加。

**Step 2: 运行确认失败**

Run: `cd apps/server && pnpm vitest run src/modules/admin/roles.test.ts | grep -a -E "passed|failed"`
Expected: FAIL（ops/finance 目前全部放行）

**Step 3: 实现**

`guard.ts`：

```ts
import type { FastifyRequest } from 'fastify';
import type { AdminRole } from '../../db/schema.ts';
import type { Deps } from '../../deps.ts';
import { HttpError } from '../../lib/errors.ts';
import { ADMIN_COOKIE, resolveSession } from './service.ts';

/** onRequest 钩子：先认证再鉴权，早于参数校验。不传 roles = 任意已登录管理员；super 恒放行 */
export function adminGuard(deps: Deps, ...roles: AdminRole[]) {
  return async (req: FastifyRequest): Promise<void> => {
    const token = req.cookies[ADMIN_COOKIE];
    const session = token ? await resolveSession(deps.db, deps.clock.now(), token) : null;
    if (!session) throw new HttpError(401, '未登录或登录已过期');
    if (roles.length > 0 && session.role !== 'super' && !roles.includes(session.role)) {
      throw new HttpError(403, '无权限');
    }
    req.adminId = session.adminId;
    req.adminRole = session.role;
  };
}
```

`app.ts` 的 `FastifyRequest` 增加 `adminRole: AdminRole;`，并 `app.decorateRequest('adminRole', 'super')`，加 `import type { AdminRole } from './db/schema.ts';`。

路由改写（去掉整插件 `addHook('preHandler', ...)`，每个路由加 `onRequest`）：
- `orders/admin-routes.ts`：`/orders`、`/orders/summary`：`onRequest: adminGuard(deps)`；`/orders.csv`：`onRequest: adminGuard(deps, 'finance')`。已有的 `{ schema: ... }` 保持，合并成 `{ onRequest, schema }`。
- `teachers/admin-routes.ts`：两条路由 `onRequest: adminGuard(deps, 'ops')`。
- `settlement/admin-routes.ts`：`GET commission-bps`、`settlements`、`generate`、`:id/pay`：`adminGuard(deps, 'finance')`；`PUT commission-bps`：`adminGuard(deps)` 后再限 super——直接写 `adminGuard(deps, 'super')`（super 恒放行，传 `'super'` 即仅 super）。
- `admin/routes.ts`：`/me` 用 `adminGuard(deps)`；`/audit-logs` 用 `adminGuard(deps, 'super')`（原 `preHandler` 改 `onRequest`）。

**Step 4: 运行确认通过**

Run: `cd apps/server && pnpm typecheck && pnpm vitest run | grep -a -E "passed|failed"`
Expected: 全部 PASS（既有 orders/teachers/settlement 测试使用 super cookie，不受影响）

**Step 5: Commit**

```bash
git add apps/server && git commit -m "feat(server): 管理端接口按角色鉴权"
```

---

### Task B3: 管理员账号管理接口

**Files:**
- Create: `apps/server/src/modules/admin/accounts.ts`（服务）
- Create: `apps/server/src/modules/admin/accounts-routes.ts`
- Modify: `apps/server/src/routes.ts`（注册 `/api/admin/admins`）
- Modify: `apps/server/tests/admin-matrix.ts`（加 `admins.manage`）
- Test: `apps/server/src/modules/admin/accounts.test.ts`

**Step 1: 写失败测试** `accounts.test.ts`

```ts
import { describe, expect, test } from 'vitest';
import { adminCookie, call, setup } from '../../../tests/helpers.ts';
import { auditLogs } from '../../db/schema.ts';

async function world() {
  const ctx = await setup();
  const cookie = await adminCookie(ctx, 'boss', 'password-123', 'super');
  const api = (method: 'GET' | 'POST' | 'PATCH', url: string, body?: object, c = cookie) =>
    call(ctx, method, `/api/admin/admins${url}`, { cookie: c, body });
  return { ctx, cookie, api };
}

describe('管理员账号管理', () => {
  test('新建、列表（不含密码哈希）、重名 409、弱密码 400', async () => {
    const w = await world();
    const created = await w.api('POST', '', { username: 'ops1', password: 'password-123', role: 'ops' });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ username: 'ops1', role: 'ops' });
    expect((await w.api('POST', '', { username: 'ops1', password: 'password-123', role: 'ops' })).statusCode).toBe(409);
    expect((await w.api('POST', '', { username: 'x', password: 'short', role: 'ops' })).statusCode).toBe(400);
    const list = (await w.api('GET', '')).json();
    expect(list.map((a: { username: string }) => a.username).sort()).toEqual(['boss', 'ops1']);
    expect(JSON.stringify(list)).not.toMatch(/passwordHash|argon2/);
  });

  test('改角色；停用后会话失效、启用后可再登录；重置密码清会话', async () => {
    const w = await world();
    const id = (await w.api('POST', '', { username: 'fin', password: 'password-123', role: 'finance' })).json().id;
    const finCookie = await adminCookie(w.ctx, 'fin', 'password-123', 'finance');
    expect((await w.api('PATCH', `/${id}`, { role: 'ops' })).json().role).toBe('ops');

    await w.api('PATCH', `/${id}`, { disabled: true });
    expect((await call(w.ctx, 'GET', '/api/admin/me', { cookie: finCookie })).statusCode).toBe(401);
    await w.api('PATCH', `/${id}`, { disabled: false });
    const relogin = await call(w.ctx, 'POST', '/api/admin/login', { body: { username: 'fin', password: 'password-123' } });
    expect(relogin.statusCode).toBe(200);

    const cookie2 = `ly_admin=${relogin.cookies[0].value}`;
    const reset = await w.api('POST', `/${id}/reset-password`, { password: 'new-password-456' });
    expect(reset.statusCode).toBe(200);
    expect((await call(w.ctx, 'GET', '/api/admin/me', { cookie: cookie2 })).statusCode).toBe(401);
    const login = await call(w.ctx, 'POST', '/api/admin/login', { body: { username: 'fin', password: 'new-password-456' } });
    expect(login.statusCode).toBe(200);
  });

  test('护栏：不能停用/降级自己；不能让系统没有启用的 super', async () => {
    const w = await world();
    const me = (await call(w.ctx, 'GET', '/api/admin/me', { cookie: w.cookie })).json();
    expect((await w.api('PATCH', `/${me.id}`, { disabled: true })).statusCode).toBe(400);
    expect((await w.api('PATCH', `/${me.id}`, { role: 'ops' })).statusCode).toBe(400);
    // 第二个 super 存在时，可以由它去降级第一个
    const id2 = (await w.api('POST', '', { username: 'boss2', password: 'password-123', role: 'super' })).json().id;
    const c2 = await adminCookie(w.ctx, 'boss2', 'password-123', 'super');
    expect((await w.api('PATCH', `/${me.id}`, { role: 'ops' }, c2)).statusCode).toBe(200);
    // 此时 boss2 是唯一启用的 super：自己不能动（自护栏），且别人也无法再移除它（用刚降级的 ops 访问会 403）
    expect((await w.api('PATCH', `/${id2}`, { disabled: true }, c2)).statusCode).toBe(400);
  });

  test('操作写审计且不含密码；非 super 403', async () => {
    const w = await world();
    const id = (await w.api('POST', '', { username: 'o', password: 'password-123', role: 'ops' })).json().id;
    await w.api('PATCH', `/${id}`, { role: 'finance' });
    await w.api('POST', `/${id}/reset-password`, { password: 'new-password-456' });
    const logs = await w.ctx.db.select().from(auditLogs);
    const actions = logs.map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['admin.create', 'admin.update', 'admin.reset_password']));
    expect(JSON.stringify(logs)).not.toMatch(/password-123|new-password-456/);
    const opsCookie = await adminCookie(w.ctx, 'o', 'password-123', 'ops');
    expect((await w.api('GET', '', undefined, opsCookie)).statusCode).toBe(403);
  });
});
```

**Step 2: 运行确认失败** — `pnpm vitest run src/modules/admin/accounts.test.ts`；Expected: FAIL（404）。

**Step 3: 实现**

`accounts.ts`：

```ts
import { hash } from '@node-rs/argon2';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { type AdminRole, admins } from '../../db/schema.ts';
import { HttpError } from '../../lib/errors.ts';
import { pgConstraint } from '../../lib/pg-errors.ts';
import { deleteSessionsOf } from './service.ts';

const PUBLIC = {
  id: admins.id,
  username: admins.username,
  role: admins.role,
  disabledAt: admins.disabledAt,
  createdAt: admins.createdAt,
};

export const listAdmins = (db: DbOrTx) => db.select(PUBLIC).from(admins).orderBy(asc(admins.id));

export async function createAdmin(db: DbOrTx, i: { username: string; password: string; role: AdminRole }) {
  const passwordHash = await hash(i.password);
  try {
    const [a] = await db.insert(admins).values({ username: i.username, passwordHash, role: i.role }).returning(PUBLIC);
    return a;
  } catch (e) {
    if (pgConstraint(e)?.includes('username')) throw new HttpError(409, '用户名已存在');
    throw e;
  }
}

/** 在事务内调用。锁住所有启用的 super 行，保证「最后一个 super」判断不被并发绕过 */
export async function updateAdmin(
  tx: DbOrTx,
  now: Date,
  actorId: number,
  id: number,
  patch: { role?: AdminRole; disabled?: boolean },
) {
  const supers = await tx
    .select({ id: admins.id })
    .from(admins)
    .where(and(eq(admins.role, 'super'), isNull(admins.disabledAt)))
    .for('update');
  const [target] = await tx.select().from(admins).where(eq(admins.id, id)).for('update');
  if (!target) throw new HttpError(404, '管理员不存在');

  if (id === actorId && (patch.disabled === true || (patch.role && patch.role !== target.role))) {
    throw new HttpError(400, '不能停用或修改自己的角色');
  }
  const losesSuper =
    supers.some((s) => s.id === id) && ((patch.role && patch.role !== 'super') || patch.disabled === true);
  if (losesSuper && supers.length <= 1) throw new HttpError(400, '至少保留一个启用的超级管理员');

  const set: Partial<typeof admins.$inferInsert> = {};
  if (patch.role) set.role = patch.role;
  if (patch.disabled !== undefined) set.disabledAt = patch.disabled ? now : null;
  if (Object.keys(set).length === 0) throw new HttpError(400, '没有可更新的字段');
  const [row] = await tx.update(admins).set(set).where(eq(admins.id, id)).returning(PUBLIC);
  if (patch.disabled === true) await deleteSessionsOf(tx, id);
  return row;
}

export async function resetPassword(tx: DbOrTx, id: number, password: string): Promise<void> {
  const passwordHash = await hash(password);
  const r = await tx.update(admins).set({ passwordHash }).where(eq(admins.id, id)).returning({ id: admins.id });
  if (r.length === 0) throw new HttpError(404, '管理员不存在');
  await deleteSessionsOf(tx, id);
}
```

`accounts-routes.ts`：

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { adminRole } from '../../db/schema.ts';
import type { Deps } from '../../deps.ts';
import { audit } from '../../lib/audit.ts';
import { IdParam } from '../../lib/zod.ts';
import { createAdmin, listAdmins, resetPassword, updateAdmin } from './accounts.ts';
import { adminGuard } from './guard.ts';

const Password = z.string().min(10).max(128);

export const adminAccountRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const onRequest = adminGuard(deps, 'super');

    app.get('/', { onRequest }, async () => listAdmins(deps.db));

    app.post(
      '/',
      {
        onRequest,
        schema: {
          body: z.object({
            username: z.string().trim().min(2).max(40),
            password: Password,
            role: z.enum(adminRole.enumValues),
          }),
        },
      },
      async (req, reply) => {
        const row = await deps.db.transaction(async (tx) => {
          const a = await createAdmin(tx, req.body);
          await audit(tx, {
            adminId: req.adminId,
            action: 'admin.create',
            target: `admin:${a.id}`,
            detail: { username: a.username, role: a.role },
          });
          return a;
        });
        return reply.status(201).send(row);
      },
    );

    app.patch(
      '/:id',
      {
        onRequest,
        schema: {
          params: z.object({ id: IdParam }),
          body: z.object({ role: z.enum(adminRole.enumValues).optional(), disabled: z.boolean().optional() }),
        },
      },
      async (req) =>
        deps.db.transaction(async (tx) => {
          const row = await updateAdmin(tx, deps.clock.now(), req.adminId, req.params.id, req.body);
          await audit(tx, { adminId: req.adminId, action: 'admin.update', target: `admin:${row.id}`, detail: req.body });
          return row;
        }),
    );

    app.post(
      '/:id/reset-password',
      { onRequest, schema: { params: z.object({ id: IdParam }), body: z.object({ password: Password }) } },
      async (req) =>
        deps.db.transaction(async (tx) => {
          await resetPassword(tx, req.params.id, req.body.password);
          await audit(tx, { adminId: req.adminId, action: 'admin.reset_password', target: `admin:${req.params.id}` });
          return { ok: true };
        }),
    );
  };
```

`routes.ts`：import `adminAccountRoutes` 并 `await app.register(adminAccountRoutes(deps), { prefix: '/api/admin/admins' });`（放在 `adminAuthRoutes` 之后）。

`tests/admin-matrix.ts` 加回 `'admins.manage'` 行（已在 B2 文件中给出）。

注意：`username` 唯一约束名默认是 `admins_username_unique`，`includes('username')` 成立。若实际约束名不同，运行时按报错调整。

**Step 4: 运行确认通过** — `pnpm typecheck && pnpm vitest run | grep -a -E "passed|failed"`；Expected: PASS。

**Step 5: Commit** — `git commit -m "feat(server): 管理员账号管理（新建/角色/停用/重置密码）"`

---

### Task B4: 订单总数接口

**Files:**
- Modify: `apps/server/src/modules/orders/service.ts`（`countOrders`）
- Modify: `apps/server/src/modules/orders/admin-routes.ts`
- Test: `apps/server/src/modules/orders/admin.test.ts`

**Step 1: 失败测试**（追加）

```ts
  test('计数：按同样筛选返回总数，不受分页影响', async () => {
    const w = await world();
    const count = async (query: Record<string, string | number> = {}) =>
      (await call(w.ctx, 'GET', '/api/admin/orders/count', { cookie: w.cookie, query })).json();
    expect(await count()).toEqual({ total: 2 });
    expect(await count({ status: 'paid' })).toEqual({ total: 1 });
    expect(await count({ teacherId: w.a, limit: 1 })).toEqual({ total: 1 });
    expect((await call(w.ctx, 'GET', '/api/admin/orders/count')).statusCode).toBe(401);
  });
```

**Step 2:** 运行 → FAIL（404）。

**Step 3: 实现**

service：
```ts
export async function countOrders(db: DbOrTx, q: OrderQuery): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(orders).where(orderFilter(q));
  return r.n;
}
```
路由（`/orders/summary` 之后）：
```ts
app.get('/orders/count', { onRequest: adminGuard(deps), schema: { querystring: OrderQuerySchema } }, async (req) => ({
  total: await countOrders(deps.db, req.query),
}));
```
并在 import 中加入 `countOrders`。同时在 `MATRIX` 无需新增（与 `orders.view` 同权限）。

**Step 4:** 运行 → PASS。**Step 5:** `git commit -m "feat(server): 管理端订单计数接口"`

---

### Task B5: create-admin 脚本支持角色

**Files:** Modify `apps/server/src/scripts/create-admin.ts`；Modify `README.md`

**Step 1/2:** 脚本无测试基础设施，按手工验证。

**Step 3:**
```ts
import { adminRole } from '../db/schema.ts';
const [username, password, roleArg = 'super'] = process.argv.slice(2);
const role = adminRole.enumValues.find((r) => r === roleArg);
if (!username || !password || password.length < 10 || !role) {
  console.error('用法: pnpm -F @liaoyu/server create-admin <用户名> <密码(至少10位)> [super|ops|finance]');
  process.exit(1);
}
...
await upsertAdmin(db, username, password, role);
console.log(`管理员 ${username}（${role}）已创建/更新`);
```

**Step 4: 验证**

Run: `cd apps/server && pnpm create-admin x y 2>&1 | tail -2`；Expected: 打印用法并退出码 1。
Run: `pnpm create-admin tmpfin 'password-123456' finance` → `管理员 tmpfin（finance）已创建/更新`（连开发库；之后可忽略）。

**Step 5:** `git commit -m "feat(server): create-admin 支持角色参数"`

---

### Task B6: 静态托管 SPA 与 CSP，移除旧页面

**Files:**
- Modify: `apps/server/package.json`（依赖 `@fastify/static`）
- Modify: `apps/server/src/app.ts`
- Delete: `apps/server/public/admin.html`
- Test: `apps/server/src/admin-static.test.ts`

**Step 1: 失败测试**

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { call, setup } from '../tests/helpers.ts';
import { buildApp } from './app.ts';

function fakeDist() {
  const dir = mkdtempSync(join(tmpdir(), 'admin-dist-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>spa</title>');
  writeFileSync(join(dir, 'assets', 'a.js'), 'console.log(1)');
  return dir;
}

describe('管理台静态托管', () => {
  test('/admin 重定向到 /admin/；/admin/ 与深层路由回退 index.html，带严格 CSP 且不缓存', async () => {
    const ctx = await setup();
    const app = await buildApp(ctx.deps, { adminDist: fakeDist() });
    expect((await call({ app }, 'GET', '/admin')).statusCode).toBe(302);
    for (const url of ['/admin/', '/admin/orders', '/admin/settlements/1']) {
      const res = await call({ app }, 'GET', url);
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toContain('<title>spa</title>');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-security-policy']).toContain("script-src 'self';");
      expect(res.headers['content-security-policy']).not.toContain("script-src 'self' 'unsafe-inline'");
    }
  });

  test('资源文件原样返回；缺失的资源 404 而不是回退成 HTML', async () => {
    const ctx = await setup();
    const app = await buildApp(ctx.deps, { adminDist: fakeDist() });
    const ok = await call({ app }, 'GET', '/admin/assets/a.js');
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('console.log(1)');
    expect((await call({ app }, 'GET', '/admin/assets/missing.js')).statusCode).toBe(404);
  });

  test('API 的 404 不受影响', async () => {
    const ctx = await setup();
    const app = await buildApp(ctx.deps, { adminDist: fakeDist() });
    expect((await call({ app }, 'GET', '/api/nope')).statusCode).toBe(404);
  });
});
```

**Step 2:** 运行 → FAIL。

**Step 3: 实现**

`pnpm -F @liaoyu/server add @fastify/static`。

`app.ts`：
```ts
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';

/** Vite 产物是外链脚本，不需要 script 内联；TDesign 会注入内联样式，故 style 保留 */
const ADMIN_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const DEFAULT_ADMIN_DIST = fileURLToPath(new URL('../../admin/dist', import.meta.url));

export interface BuildAppOpts {
  adminDist?: string;
}
export async function buildApp(deps: Deps, opts: BuildAppOpts = {}): Promise<App> {
```
替换原来的 `app.get('/admin', ...)` 块为：

```ts
  const adminDist = opts.adminDist ?? DEFAULT_ADMIN_DIST;
  if (existsSync(adminDist)) {
    app.addHook('onSend', async (req, reply) => {
      if (req.url === '/admin' || req.url.startsWith('/admin/')) {
        reply.header('content-security-policy', ADMIN_CSP);
      }
    });
    await app.register(fastifyStatic, {
      root: adminDist,
      prefix: '/admin/',
      prefixAvoidTrailingSlash: true,
      setHeaders(res, path) {
        if (path.endsWith('index.html')) res.setHeader('cache-control', 'no-store');
        else if (path.includes('/assets/')) res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      },
    });
    app.get('/admin', { schema: { hide: true } }, async (_req, reply) => reply.redirect('/admin/'));
    app.setNotFoundHandler((req, reply) => {
      const last = req.url.split('?')[0].split('/').pop() ?? '';
      if (req.url.startsWith('/admin/') && !last.includes('.')) {
        return reply.header('cache-control', 'no-store').sendFile('index.html');
      }
      return reply.status(404).send({ error: '不存在' });
    });
  }
```
并删除不再使用的 `readFile` import 与旧 `ADMIN_CSP`。`git rm apps/server/public/admin.html`（若 `public` 目录为空则一并删除）。

执行时注意点：`prefixAvoidTrailingSlash`/`/admin` 重复路由在 `@fastify/static` 的行为，以测试为准；若与显式 `/admin` 路由冲突，去掉显式路由，改用插件自带的重定向并让测试期望对应调整。`sendFile` 需要 `decorateReply`（默认开启）。

**Step 4:** `pnpm typecheck && pnpm vitest run | grep -a -E "passed|failed"` → PASS（此前引用 `/admin` 页面的测试若存在需同步修改，`grep -rn "'/admin'" src` 确认）。

**Step 5:** `git add -A apps/server pnpm-lock.yaml && git commit -m "feat(server): 静态托管管理台 SPA，收紧 CSP，移除旧单页"`

---

## Part F 前端

### Task F1: 脚手架与构建可行性验证（先验证风险）

**Files:**
- Create: `apps/admin/package.json`、`tsconfig.json`、`vite.config.ts`、`index.html`、`src/main.ts`、`src/App.vue`、`src/env.d.ts`
- Modify: `biome.json`（排除 `dist`；视 Biome 对 `.vue` 支持决定是否排除 `**/*.vue`）

**Step 1:** `apps/admin/package.json`

```json
{
  "name": "@liaoyu/admin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc --noEmit && vite build",
    "typecheck": "vue-tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "pinia": "^3.0.0",
    "tdesign-icons-vue-next": "^0.4.0",
    "tdesign-vue-next": "^1.17.0",
    "vue": "^3.5.0",
    "vue-router": "^4.5.0"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^6.0.0",
    "@vue/test-utils": "^2.4.0",
    "happy-dom": "^20.0.0",
    "typescript": "~5.9.3",
    "unplugin-vue-components": "^29.0.0",
    "vite": "^7.0.0",
    "vitest": "^4.1.12",
    "vue-tsc": "^3.0.0"
  }
}
```
（版本以 `pnpm add` 解析结果为准，若某个大版本不存在则取最新稳定版；`vite` 固定 7.x，避免 8.x 的 Rolldown 原生依赖在 glibc 2.28 上不可用。）

`vite.config.ts`：

```ts
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { TDesignResolver } from 'unplugin-vue-components/resolvers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: '/admin/',
  plugins: [vue(), Components({ resolvers: [TDesignResolver({ library: 'vue-next' })], dts: false })],
  server: { port: 5173, proxy: { '/api': 'http://localhost:8700' } },
  test: { environment: 'happy-dom', include: ['src/**/*.test.ts'] },
});
```
注：按需引入还需要样式。`main.ts` 里 `import 'tdesign-vue-next/es/style/index.css'`；`TDesignResolver` 自动按需引入组件及其样式，不再整包 `app.use(TDesign)`。

`index.html`（`<div id="app">` + `<script type="module" src="/src/main.ts">`），`src/main.ts` 先只 `createApp(App).mount('#app')`，`App.vue` 渲染 `<t-button>构建验证</t-button>`。

`tsconfig.json`：`strict`、`moduleResolution: bundler`、`module: esnext`、`target: es2022`、`jsx: preserve`、`types: ["vite/client"]`、`include: ["src/**/*.ts","src/**/*.vue","vite.config.ts"]`、`noEmit`、`skipLibCheck`。`src/env.d.ts`：`/// <reference types="vite/client" />` 与 `declare module '*.vue'` 由 vue-tsc 处理，无需额外声明。

**Step 2: 验证**

Run: `source ~/.nvm/nvm.sh && nvm use 24 && pnpm install && pnpm -F @liaoyu/admin build 2>&1 | tail -15`
Expected: 生成 `apps/admin/dist/index.html` 与 `assets/*`；无原生模块加载错误。
若失败于 rollup/esbuild/lightningcss 的原生二进制：参照根 `package.json` 的 Biome 做法，在 `pnpm.overrides` 里把对应 `@rollup/rollup-linux-x64-gnu` 改为 `-musl` 变体；仍不行则降低 Vite 小版本。**此任务不通过则暂停并向用户汇报。**

再验证 Biome：`pnpm biome check apps/admin 2>&1 | tail -20`。若对 `.vue` 报解析/规则噪声，在 `biome.json` 的 `files.includes` 追加 `"!**/*.vue"`、`"!**/dist"`，并在文件头注明原因；业务逻辑一律放 `.ts`，`.vue` 保持薄。

**Step 3: Commit** — `git add apps/admin biome.json pnpm-lock.yaml package.json && git commit -m "feat(admin): Vue3 + TDesign 工程脚手架"`

---

### Task F2: 权限动作表与漂移测试

**Files:**
- Create: `apps/admin/src/types.ts`、`apps/admin/src/permissions.ts`
- Test: `apps/admin/src/permissions.test.ts`
- Test: `apps/server/tests/admin-drift.test.ts`

**Step 1: 失败测试**

`permissions.test.ts`：
```ts
import { describe, expect, test } from 'vitest';
import { ACTIONS, can, canEnter } from './permissions.ts';

describe('permissions', () => {
  test('super 拥有全部动作', () => {
    for (const a of Object.keys(ACTIONS)) expect(can('super', a as keyof typeof ACTIONS)).toBe(true);
  });
  test('ops/finance 的边界', () => {
    expect(can('ops', 'teacher.review')).toBe(true);
    expect(can('ops', 'orders.export')).toBe(false);
    expect(can('finance', 'settlement.pay')).toBe(true);
    expect(can('finance', 'commission.edit')).toBe(false);
    expect(can('finance', 'teacher.review')).toBe(false);
    expect(can(null, 'orders.view')).toBe(false);
  });
  test('canEnter：未声明 roles 表示任何已登录角色；super 恒可进', () => {
    expect(canEnter(undefined, 'ops')).toBe(true);
    expect(canEnter(['finance'], 'ops')).toBe(false);
    expect(canEnter(['finance'], 'super')).toBe(true);
    expect(canEnter(undefined, null)).toBe(false);
  });
});
```

`apps/server/tests/admin-drift.test.ts`（前端动作表与后端矩阵不得漂移）：
```ts
import { describe, expect, test } from 'vitest';
import { ACTIONS } from '../../admin/src/permissions.ts';
import { MATRIX } from './admin-matrix.ts';

describe('前后端权限表一致', () => {
  test('动作集合相同', () => {
    expect(Object.keys(ACTIONS).sort()).toEqual(Object.keys(MATRIX).sort());
  });
  test('每个动作的角色集合相同', () => {
    for (const [action, row] of Object.entries(MATRIX)) {
      const front = [...ACTIONS[action as keyof typeof ACTIONS]].sort();
      expect(front, action).toEqual([...row.roles].sort());
    }
  });
});
```
（`permissions.ts` 必须是纯 TS，不得 import vue；服务端 tsconfig 可直接类型检查它。）

**Step 2:** 运行 → FAIL（文件不存在）。

**Step 3: 实现**

`types.ts`：
```ts
export type Role = 'super' | 'ops' | 'finance';
export interface Me {
  id: number;
  username: string;
  role: Role;
}
```
`permissions.ts`：
```ts
import type { Role } from './types.ts';

export const ACTIONS = {
  'orders.view': ['super', 'ops', 'finance'],
  'orders.export': ['super', 'finance'],
  'teacher.view': ['super', 'ops'],
  'teacher.review': ['super', 'ops'],
  'commission.view': ['super', 'finance'],
  'commission.edit': ['super'],
  'settlement.view': ['super', 'finance'],
  'settlement.generate': ['super', 'finance'],
  'settlement.pay': ['super', 'finance'],
  'audit.view': ['super'],
  'admins.manage': ['super'],
} as const satisfies Record<string, readonly Role[]>;

export type Action = keyof typeof ACTIONS;

export function can(role: Role | null | undefined, action: Action): boolean {
  if (!role) return false;
  return role === 'super' || (ACTIONS[action] as readonly Role[]).includes(role);
}

/** 路由 meta.roles：未声明 = 任何已登录角色 */
export function canEnter(roles: readonly Role[] | undefined, role: Role | null | undefined): boolean {
  if (!role) return false;
  return role === 'super' || !roles || roles.includes(role);
}
```

**Step 4:** `pnpm -F @liaoyu/admin test` 与 `cd apps/server && pnpm vitest run tests/admin-drift.test.ts` → PASS。

**Step 5:** `git commit -m "feat(admin): 权限动作表与前后端一致性测试"`

---

### Task F3: HTTP 封装、Auth Store、路由守卫

**Files:**
- Create: `apps/admin/src/api/http.ts`、`apps/admin/src/stores/auth.ts`、`apps/admin/src/router/guard.ts`
- Test: `apps/admin/src/api/http.test.ts`、`apps/admin/src/router/guard.test.ts`

**Step 1: 失败测试**

`http.test.ts`：
```ts
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, configureHttp, request } from './http.ts';

const hooks = { onUnauthorized: vi.fn(), onForbidden: vi.fn(), onError: vi.fn() };
configureHttp(hooks);
const reply = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('request', () => {
  test('成功返回 JSON；POST 自动带 JSON 头', async () => {
    reply(200, { ok: 1 });
    expect(await request('/x', { method: 'POST', body: { a: 1 } })).toEqual({ ok: 1 });
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/admin/x');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.body).toBe('{"a":1}');
  });
  test('401 触发 onUnauthorized 并抛错（登录接口除外）', async () => {
    reply(401, { error: '未登录' });
    await expect(request('/orders')).rejects.toBeInstanceOf(ApiError);
    expect(hooks.onUnauthorized).toHaveBeenCalledOnce();
    reply(401, { error: '账号或密码错误' });
    await expect(request('/login', { method: 'POST', body: {} })).rejects.toThrow('账号或密码错误');
    expect(hooks.onUnauthorized).toHaveBeenCalledOnce();
  });
  test('403 触发 onForbidden；其他错误取后端 error 字段并触发 onError', async () => {
    reply(403, { error: '无权限' });
    await expect(request('/x')).rejects.toMatchObject({ status: 403 });
    expect(hooks.onForbidden).toHaveBeenCalledOnce();
    reply(409, { error: '用户名已存在' });
    await expect(request('/x')).rejects.toThrow('用户名已存在');
    expect(hooks.onError).toHaveBeenCalledWith('用户名已存在');
  });
});
```

`guard.test.ts`：
```ts
import { describe, expect, test } from 'vitest';
import { decide } from './guard.ts';

describe('路由守卫决策', () => {
  test('未登录访问受保护页 → 登录页并带 redirect', () => {
    expect(decide({ path: '/orders', fullPath: '/orders?x=1', roles: undefined, public: false }, null)).toEqual({
      path: '/login',
      query: { redirect: '/orders?x=1' },
    });
  });
  test('已登录访问登录页 → 首页', () => {
    expect(decide({ path: '/login', fullPath: '/login', roles: undefined, public: true }, 'ops')).toEqual({ path: '/overview' });
  });
  test('角色不足 → /403；足够或 super → 放行(true)', () => {
    expect(decide({ path: '/audit', fullPath: '/audit', roles: ['super'], public: false }, 'ops')).toEqual({ path: '/403' });
    expect(decide({ path: '/audit', fullPath: '/audit', roles: ['super'], public: false }, 'super')).toBe(true);
    expect(decide({ path: '/orders', fullPath: '/orders', roles: undefined, public: false }, 'finance')).toBe(true);
  });
  test('公开页（/403）对任何人放行', () => {
    expect(decide({ path: '/403', fullPath: '/403', roles: undefined, public: true }, null)).toBe(true);
  });
});
```

**Step 2:** 运行 → FAIL。

**Step 3: 实现**

`api/http.ts`：
```ts
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface Hooks {
  onUnauthorized: () => void;
  onForbidden: () => void;
  onError: (message: string) => void;
}
let hooks: Hooks = { onUnauthorized() {}, onForbidden() {}, onError() {} };
export const configureHttp = (h: Hooks) => {
  hooks = h;
};

export interface RequestOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** 为 true 时不触发全局 toast（页面自行处理） */
  silent?: boolean;
}

export async function request<T = unknown>(path: string, o: RequestOpts = {}): Promise<T> {
  const qs = o.query
    ? new URLSearchParams(Object.entries(o.query).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString()
    : '';
  const res = await fetch(`/api/admin${path}${qs ? `?${qs}` : ''}`, {
    method: o.method ?? 'GET',
    headers: o.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.ok) return (await res.json().catch(() => ({}))) as T;
  const message = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? '请求失败';
  if (res.status === 401 && path !== '/login') {
    hooks.onUnauthorized();
    throw new ApiError('登录已过期，请重新登录', 401);
  }
  if (res.status === 403) hooks.onForbidden();
  else if (!o.silent) hooks.onError(message);
  throw new ApiError(message, res.status);
}
```
注：401 的 `/login` 不触发 onUnauthorized 也不 toast，错误由登录页自己展示；上面第一个测试里 403 之外的 `onError` 对 `/login` 401 也会触发？按上面代码 `/login` 的 401 会走到 `else if (!o.silent) hooks.onError(...)`——需要避免：登录页调用时传 `silent: true`。测试中 `/login` 用例只断言 `onUnauthorized` 未再次调用，不受影响。

`router/guard.ts`：
```ts
import { canEnter } from '../permissions.ts';
import type { Role } from '../types.ts';

export interface RouteInfo {
  path: string;
  fullPath: string;
  roles: readonly Role[] | undefined;
  public: boolean;
}
export type Decision = true | { path: string; query?: Record<string, string> };

export function decide(to: RouteInfo, role: Role | null): Decision {
  if (to.path === '/login') return role ? { path: '/overview' } : true;
  if (to.public) return true;
  if (!role) return { path: '/login', query: { redirect: to.fullPath } };
  return canEnter(to.roles, role) ? true : { path: '/403' };
}
```

`stores/auth.ts`：
```ts
import { defineStore } from 'pinia';
import { request } from '../api/http.ts';
import type { Me, Role } from '../types.ts';

export const useAuth = defineStore('auth', {
  state: () => ({ me: null as Me | null, loaded: false }),
  getters: { role: (s): Role | null => s.me?.role ?? null },
  actions: {
    async load() {
      try {
        this.me = await request<Me>('/me', { silent: true });
      } catch {
        this.me = null;
      }
      this.loaded = true;
    },
    async login(username: string, password: string) {
      this.me = await request<Me>('/login', { method: 'POST', body: { username, password }, silent: true });
      this.loaded = true;
    },
    async logout() {
      await request('/logout', { method: 'POST', silent: true }).catch(() => {});
      this.me = null;
    },
    clear() {
      this.me = null;
    },
  },
});
```

**Step 4:** `pnpm -F @liaoyu/admin test && pnpm -F @liaoyu/admin typecheck` → PASS。
**Step 5:** `git commit -m "feat(admin): HTTP 封装、认证 store、路由守卫决策"`

---

### Task F4: 应用壳（路由、布局、登录、403）

**Files:**
- Create: `apps/admin/src/router/index.ts`、`src/layouts/MainLayout.vue`、`src/views/LoginView.vue`、`src/views/ForbiddenView.vue`、`src/nav.ts`
- Modify: `src/main.ts`、`src/App.vue`
- Test: `apps/admin/src/nav.test.ts`

**Step 1: 失败测试** `nav.test.ts`（菜单按角色过滤，菜单与路由同源）

```ts
import { describe, expect, test } from 'vitest';
import { menuFor } from './nav.ts';

describe('菜单按角色过滤', () => {
  test.each([
    ['super', ['overview', 'teachers', 'orders', 'settlements', 'audit', 'admins']],
    ['ops', ['overview', 'teachers', 'orders']],
    ['finance', ['overview', 'orders', 'settlements']],
  ] as const)('%s', (role, names) => {
    expect(menuFor(role).map((m) => m.name)).toEqual(names);
  });
});
```

**Step 2:** 运行 → FAIL。

**Step 3: 实现**

`nav.ts`（唯一的路由元数据来源，路由表与菜单都由它生成）：
```ts
import { canEnter } from './permissions.ts';
import type { Role } from './types.ts';

export interface NavItem {
  name: string;
  path: string;
  title: string;
  icon: string;
  roles?: readonly Role[];
}

export const NAV: NavItem[] = [
  { name: 'overview', path: '/overview', title: '概览', icon: 'dashboard' },
  { name: 'teachers', path: '/teachers', title: '老师管理', icon: 'user-circle', roles: ['ops'] },
  { name: 'orders', path: '/orders', title: '订单', icon: 'view-list' },
  { name: 'settlements', path: '/settlements', title: '结算', icon: 'money-circle', roles: ['finance'] },
  { name: 'audit', path: '/audit', title: '审计日志', icon: 'history', roles: [] },
  { name: 'admins', path: '/admins', title: '管理员账号', icon: 'secured', roles: [] },
];

/** roles=[] 表示仅 super（super 恒可进） */
export const menuFor = (role: Role | null) => NAV.filter((n) => canEnter(n.roles, role));
```

`router/index.ts`：用 `createRouter(createWebHistory('/admin/'))`；路由表：`/` 重定向 `/overview`；`/login`（`meta.public`）、`/403`（`meta.public`）；`MainLayout` 作为父路由，子路由由 `NAV` 映射，`component: () => import('../views/XxxView.vue')`（`overview→OverviewView`，`teachers→TeachersView` …），`meta: { roles: n.roles }`；其余路径重定向 `/overview`。`beforeEach`：`if (!auth.loaded) await auth.load()` → `const d = decide({...}, auth.role)`；非 `true` 则 `return d`。

`main.ts`：创建 app、`createPinia()`、router；`configureHttp({ onUnauthorized: () => { auth.clear(); router.push({path:'/login', query:{redirect: router.currentRoute.value.fullPath}}) }, onForbidden: () => MessagePlugin.warning('无权限执行该操作'), onError: (m) => MessagePlugin.error(m) })`；引入 `tdesign-vue-next/es/style/index.css`。

`MainLayout.vue`：`t-layout` + 左侧 `t-menu`（`menuFor(auth.role)`，`t-menu-item` + `router-link`，图标用 `tdesign-icons-vue-next` 动态组件按 `icon` 名映射，保持一个 `ICONS` 映射对象）、顶栏显示用户名与角色中文名（`{super:'超级管理员',ops:'运营',finance:'财务'}`）和退出按钮（`auth.logout()` 后跳 `/login`）、`<router-view/>`。

`LoginView.vue`：`t-form`（用户名、密码、回车提交），调用 `auth.login`，失败在表单下方显示错误（`request` 以 `silent` 调用，错误由本页展示，网络异常文案为「网络异常或服务未启动」），成功后 `router.replace(route.query.redirect ?? '/overview')`。

`ForbiddenView.vue`：`t-result status="403"` + 返回首页按钮。

**Step 4:** `pnpm -F @liaoyu/admin test && pnpm -F @liaoyu/admin build` → PASS；手工：`pnpm -F @liaoyu/admin dev` + 后端 `pnpm -F @liaoyu/server dev`，浏览器（或 curl 代理）确认登录、跳转、菜单随角色变化。
**Step 5:** `git commit -m "feat(admin): 路由、布局、登录与 403 页"`

---

### Task F5: 通用组件与概览页

**Files:**
- Create: `src/format.ts`、`src/components/MoneyText.vue`、`src/components/StatusTag.vue`、`src/components/PageTable.vue`、`src/api/orders.ts`、`src/views/OverviewView.vue`
- Test: `src/format.test.ts`

**Step 1: 失败测试** `format.test.ts`

```ts
import { describe, expect, test } from 'vitest';
import { formatDateTime, formatYuan } from './format.ts';

describe('format', () => {
  test('formatYuan：分 → ¥ 千分位两位小数', () => {
    expect(formatYuan(0)).toBe('¥0.00');
    expect(formatYuan(123456)).toBe('¥1,234.56');
  });
  test('formatDateTime：空值 —，ISO 转北京时间', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('2026-11-01T04:00:00Z')).toBe('2026-11-01 12:00:00');
  });
});
```

**Step 3: 实现要点**
- `format.ts`：`formatYuan = (c) => '¥' + (c/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})`；`formatDateTime` 用 `Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'medium'})` 输出 `YYYY-MM-DD HH:mm:ss`（`sv-SE` 格式即该样式）。
- `StatusTag.vue`：props `kind: 'teacher'|'order'|'settlement'|'appointment'`、`value`，内部映射到 `t-tag` 的 theme 与中文文案（沿用旧页：active 在职/绿、pending 待审核或待支付/橙、rejected 已驳回/红、paid 已支付/绿、disabled 已停用/灰）。
- `PageTable.vue`：封装 `t-table`，props：`columns`、`rows`、`loading`、`total`、`page`、`pageSize`；emit `update:page`、`update:pageSize`；空态用 `t-table` 的 empty 插槽。
- `api/orders.ts`：`listOrders(filter, page)`、`countOrders(filter)`、`orderSummary(filter)`、`exportUrl(filter)`（拼 `/api/admin/orders.csv?...`）。
- `OverviewView.vue`：并行请求 `/teachers`（仅 `can(role,'teacher.view')` 时，否则统计卡不显示老师两项）、`/orders/summary`、`/orders?limit=8`；4 张统计卡（入驻老师/待审、购买学员、订单数/已支付、累计收入）+ 最近订单表。

**Step 4:** `pnpm -F @liaoyu/admin test && typecheck` → PASS。**Step 5:** `git commit -m "feat(admin): 通用组件与概览页"`

---

### Task F6: 老师管理页（super、ops）

**Files:** `src/api/teachers.ts`、`src/views/TeachersView.vue`
**Test:** `src/api/teachers.test.ts`

测试（mock `fetch`，断言请求形状）：
```ts
import { afterEach, expect, test, vi } from 'vitest';
import { reviewTeacher } from './teachers.ts';

afterEach(() => vi.unstubAllGlobals());

test('批准带等级，驳回不带', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
  await reviewTeacher(7, { approve: true, level: 3 });
  await reviewTeacher(8, { approve: false });
  const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
  expect(calls[0][0]).toBe('/api/admin/teachers/7/review');
  expect(calls[0][1].body).toBe('{"approve":true,"level":3}');
  expect(calls[1][1].body).toBe('{"approve":false}');
});
```
实现要点：
- `api/teachers.ts`：`listTeachers(status?)`、`reviewTeacher(userId, {approve, level?})`。
- 页面：`t-tabs` 两页签「待审核 (n)」「全部 (n)」。待审核表列：老师、实名、方向、资质、申请时间、操作；「批准」打开 `t-dialog`，内含 `t-radio-group`（等级 1/2/3，默认 2），确认后调用并刷新；「驳回」用 `DialogPlugin.confirm` 二次确认。按钮用 `v-if="can(auth.role, 'teacher.review')"` 控制。全部表列：老师、实名、等级、状态（`StatusTag`）、方向、入驻时间。

提交：`git commit -m "feat(admin): 老师管理页"`

---

### Task F7: 订单页（全角色可看，导出仅 super/finance）

**Files:** `src/views/OrdersView.vue`（复用 F5 的 `api/orders.ts`、`PageTable`）
**Test:** `src/api/orders.test.ts`

测试：
```ts
import { expect, test } from 'vitest';
import { exportUrl } from './orders.ts';

test('exportUrl 只带非空筛选', () => {
  expect(exportUrl({ status: 'paid', userId: undefined, from: '' })).toBe('/api/admin/orders.csv?status=paid');
  expect(exportUrl({})).toBe('/api/admin/orders.csv');
});
```
实现要点：
- 筛选栏：状态下拉（全部/待支付/已支付）、用户ID、老师ID、起止日期（`t-date-range-picker`，值格式 `YYYY-MM-DD`）、查询、重置；「导出 CSV」按钮 `v-if="can(role,'orders.export')"`，点击直接 `window.location.href = exportUrl(filter)`（Cookie 同源，浏览器下载）。
- 分页：`pageSize` 默认 20；查询时并发请求 `/orders`（limit/offset）与 `/orders/count`；筛选条件变化时回到第 1 页。
- 列表上方显示当前筛选下的汇总（订单数、已支付、收入、购买人数，来自 `/orders/summary`）。

提交：`git commit -m "feat(admin): 订单页（多条件筛选、真分页、导出）"`

---

### Task F8: 结算页（super、finance）

**Files:** `src/api/settlements.ts`、`src/views/SettlementsView.vue`
**Test:** `src/api/settlements.test.ts`

测试（mock fetch）：`generateSettlements({periodStart,periodEnd})` 以 POST 到 `/api/admin/settlements/generate`；`paySettlement(3, '转账单号123')` 以 POST 到 `/api/admin/settlements/3/pay`，body `{"proof":"转账单号123"}`；`setCommissionBps(1500)` 以 PUT 到 `/api/admin/settings/commission-bps`。

实现要点：
- 佣金卡：展示 `bps` 与百分比换算（`bps/100 %`）；输入框与保存按钮仅 `can(role,'commission.edit')` 可见/可用，finance 只读。
- 生成结算单：日期范围选择器 + 生成按钮（`can(role,'settlement.generate')`），成功提示条数并刷新。
- 结算单表：老师、周期、流水、佣金（含百分比）、应结、状态、操作。「标记已打款」打开 `t-dialog`，`t-input` 凭证必填（空则不可提交，校验 1~200 字），确认后调用；已打款行显示凭证与时间。

提交：`git commit -m "feat(admin): 结算页（佣金、生成、打款对话框）"`

---

### Task F9: 审计日志页（仅 super）

**Files:** `src/views/AuditView.vue`
实现要点：请求 `/audit-logs?limit=200`；顶部「操作类型」下拉（由返回数据去重得到）做前端筛选；表列：时间、操作（`t-tag`）、对象、管理员ID、详情（默认折叠为一行，点击展开 `JSON.stringify(detail, null, 2)` 到 `<pre>`）。无新增后端接口。

提交：`git commit -m "feat(admin): 审计日志页"`

---

### Task F10: 管理员账号页（仅 super）

**Files:** `src/api/admins.ts`、`src/views/AdminsView.vue`
**Test:** `src/api/admins.test.ts`

测试（mock fetch）：`createAdmin` POST `/api/admin/admins`；`updateAdmin(2, {disabled:true})` PATCH `/api/admin/admins/2`；`resetPassword(2,'new-password-456')` POST `/api/admin/admins/2/reset-password`；`listAdmins` GET。

实现要点：
- 表列：用户名、角色（`t-tag`）、状态（正常/已停用）、创建时间、操作。
- 新建对话框：用户名、密码（≥10 位，前端同规则校验）、角色单选（超级管理员/运营/财务）。
- 操作：改角色（下拉对话框）、停用/启用（二次确认）、重置密码（对话框，≥10 位）。对「自己」这一行禁用停用与改角色按钮（后端同样有护栏，前端只做提示）。
- 后端 400/409 的 `error` 文案通过全局 `onError` 弹出。

提交：`git commit -m "feat(admin): 管理员账号页"`

---

## Part Z 收尾

### Task Z1: Docker、文档、门禁

**Files:**
- Modify: `apps/server/Dockerfile`
- Modify: `README.md`
- Modify: `.gitignore`（确认 `apps/admin/dist` 被忽略）

**Step 1: Dockerfile** 改为多阶段：

```dockerfile
FROM node:24-slim AS admin-build
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/admin/package.json apps/admin/
RUN pnpm install --frozen-lockfile --filter @liaoyu/admin
COPY apps/admin apps/admin
RUN pnpm -F @liaoyu/admin build

FROM node:24-slim
ENV NODE_ENV=production CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --prod --filter @liaoyu/server

COPY apps/server/src apps/server/src
COPY --from=admin-build /app/apps/admin/dist apps/admin/dist

USER node
WORKDIR /app/apps/server
EXPOSE 8700
CMD ["node", "src/index.ts"]
```
（构建阶段不设 `NODE_ENV=production`，否则 devDependencies 不会安装。）

**Step 2: README**：
- 本地开发补：`pnpm -F @liaoyu/admin dev`（http://localhost:5173/admin/，代理到后端）；`create-admin` 新增 `[super|ops|finance]` 参数说明。
- 目录补 `apps/admin`；管理台访问地址 `/admin/`。
- 生产部署的 `create-admin` 命令加角色说明；注明首个账号必须是 `super`。

**Step 3: 全量门禁**

Run: `pnpm db:up && pnpm check 2>&1 | tail -25`
Expected: Biome、tsc（server + vue-tsc）、Vitest（server + admin）全绿。

**Step 4: 冒烟（用户可见的真实行为）**
1. `pnpm -F @liaoyu/admin build`，起后端（`PORT=8714`，避开被占用端口，用 `$!` 记录 PID）。
2. `curl -sI localhost:8714/admin/` → 200、`content-security-policy` 含 `script-src 'self';`；`curl -s -o /dev/null -w "%{http_code}" localhost:8714/admin/orders` → 200；`/admin/assets/不存在.js` → 404；`/admin` → 302。
3. 创建三种角色账号并用 curl cookie jar 登录：ops 访问 `/api/admin/orders.csv` → 403，finance 访问 `/api/admin/teachers` → 403，super 访问 `/api/admin/admins` → 200。
4. 用 `playwright-cli` / `agent-browser` 对 `/admin/` 截图确认登录页渲染（若环境不具备则如实报告未做浏览器验证）。
5. 停掉后端进程（`kill $PID`）。

**Step 5: Commit** — `git commit -m "chore: 管理台 Docker 多阶段构建与文档"`

---

## 完成后

按 `finishing-a-development-branch` 收尾（合并回主干）。

**本计划之外、后续迭代**：用户管理、套餐/服务关系/预约查询、危机与风险事件、工单、评价、等级建议、数据看板、分等级抽成。
