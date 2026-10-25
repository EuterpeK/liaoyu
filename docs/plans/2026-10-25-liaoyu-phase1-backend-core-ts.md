# LiaoYu 第一阶段：后端核心（TypeScript 版）Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 用 TypeScript + Fastify + PostgreSQL 搭建 LiaoYu 后端，打通「微信登录 → 老师入驻审核 → 套餐 → 下单付款（ZPAY）→ 服务关系与分段 → 日计提 → 周结算人工打款登记 → 订单导出」的资金闭环。

**Architecture:** pnpm 单仓，后端位于 `apps/server`，Node 24 直接运行 `.ts`（类型擦除，无构建步骤），`tsc` 只做类型检查。Fastify 路由用 Zod 定义入参并自动输出 OpenAPI；Drizzle 访问 PostgreSQL，业务不变量（分段不重叠、计提幂等、审计只追加）下沉为数据库约束；涉及钱与服务关系的写操作在事务内先加行锁。定时任务用 pg-boss。所有"现在"都取自注入的 `Clock`，测试固定时钟。

**Tech Stack:** Node 24、TypeScript 5.9、Fastify 5、Zod 4、fastify-type-provider-zod 7、Drizzle ORM 0.45、PostgreSQL 17、pg-boss 12、jose、@node-rs/argon2、Vitest 4、Biome 2、pnpm 10。

**设计文档：** `docs/plans/2026-10-24-liaoyu-platform-design.md`、`docs/plans/2026-10-25-liaoyu-tech-stack-design.md`

**替代：** 本文件替代 `archive/2026-10-24-liaoyu-phase1-backend-core.md`（Express + SQLite 版，业务拆解与测试用例已平移到这里）。

---

## 阶段路线图

| 阶段 | 内容 | 计划文件 |
|---|---|---|
| **1. 后端核心** | 登录、入驻审核、套餐、下单付款、服务关系/分段、计提、结算、订单导出、定时任务、部署文件 | 本文件 |
| 2. 服务交付 | 请假代班、预约 + TRTC、单次套餐按通话计提、IM 回调、回复时效 | `2026-10-25-liaoyu-phase2-service-delivery-ts.md` |
| 3. 管理网页 | Vue3 + TDesign | 待写 |
| 4. 小程序 | 原生 + TS + TDesign | 待写 |
| 5. 运营与风控 | 工单、评价、等级月度建议、危机事件、看板、告警 | 待写 |

---

## 约定

- 项目根：`/data/workspace/ngr/wx/LiaoYu`；后端：`apps/server`。下文路径若无特别说明，均相对 `apps/server/`。
- 每个新 shell 先执行：`source ~/.nvm/nvm.sh && nvm use 24`。
- 跑数据库相关测试前，确保开发库已启动：在项目根执行 `pnpm db:up`。
- 单个测试：`cd /data/workspace/ngr/wx/LiaoYu/apps/server && pnpm vitest run <文件>`。
- 全量门禁：在项目根执行 `pnpm check`（Biome + tsc + Vitest）。
- 每个 Task 提交前先在项目根执行 `pnpm fix`（自动格式化与整理 import），再执行 `pnpm check`。
- 相对路径 import 必须带 `.ts` 后缀；只用于类型的 import 写 `import type`（Node 类型擦除的要求）。不使用 `enum`、`namespace`、构造函数参数属性。
- 接口 JSON 字段一律 camelCase。金额一律整数「分」；抽成比例用基点（bps，10000 = 100%）。
- 业务日期为北京时间的 `YYYY-MM-DD` 字符串；时刻为 `Date`/`timestamptz`。
- 固定测试时钟：`2026-11-01T04:00:00Z`（北京时间 2026-11-01 12:00，周日）。
- 若 Biome 对"循环内 await"给出提示：计提按日顺序执行是有意为之，在该行上方加 `// biome-ignore lint/performance/noAwaitInLoops: 按日顺序执行`。
- 每个 Task 结束都提交一次 git。

---

### Task 1: 工作区与工具链 + 日期金额工具

**Files:**
- Create: `/.nvmrc`、`/package.json`、`/pnpm-workspace.yaml`、`/.npmrc`、`/biome.json`、`/.gitignore`
- Create: `/deploy/docker-compose.dev.yml`、`/deploy/initdb/01-test-db.sql`
- Create: `package.json`、`tsconfig.json`、`vitest.config.ts`
- Create: `src/lib/dates.ts`、`src/lib/money.ts`
- Test: `src/lib/dates.test.ts`、`src/lib/money.test.ts`

（以 `/` 开头的路径相对项目根。）

**Step 1: 安装 Node 24 与 pnpm**

```bash
source ~/.nvm/nvm.sh
nvm install 24 && nvm alias default 24 && nvm use 24
corepack enable pnpm
node -v
```

Expected: `v24.x.x`。

**Step 2: 写项目根配置**

`/.nvmrc`：

```
24
```

`/package.json`：

```json
{
  "name": "liaoyu",
  "private": true,
  "packageManager": "pnpm@10.34.8",
  "engines": { "node": ">=24" },
  "scripts": {
    "check": "biome check . && pnpm -r typecheck && pnpm -r test",
    "fix": "biome check --write .",
    "db:up": "docker compose -f deploy/docker-compose.dev.yml up -d --wait",
    "db:down": "docker compose -f deploy/docker-compose.dev.yml down"
  },
  "devDependencies": {
    "@biomejs/biome": "2.6.3"
  }
}
```

`/pnpm-workspace.yaml`：

```yaml
packages:
  - apps/*
onlyBuiltDependencies:
  - esbuild
```

`/.npmrc`（小程序「构建 npm」不识别 pnpm 软链，全仓统一用平铺布局）：

```
node-linker=hoisted
```

`/biome.json`：

```json
{
  "$schema": "https://biomejs.dev/schemas/2.6.3/schema.json",
  "files": {
    "includes": ["**", "!**/node_modules", "!**/migrations", "!docs"]
  },
  "formatter": { "indentStyle": "space", "indentWidth": 2, "lineWidth": 120 },
  "javascript": { "formatter": { "quoteStyle": "single" } },
  "linter": { "rules": { "recommended": true } },
  "assist": { "actions": { "source": { "organizeImports": "on" } } }
}
```

`/.gitignore`：

```
node_modules/
.env
*.log
coverage/
```

**Step 3: 开发数据库**

`/deploy/docker-compose.dev.yml`：

```yaml
name: liaoyu-dev
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: liaoyu
      POSTGRES_PASSWORD: liaoyu
      POSTGRES_DB: liaoyu
    ports:
      - "54329:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./initdb:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U liaoyu -d liaoyu"]
      interval: 2s
      timeout: 3s
      retries: 30
volumes:
  pgdata:
```

`/deploy/initdb/01-test-db.sql`：

```sql
CREATE DATABASE liaoyu_test OWNER liaoyu;
```

Run（项目根）：`pnpm db:up`
Expected: 容器 `healthy`。若拉取镜像失败，先为 Docker 配置镜像加速再重试。

Run: `docker compose -f deploy/docker-compose.dev.yml exec -T postgres psql -U liaoyu -lqt | cut -d'|' -f1 | grep -w liaoyu_test`
Expected: 输出 `liaoyu_test`。

**Step 4: 后端包配置**

`apps/server/package.json`：

```json
{
  "name": "@liaoyu/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --watch --env-file-if-exists=.env src/index.ts",
    "start": "node src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc",
    "db:generate": "drizzle-kit generate",
    "create-admin": "node --env-file-if-exists=.env src/scripts/create-admin.ts"
  },
  "dependencies": {
    "@fastify/cookie": "^11.1.3",
    "@fastify/formbody": "^9.0.1",
    "@fastify/swagger": "^9.9.2",
    "@node-rs/argon2": "^2.2.2",
    "drizzle-orm": "^0.45.4",
    "fastify": "^5.12.7",
    "fastify-type-provider-zod": "^7.0.0",
    "jose": "^6.2.13",
    "pg": "^8.23.1",
    "pg-boss": "^12.38.0",
    "zod": "^4.6.7"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@types/pg": "^8.15.0",
    "drizzle-kit": "^0.31.11",
    "typescript": "~5.9.3",
    "vitest": "^4.1.12"
  }
}
```

`apps/server/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "es2024",
    "lib": ["es2024"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "isolatedModules": true,
    "skipLibCheck": true
  },
  "include": ["src", "tests", "drizzle.config.ts", "vitest.config.ts"]
}
```

`apps/server/vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    fileParallelism: false,
  },
});
```

Run（项目根）：`pnpm install`
Expected: 安装成功，无 ERR（peer 依赖提示可忽略）。

**Step 5: 写失败测试**

`src/lib/dates.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import { addDays, dayStartCN, diffDays, eachDay, formatDateTimeCN, previousWeek, todayCN } from './dates.ts';

describe('dates', () => {
  test('addDays 跨月', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  test('diffDays 与 eachDay', () => {
    expect(diffDays('2026-02-27', '2026-03-01')).toBe(2);
    expect(eachDay('2026-02-27', '2026-03-01')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
    expect(eachDay('2026-03-02', '2026-03-01')).toEqual([]);
  });

  test('todayCN 按北京时间取日期', () => {
    expect(todayCN(new Date('2026-10-24T16:00:00Z'))).toBe('2026-10-25');
    expect(todayCN(new Date('2026-10-24T15:59:59Z'))).toBe('2026-10-24');
  });

  test('dayStartCN 返回北京时间当日零点', () => {
    expect(dayStartCN('2026-11-01').toISOString()).toBe('2026-10-31T16:00:00.000Z');
  });

  test('formatDateTimeCN 输出北京时间', () => {
    expect(formatDateTimeCN(new Date('2026-11-01T04:00:00Z'))).toBe('2026-11-01 12:00:00');
  });

  test('previousWeek 返回上周一到上周日', () => {
    expect(previousWeek('2026-11-09')).toEqual(['2026-11-02', '2026-11-08']);
    expect(previousWeek('2026-11-15')).toEqual(['2026-11-02', '2026-11-08']);
  });
});
```

`src/lib/money.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import { centsToYuan, commissionOf, splitEvenly, yuanToCents } from './money.ts';

describe('money', () => {
  test('splitEvenly 余数分摊到前几天且总和不变', () => {
    expect([0, 1, 2].map((i) => splitEvenly(1000, 3, i))).toEqual([334, 333, 333]);
    let sum = 0;
    for (let i = 0; i < 30; i++) sum += splitEvenly(1000, 30, i);
    expect(sum).toBe(1000);
  });

  test('centsToYuan', () => {
    expect(centsToYuan(1999)).toBe('19.99');
    expect(centsToYuan(3000)).toBe('30.00');
  });

  test('yuanToCents 严格解析，不经过浮点', () => {
    expect(yuanToCents('19.99')).toBe(1999);
    expect(yuanToCents('30')).toBe(3000);
    expect(yuanToCents('0.1')).toBe(10);
    for (const bad of ['', 'abc', '1.234', '-1', '1e3', ' 1']) expect(yuanToCents(bad)).toBeNull();
  });

  test('commissionOf 按基点四舍五入', () => {
    expect(commissionOf(700, 2000)).toBe(140);
    expect(commissionOf(333, 2000)).toBe(67);
  });
});
```

**Step 6: 运行，确认失败**

Run: `cd apps/server && pnpm vitest run src/lib`
Expected: FAIL，找不到 `./dates.ts` / `./money.ts`。

**Step 7: 实现**

`src/lib/dates.ts`：

```ts
const DAY_MS = 86_400_000;
const CN_OFFSET_MS = 8 * 3_600_000;

function parse(d: string): number {
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, day);
}

const fmt = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const addDays = (d: string, n: number): string => fmt(parse(d) + n * DAY_MS);

export const diffDays = (a: string, b: string): number => Math.round((parse(b) - parse(a)) / DAY_MS);

export function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

export const todayCN = (now: Date): string => fmt(now.getTime() + CN_OFFSET_MS);

export const dayStartCN = (d: string): Date => new Date(parse(d) - CN_OFFSET_MS);

export const formatDateTimeCN = (t: Date): string =>
  new Date(t.getTime() + CN_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');

export function previousWeek(today: string): [string, string] {
  const dow = new Date(parse(today)).getUTCDay();
  const monday = addDays(today, -((dow + 6) % 7));
  return [addDays(monday, -7), addDays(monday, -1)];
}
```

`src/lib/money.ts`：

```ts
export function splitEvenly(totalCents: number, n: number, index: number): number {
  const base = Math.floor(totalCents / n);
  return base + (index < totalCents - base * n ? 1 : 0);
}

export const centsToYuan = (cents: number): string => (cents / 100).toFixed(2);

export function yuanToCents(s: string): number | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

export const commissionOf = (grossCents: number, bps: number): number => Math.round((grossCents * bps) / 10_000);
```

**Step 8: 运行，确认通过**

Run: `cd apps/server && pnpm vitest run src/lib`
Expected: PASS（10 tests）

Run（项目根）：`pnpm fix && pnpm check`
Expected: Biome 无错误，tsc 无错误，测试全绿。

**Step 9: Commit**

```bash
cd /data/workspace/ngr/wx/LiaoYu
git add .nvmrc package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc biome.json .gitignore deploy apps/server
git commit -m "chore: pnpm 工作区、工具链、开发数据库与日期金额工具"
```

---

### Task 2: 配置、时钟、错误与字段加密

**Files:**
- Create: `src/config.ts`、`src/lib/clock.ts`、`src/lib/errors.ts`、`src/lib/crypto.ts`
- Test: `src/config.test.ts`、`src/lib/crypto.test.ts`

**规则：** 配置用 Zod 校验环境变量，启动即失败。生产环境必须显式配置 `JWT_SECRET`、`FIELD_KEY`、`COOKIE_SECURE=true`、ZPAY 与微信参数——否则支付会落到 MOCK 收银台（任何人都能"模拟付款"），这是资金漏洞。

**Step 1: 写失败测试**

`src/config.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import { loadConfig } from './config.ts';

const PROD = {
  NODE_ENV: 'production',
  JWT_SECRET: 'x'.repeat(32),
  FIELD_KEY: Buffer.alloc(32, 7).toString('base64'),
  COOKIE_SECURE: 'true',
  ZPAY_PID: 'p',
  ZPAY_KEY: 'k',
  WX_APPID: 'wx1',
  WX_APPSECRET: 's',
};

describe('config', () => {
  test('开发默认值可直接使用', () => {
    const c = loadConfig({});
    expect(c.port).toBe(8700);
    expect(c.nodeEnv).toBe('development');
    expect(c.zpay.gateway).toBe('https://z-pay.cn');
    expect(c.cookieSecure).toBe(false);
  });

  test('PUBLIC_BASE_URL 去掉末尾斜杠', () => {
    expect(loadConfig({ PUBLIC_BASE_URL: 'https://a.com/' }).publicBaseUrl).toBe('https://a.com');
  });

  test('FIELD_KEY 必须是 32 字节 base64', () => {
    expect(() => loadConfig({ FIELD_KEY: 'abc' })).toThrow(/FIELD_KEY/);
  });

  test('生产环境缺少密钥或支付配置直接失败', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...PROD, ZPAY_KEY: '' })).toThrow(/ZPAY/);
    expect(() => loadConfig({ ...PROD, COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
  });

  test('生产环境配置齐全可启动', () => {
    expect(loadConfig(PROD).cookieSecure).toBe(true);
  });
});
```

`src/lib/crypto.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import { decryptField, encryptField } from './crypto.ts';

const KEY = Buffer.alloc(32, 9).toString('base64');
const OTHER = Buffer.alloc(32, 8).toString('base64');

describe('字段加密', () => {
  test('加密后可解密，且同一明文每次密文不同', () => {
    const a = encryptField(KEY, '林某');
    const b = encryptField(KEY, '林某');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1:')).toBe(true);
    expect(a).not.toContain('林某');
    expect(decryptField(KEY, a)).toBe('林某');
  });

  test('密文被篡改或密钥错误时解密失败', () => {
    const c = encryptField(KEY, '林某');
    const parts = c.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decryptField(KEY, parts.join(':'))).toThrow();
    expect(() => decryptField(OTHER, c)).toThrow();
  });
});
```

**Step 2: 运行，确认失败**

Run: `cd apps/server && pnpm vitest run src/config.test.ts src/lib/crypto.test.ts`
Expected: FAIL，模块不存在。

**Step 3: 实现**

`src/config.ts`：

```ts
import { z } from 'zod';

const DEV_JWT_SECRET = 'dev-jwt-secret-change-me';
const DEV_FIELD_KEY = Buffer.alloc(32, 1).toString('base64');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(8700),
    DATABASE_URL: z.string().min(1).default('postgres://liaoyu:liaoyu@localhost:54329/liaoyu'),
    PUBLIC_BASE_URL: z.url().default('http://localhost:8700'),
    JWT_SECRET: z.string().min(16).default(DEV_JWT_SECRET),
    FIELD_KEY: z
      .string()
      .refine((s) => Buffer.from(s, 'base64').length === 32, 'FIELD_KEY 必须是 32 字节的 base64')
      .default(DEV_FIELD_KEY),
    COOKIE_SECURE: z.stringbool().default(false),
    ZPAY_PID: z.string().default(''),
    ZPAY_KEY: z.string().default(''),
    ZPAY_GATEWAY: z.url().default('https://z-pay.cn'),
    WX_APPID: z.string().default(''),
    WX_APPSECRET: z.string().default(''),
  })
  .superRefine((e, ctx) => {
    if (e.NODE_ENV !== 'production') return;
    const need = (ok: boolean, key: string, message: string) => {
      if (!ok) ctx.addIssue({ code: 'custom', path: [key], message });
    };
    need(e.JWT_SECRET !== DEV_JWT_SECRET, 'JWT_SECRET', '生产环境必须设置 JWT_SECRET');
    need(e.FIELD_KEY !== DEV_FIELD_KEY, 'FIELD_KEY', '生产环境必须设置 FIELD_KEY');
    need(e.COOKIE_SECURE, 'COOKIE_SECURE', '生产环境必须开启 COOKIE_SECURE');
    need(Boolean(e.ZPAY_PID && e.ZPAY_KEY), 'ZPAY_KEY', '生产环境必须配置 ZPAY_PID/ZPAY_KEY');
    need(Boolean(e.WX_APPID && e.WX_APPSECRET), 'WX_APPSECRET', '生产环境必须配置 WX_APPID/WX_APPSECRET');
  });

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const r = EnvSchema.safeParse(env);
  if (!r.success) throw new Error(`配置错误:\n${z.prettifyError(r.error)}`);
  const e = r.data;
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/+$/, ''),
    jwtSecret: e.JWT_SECRET,
    fieldKey: e.FIELD_KEY,
    cookieSecure: e.COOKIE_SECURE,
    zpay: { pid: e.ZPAY_PID, key: e.ZPAY_KEY, gateway: e.ZPAY_GATEWAY.replace(/\/+$/, '') },
    wx: { appid: e.WX_APPID, secret: e.WX_APPSECRET },
  };
}

export type Config = ReturnType<typeof loadConfig>;
```

`src/lib/clock.ts`：

```ts
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(iso: string): Clock {
  const t = new Date(iso).getTime();
  return { now: () => new Date(t) };
}
```

`src/lib/errors.ts`：

```ts
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}
```

`src/lib/crypto.ts`：

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';

export function encryptField(keyB64: string, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, Buffer.from(keyB64, 'base64'), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decryptField(keyB64: string, payload: string): string {
  const [version, iv, tag, data] = payload.split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('密文格式错误');
  const decipher = createDecipheriv(ALGO, Buffer.from(keyB64, 'base64'), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
```

**Step 4: 运行，确认通过**

Run: `cd apps/server && pnpm vitest run src/config.test.ts src/lib/crypto.test.ts`
Expected: PASS（7 tests）

Run（项目根）：`pnpm fix && pnpm check`

**Step 5: Commit**

```bash
git add apps/server/src
git commit -m "feat: 配置校验、时钟、错误类型与字段加密"
```

---

### Task 3: 数据库 schema、迁移与约束

**Files:**
- Create: `src/db/schema.ts`、`src/db/client.ts`、`src/db/migrate.ts`、`drizzle.config.ts`
- Create（生成）: `src/db/migrations/0000_init.sql`、`src/db/migrations/0001_constraints.sql`、`src/db/migrations/meta/*`
- Create: `tests/test-env.ts`、`tests/db-utils.ts`、`tests/global-setup.ts`、`tests/setup.ts`
- Modify: `vitest.config.ts`
- Test: `src/db/db.test.ts`

**要点：**
- 金额用 `bigint`（读出为 number）；业务日用 `date`（读出为 `'YYYY-MM-DD'` 字符串，避免时区换算）。
- 分段不重叠用 `EXCLUDE USING gist`；暂停分段不能有老师、其他分段必须有老师用 CHECK。
- 审计日志用触发器禁止 UPDATE/DELETE（不依赖数据库账号权限，开发与生产行为一致）。
- 测试库每次全量运行前重建 schema 并执行迁移；每个测试开始前 TRUNCATE 全部业务表。测试文件串行执行（`fileParallelism: false`）。
- Drizzle 0.44+ 会把数据库错误包一层，原始 pg 错误在 `cause` 里；测试用 `pgError()` 取出 `constraint`/`code`。

**Step 1: 写 schema**

`src/db/schema.ts`：

```ts
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

const money = (name: string) => bigint(name, { mode: 'number' });
const day = (name: string) => date(name, { mode: 'string' });
const tstz = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => tstz('created_at').notNull().defaultNow();
const id = () => integer('id').primaryKey().generatedAlwaysAsIdentity();

export const teacherStatus = pgEnum('teacher_status', ['pending', 'active', 'rejected', 'disabled']);
export const packageType = pgEnum('package_type', ['single', 'month', 'quarter', 'year']);
export const orderStatus = pgEnum('order_status', ['pending', 'paid']);
export const relationStatus = pgEnum('relation_status', ['active', 'ended', 'refunded', 'switched']);
export const segmentKind = pgEnum('segment_kind', ['normal', 'substitute', 'paused']);
export const settlementStatus = pgEnum('settlement_status', ['pending', 'paid']);

export type TeacherStatus = (typeof teacherStatus.enumValues)[number];
export type PackageType = (typeof packageType.enumValues)[number];

export interface PackageSnapshot {
  type: PackageType;
  title: string;
  priceCents: number;
  days: number;
  callQuota: number;
  replyHours: number;
}

export const users = pgTable('users', {
  id: id(),
  openid: text('openid').notNull().unique(),
  nickname: text('nickname').notNull().default(''),
  createdAt: createdAt(),
});

export const admins = pgTable('admins', {
  id: id(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: createdAt(),
});

export const adminSessions = pgTable('admin_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  adminId: integer('admin_id')
    .notNull()
    .references(() => admins.id, { onDelete: 'cascade' }),
  expiresAt: tstz('expires_at').notNull(),
  createdAt: createdAt(),
});

export const auditLogs = pgTable('audit_logs', {
  id: id(),
  adminId: integer('admin_id').references(() => admins.id),
  action: text('action').notNull(),
  target: text('target').notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
});

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
});

export const teacherProfiles = pgTable(
  'teacher_profiles',
  {
    userId: integer('user_id')
      .primaryKey()
      .references(() => users.id),
    displayName: text('display_name').notNull(),
    realNameEnc: text('real_name_enc').notNull(),
    intro: text('intro').notNull().default(''),
    directions: text('directions').array().notNull().default(sql`'{}'::text[]`),
    credentials: text('credentials').array().notNull().default(sql`'{}'::text[]`),
    level: integer('level').notNull().default(0),
    status: teacherStatus('status').notNull().default('pending'),
    createdAt: createdAt(),
    reviewedAt: tstz('reviewed_at'),
  },
  (t) => [check('teacher_level_range', sql`${t.level} BETWEEN 0 AND 5`)],
);

export const packages = pgTable(
  'packages',
  {
    id: id(),
    teacherId: integer('teacher_id')
      .notNull()
      .references(() => users.id),
    type: packageType('type').notNull(),
    title: text('title').notNull(),
    priceCents: money('price_cents').notNull(),
    days: integer('days').notNull(),
    callQuota: integer('call_quota').notNull().default(0),
    replyHours: integer('reply_hours').notNull().default(24),
    onSale: boolean('on_sale').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [check('package_price_positive', sql`${t.priceCents} > 0`), index('packages_teacher_idx').on(t.teacherId)],
);

export const orders = pgTable(
  'orders',
  {
    id: id(),
    outTradeNo: text('out_trade_no').notNull().unique(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    teacherId: integer('teacher_id')
      .notNull()
      .references(() => users.id),
    packageId: integer('package_id')
      .notNull()
      .references(() => packages.id),
    packageSnapshot: jsonb('package_snapshot').$type<PackageSnapshot>().notNull(),
    amountCents: money('amount_cents').notNull(),
    payProvider: text('pay_provider').notNull(),
    status: orderStatus('status').notNull().default('pending'),
    tradeNo: text('trade_no'),
    paidAt: tstz('paid_at'),
    createdAt: createdAt(),
  },
  (t) => [index('orders_user_idx').on(t.userId), index('orders_teacher_idx').on(t.teacherId)],
);

export const serviceRelations = pgTable(
  'service_relations',
  {
    id: id(),
    orderId: integer('order_id')
      .notNull()
      .unique()
      .references(() => orders.id),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    teacherId: integer('teacher_id')
      .notNull()
      .references(() => users.id),
    packageType: packageType('package_type').notNull(),
    amountCents: money('amount_cents').notNull(),
    totalDays: integer('total_days').notNull(),
    startDate: day('start_date').notNull(),
    endDate: day('end_date').notNull(),
    callsLeft: integer('calls_left').notNull().default(0),
    replyHours: integer('reply_hours').notNull().default(24),
    status: relationStatus('status').notNull().default('active'),
    frozen: boolean('frozen').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('relations_user_teacher_idx').on(t.userId, t.teacherId),
    index('relations_teacher_idx').on(t.teacherId),
    check('relation_dates', sql`${t.endDate} >= ${t.startDate}`),
  ],
);

export const serviceSegments = pgTable(
  'service_segments',
  {
    id: id(),
    relationId: integer('relation_id')
      .notNull()
      .references(() => serviceRelations.id, { onDelete: 'cascade' }),
    kind: segmentKind('kind').notNull(),
    teacherId: integer('teacher_id').references(() => users.id),
    startDate: day('start_date').notNull(),
    endDate: day('end_date').notNull(),
  },
  (t) => [
    index('segments_relation_idx').on(t.relationId),
    check('segment_dates', sql`${t.endDate} >= ${t.startDate}`),
    check('segment_teacher', sql`(${t.kind} = 'paused') = (${t.teacherId} IS NULL)`),
  ],
);

export const settlements = pgTable(
  'settlements',
  {
    id: id(),
    teacherId: integer('teacher_id')
      .notNull()
      .references(() => users.id),
    periodStart: day('period_start').notNull(),
    periodEnd: day('period_end').notNull(),
    grossCents: money('gross_cents').notNull(),
    commissionBps: integer('commission_bps').notNull(),
    commissionCents: money('commission_cents').notNull(),
    netCents: money('net_cents').notNull(),
    status: settlementStatus('status').notNull().default('pending'),
    proof: text('proof'),
    operatorId: integer('operator_id').references(() => admins.id),
    paidAt: tstz('paid_at'),
    createdAt: createdAt(),
  },
  (t) => [index('settlements_teacher_idx').on(t.teacherId)],
);

export const accruals = pgTable(
  'accruals',
  {
    id: id(),
    relationId: integer('relation_id')
      .notNull()
      .references(() => serviceRelations.id),
    date: day('date').notNull(),
    teacherId: integer('teacher_id')
      .notNull()
      .references(() => users.id),
    amountCents: money('amount_cents').notNull(),
    settlementId: integer('settlement_id').references(() => settlements.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('accruals_relation_date_uq').on(t.relationId, t.date),
    index('accruals_teacher_date_idx').on(t.teacherId, t.date),
  ],
);
```

`drizzle.config.ts`：

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
});
```

**Step 2: 生成迁移**

```bash
cd /data/workspace/ngr/wx/LiaoYu/apps/server
pnpm drizzle-kit generate --name init
pnpm drizzle-kit generate --custom --name constraints
```

Expected: 生成 `src/db/migrations/0000_init.sql` 与空的 `0001_constraints.sql`。打开 `0000_init.sql` 核对：包含 12 张表、6 个枚举类型、上述 CHECK 与索引。

把 `src/db/migrations/0001_constraints.sql` 的内容替换为：

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "service_segments" ADD CONSTRAINT "service_segments_no_overlap"
  EXCLUDE USING gist ("relation_id" WITH =, daterange("start_date", "end_date", '[]') WITH &&);
--> statement-breakpoint
CREATE FUNCTION audit_logs_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_update_delete BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();
```

**Step 3: 数据库客户端与迁移**

`src/db/client.ts`：

```ts
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema.ts';

// int8 → number：金额以分存储，远小于 2^53
pg.types.setTypeParser(20, (v: string) => Number(v));
// date → 'YYYY-MM-DD' 原样字符串，避免按本地时区换算
pg.types.setTypeParser(1082, (v: string) => v);

export function createDb(url: string, max = 10) {
  return drizzle(new pg.Pool({ connectionString: url, max }), { schema });
}

export type Db = ReturnType<typeof createDb>;

/** 服务函数一律接收 DbOrTx：既可传连接池，也可传事务 */
export type DbOrTx = PgDatabase<NodePgQueryResultHKT, typeof schema>;
```

`src/db/migrate.ts`：

```ts
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Db } from './client.ts';

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('./migrations', import.meta.url)) });
}
```

**Step 4: 测试数据库夹具**

`tests/test-env.ts`：

```ts
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://liaoyu:liaoyu@localhost:54329/liaoyu_test';
```

`tests/db-utils.ts`：

```ts
import { createDb, type Db } from '../src/db/client.ts';
import { TEST_DATABASE_URL } from './test-env.ts';

let shared: Db | undefined;

export function testDb(): Db {
  shared ??= createDb(TEST_DATABASE_URL, 10);
  return shared;
}

export async function closeTestDb(): Promise<void> {
  if (!shared) return;
  const db = shared;
  shared = undefined;
  await db.$client.end();
}

export async function resetDb(db: Db): Promise<void> {
  const { rows } = await db.$client.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  );
  if (rows.length === 0) return;
  await db.$client.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

export interface PgErrorInfo {
  code?: string;
  constraint?: string;
  message: string;
}

/** 断言 Promise 被数据库拒绝，并返回原始 pg 错误（兼容 Drizzle 的错误包装） */
export async function pgError(p: PromiseLike<unknown>): Promise<PgErrorInfo> {
  try {
    await p;
  } catch (e) {
    const inner = e instanceof Error && e.cause instanceof Error ? e.cause : e;
    return inner as PgErrorInfo;
  }
  throw new Error('预期数据库报错，但执行成功');
}
```

`tests/global-setup.ts`：

```ts
import { createDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { TEST_DATABASE_URL } from './test-env.ts';

export default async function globalSetup(): Promise<void> {
  const db = createDb(TEST_DATABASE_URL, 1);
  try {
    await db.$client.query(
      'DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;',
    );
    await runMigrations(db);
  } finally {
    await db.$client.end();
  }
}
```

`tests/setup.ts`：

```ts
import { afterAll } from 'vitest';
import { closeTestDb } from './db-utils.ts';

afterAll(closeTestDb);
```

`vitest.config.ts` 改为：

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    fileParallelism: false,
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup.ts'],
  },
});
```

**Step 5: 写失败测试**

`src/db/db.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import { pgError, resetDb, testDb } from '../../tests/db-utils.ts';
import { accruals, auditLogs, orders, packages, serviceRelations, serviceSegments, users } from './schema.ts';

async function seedRelation() {
  const db = testDb();
  await resetDb(db);
  const [t] = await db.insert(users).values({ openid: 't' }).returning();
  const [u] = await db.insert(users).values({ openid: 'u' }).returning();
  const [p] = await db
    .insert(packages)
    .values({ teacherId: t.id, type: 'month', title: '包月', priceCents: 3000, days: 30 })
    .returning();
  const [o] = await db
    .insert(orders)
    .values({
      outTradeNo: 'O1',
      userId: u.id,
      teacherId: t.id,
      packageId: p.id,
      packageSnapshot: { type: 'month', title: '包月', priceCents: 3000, days: 30, callQuota: 0, replyHours: 24 },
      amountCents: 3000,
      payProvider: 'zpay',
    })
    .returning();
  const [r] = await db
    .insert(serviceRelations)
    .values({
      orderId: o.id,
      userId: u.id,
      teacherId: t.id,
      packageType: 'month',
      amountCents: 3000,
      totalDays: 30,
      startDate: '2026-11-01',
      endDate: '2026-11-30',
    })
    .returning();
  return { db, teacherId: t.id, relationId: r.id };
}

describe('数据库约束', () => {
  test('迁移后包含全部业务表', async () => {
    const { rows } = await testDb().$client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    const names = rows.map((r) => r.tablename);
    for (const t of [
      'users',
      'admins',
      'admin_sessions',
      'audit_logs',
      'settings',
      'teacher_profiles',
      'packages',
      'orders',
      'service_relations',
      'service_segments',
      'settlements',
      'accruals',
    ]) {
      expect(names).toContain(t);
    }
  });

  test('同一服务关系的分段日期不得重叠', async () => {
    const { db, teacherId, relationId } = await seedRelation();
    const seg = (startDate: string, endDate: string) =>
      db.insert(serviceSegments).values({ relationId, kind: 'normal', teacherId, startDate, endDate });
    await seg('2026-11-01', '2026-11-10');
    expect((await pgError(seg('2026-11-10', '2026-11-15'))).constraint).toBe('service_segments_no_overlap');
    await seg('2026-11-11', '2026-11-15');
  });

  test('暂停分段不能有老师，其他分段必须有老师', async () => {
    const { db, teacherId, relationId } = await seedRelation();
    const base = { relationId, startDate: '2026-11-01', endDate: '2026-11-02' };
    expect(
      (await pgError(db.insert(serviceSegments).values({ ...base, kind: 'paused', teacherId }))).constraint,
    ).toBe('segment_teacher');
    expect(
      (await pgError(db.insert(serviceSegments).values({ ...base, kind: 'normal', teacherId: null }))).constraint,
    ).toBe('segment_teacher');
  });

  test('计提按 (relation_id, date) 唯一', async () => {
    const { db, teacherId, relationId } = await seedRelation();
    const row = { relationId, date: '2026-11-01', teacherId, amountCents: 100 };
    await db.insert(accruals).values(row);
    expect((await pgError(db.insert(accruals).values(row))).constraint).toBe('accruals_relation_date_uq');
  });

  test('审计日志只能追加', async () => {
    const db = testDb();
    await resetDb(db);
    await db.insert(auditLogs).values({ action: 'x', target: 'y' });
    expect((await pgError(db.update(auditLogs).set({ action: 'z' }))).message).toMatch(/append-only/);
    expect((await pgError(db.delete(auditLogs))).message).toMatch(/append-only/);
  });

  test('bigint 金额读出为 number，date 读出为字符串', async () => {
    const { db } = await seedRelation();
    const [r] = await db.select().from(serviceRelations);
    expect(r.amountCents).toBe(3000);
    expect(r.startDate).toBe('2026-11-01');
  });
});
```

**Step 6: 运行，确认通过**

（schema 与迁移已在前面步骤写好，这里直接验证约束是否生效。若想看到失败，可先注释掉 `0001_constraints.sql` 里的排他约束再跑一次。）

Run: `cd apps/server && pnpm vitest run src/db`
Expected: PASS（6 tests）

Run（项目根）：`pnpm fix && pnpm check`

**Step 7: Commit**

```bash
git add apps/server
git commit -m "feat: PostgreSQL schema、迁移、数据库约束与测试夹具"
```

---

### Task 4: 应用骨架与测试夹具

**Files:**
- Create: `src/deps.ts`、`src/app.ts`、`src/routes.ts`、`tests/helpers.ts`
- Test: `src/app.test.ts`

**要点：** `buildApp(deps)` 不监听端口，测试用 `app.inject()`。错误统一为 `{ error }`：`HttpError` → 对应状态码；Zod 校验失败 → 400；Fastify 自身的 4xx（如 JSON 解析失败）原样返回；其余 500 且不泄露细节。非生产环境暴露 `/api/openapi.json`，供第三、四阶段生成前端类型。

**Step 1: 写失败测试**

`src/app.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { call, setup } from '../tests/helpers.ts';
import { HttpError } from './lib/errors.ts';

describe('应用骨架', () => {
  test('GET /api/health', async () => {
    const ctx = await setup();
    const res = await call(ctx, 'GET', '/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  test('HttpError 返回对应状态码', async () => {
    const ctx = await setup();
    ctx.app.get('/t/teapot', async () => {
      throw new HttpError(418, '茶壶');
    });
    const res = await call(ctx, 'GET', '/t/teapot');
    expect(res.statusCode).toBe(418);
    expect(res.json()).toEqual({ error: '茶壶' });
  });

  test('Zod 校验失败返回 400', async () => {
    const ctx = await setup();
    ctx.app.post('/t/echo', { schema: { body: z.object({ n: z.number().int() }) } }, async (req) => ({ n: req.body.n }));
    expect((await call(ctx, 'POST', '/t/echo', { body: { n: 1.5 } })).statusCode).toBe(400);
    expect((await call(ctx, 'POST', '/t/echo', { body: { n: 2 } })).json()).toEqual({ n: 2 });
  });

  test('未知异常返回 500 且不泄露细节', async () => {
    const ctx = await setup();
    ctx.app.get('/t/boom', async () => {
      throw new Error('secret detail');
    });
    const res = await call(ctx, 'GET', '/t/boom');
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: '服务器错误' });
  });

  test('非生产环境暴露 OpenAPI', async () => {
    const ctx = await setup();
    const res = await call(ctx, 'GET', '/api/openapi.json');
    expect(res.json().paths).toHaveProperty('/api/health');
  });
});
```

**Step 2: 运行，确认失败**

Run: `cd apps/server && pnpm vitest run src/app.test.ts`
Expected: FAIL，找不到 `../tests/helpers.ts`。

**Step 3: 实现**

`src/deps.ts`：

```ts
import type { Config } from './config.ts';
import type { DbOrTx } from './db/client.ts';
import type { Clock } from './lib/clock.ts';

export interface BaseDeps {
  config: Config;
  clock: Clock;
  db: DbOrTx;
}

export type Deps = BaseDeps;

export function createDeps(base: BaseDeps): Deps {
  return { ...base };
}
```

`src/routes.ts`：

```ts
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Deps } from './deps.ts';

export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export async function registerRoutes(app: App, deps: Deps): Promise<void> {
  // 后续 Task 在此注册业务模块
}
```

`src/app.ts`：

```ts
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

  await registerRoutes(app, deps);
  return app;
}
```

`tests/helpers.ts`（后续 Task 会追加函数）：

```ts
import { buildApp } from '../src/app.ts';
import { type Config, loadConfig } from '../src/config.ts';
import type { DbOrTx } from '../src/db/client.ts';
import { packages, type TeacherStatus, teacherProfiles, users } from '../src/db/schema.ts';
import { createDeps } from '../src/deps.ts';
import { fixedClock } from '../src/lib/clock.ts';
import { encryptField } from '../src/lib/crypto.ts';
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
```

**Step 4: 运行，确认通过**

Run: `cd apps/server && pnpm vitest run src/app.test.ts`
Expected: PASS（5 tests）

Run（项目根）：`pnpm fix && pnpm check`

**Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: Fastify 应用骨架、统一错误处理、OpenAPI 与测试夹具"
```

---

### Task 5: 微信登录与用户鉴权

**Files:**
- Create: `src/providers/wechat.ts`、`src/modules/auth/tokens.ts`、`src/modules/auth/guards.ts`、`src/modules/auth/routes.ts`
- Modify: `src/deps.ts`、`src/routes.ts`、`tests/helpers.ts`（追加 `loginUser`）
- Test: `src/modules/auth/auth.test.ts`

**规则：** 未配置 `WX_APPID/WX_APPSECRET` 时走 MOCK（openid = `mock_` + sha1(code) 前 24 位）。用户 JWT 用 HS256，`typ=user`，有效期 30 天；签发与校验都用注入的时钟。

**Step 1: 写失败测试**

`src/modules/auth/auth.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import { call, loginUser, setup } from '../../../tests/helpers.ts';
import { buildApp } from '../../app.ts';
import { createDeps } from '../../deps.ts';
import { fixedClock } from '../../lib/clock.ts';

describe('微信登录与用户鉴权', () => {
  test('同一 code 登录得到同一用户（MOCK）', async () => {
    const ctx = await setup();
    const a = await loginUser(ctx, 'code-1');
    const b = await loginUser(ctx, 'code-1');
    expect(a.token).toBeTruthy();
    expect(a.userId).toBe(b.userId);
  });

  test('缺少 code 返回 400', async () => {
    const ctx = await setup();
    expect((await call(ctx, 'POST', '/api/auth/wxlogin', { body: {} })).statusCode).toBe(400);
  });

  test('/me 需要登录，返回用户与老师身份', async () => {
    const ctx = await setup();
    expect((await call(ctx, 'GET', '/api/auth/me')).statusCode).toBe(401);
    const { token, userId } = await loginUser(ctx, 'code-1');
    const res = await call(ctx, 'GET', '/api/auth/me', { token });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(userId);
    expect(res.json().teacher).toBeNull();
  });

  test('篡改或过期的 token 返回 401', async () => {
    const ctx = await setup();
    const { token } = await loginUser(ctx, 'code-1');
    expect((await call(ctx, 'GET', '/api/auth/me', { token: `${token}x` })).statusCode).toBe(401);

    const later = await buildApp(createDeps({ ...ctx.deps, clock: fixedClock('2026-12-02T04:00:00Z') }));
    expect((await call({ app: later }, 'GET', '/api/auth/me', { token })).statusCode).toBe(401);
  });
});
```

**Step 2: 运行，确认失败**

Run: `cd apps/server && pnpm vitest run src/modules/auth`
Expected: FAIL，`loginUser` 不存在。

**Step 3: 实现**

`src/providers/wechat.ts`：

```ts
import { createHash } from 'node:crypto';
import { HttpError } from '../lib/errors.ts';

export interface Wechat {
  readonly isMock: boolean;
  code2Session(code: string): Promise<{ openid: string }>;
}

export function createWechat(cfg: { appid: string; secret: string }): Wechat {
  const isMock = !cfg.appid || !cfg.secret;
  return {
    isMock,
    async code2Session(code) {
      if (isMock) {
        return { openid: `mock_${createHash('sha1').update(`mock:${code}`).digest('hex').slice(0, 24)}` };
      }
      const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
      url.search = new URLSearchParams({
        appid: cfg.appid,
        secret: cfg.secret,
        js_code: code,
        grant_type: 'authorization_code',
      }).toString();
      const data = (await (await fetch(url)).json()) as { openid?: string; errcode?: number; errmsg?: string };
      if (!data.openid) throw new HttpError(401, `微信登录失败: ${data.errmsg ?? data.errcode ?? '未知错误'}`);
      return { openid: data.openid };
    },
  };
}
```

`src/modules/auth/tokens.ts`：

```ts
import { jwtVerify, SignJWT } from 'jose';
import type { Config } from '../../config.ts';
import type { Clock } from '../../lib/clock.ts';

const USER_TTL_SEC = 30 * 86_400;
const keyOf = (config: Config) => new TextEncoder().encode(config.jwtSecret);

export async function signUserToken(config: Config, clock: Clock, userId: number): Promise<string> {
  const iat = Math.floor(clock.now().getTime() / 1000);
  return new SignJWT({ typ: 'user' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(userId))
    .setIssuedAt(iat)
    .setExpirationTime(iat + USER_TTL_SEC)
    .sign(keyOf(config));
}

export async function verifyUserToken(config: Config, clock: Clock, token: string): Promise<number> {
  const { payload } = await jwtVerify(token, keyOf(config), { algorithms: ['HS256'], currentDate: clock.now() });
  if (payload.typ !== 'user' || !payload.sub) throw new Error('token 类型错误');
  return Number(payload.sub);
}
```

`src/modules/auth/guards.ts`：

```ts
import type { FastifyRequest } from 'fastify';
import type { Deps } from '../../deps.ts';
import { HttpError } from '../../lib/errors.ts';
import { verifyUserToken } from './tokens.ts';

export function userGuard(deps: Deps) {
  return async (req: FastifyRequest): Promise<void> => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!m) throw new HttpError(401, '未登录');
    try {
      req.userId = await verifyUserToken(deps.config, deps.clock, m[1]);
    } catch {
      throw new HttpError(401, '登录已失效');
    }
  };
}
```

`src/modules/auth/routes.ts`：

```ts
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { teacherProfiles, users } from '../../db/schema.ts';
import type { Deps } from '../../deps.ts';
import { userGuard } from './guards.ts';
import { signUserToken } from './tokens.ts';

export const authRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.post('/wxlogin', { schema: { body: z.object({ code: z.string().min(1) }) } }, async (req) => {
      const { openid } = await deps.wechat.code2Session(req.body.code);
      const [user] = await deps.db
        .insert(users)
        .values({ openid })
        .onConflictDoUpdate({ target: users.openid, set: { openid } })
        .returning({ id: users.id, nickname: users.nickname });
      return { token: await signUserToken(deps.config, deps.clock, user.id), user };
    });

    app.get('/me', { preHandler: userGuard(deps) }, async (req) => {
      const [user] = await deps.db
        .select({ id: users.id, nickname: users.nickname })
        .from(users)
        .where(eq(users.id, req.userId));
      const [teacher] = await deps.db
        .select({ status: teacherProfiles.status, level: teacherProfiles.level, displayName: teacherProfiles.displayName })
        .from(teacherProfiles)
        .where(eq(teacherProfiles.userId, req.userId));
      return { user, teacher: teacher ?? null };
    });
  };
```

`src/deps.ts` 改为：

```ts
import type { Config } from './config.ts';
import type { DbOrTx } from './db/client.ts';
import type { Clock } from './lib/clock.ts';
import { createWechat, type Wechat } from './providers/wechat.ts';

export interface BaseDeps {
  config: Config;
  clock: Clock;
  db: DbOrTx;
}

export interface Deps extends BaseDeps {
  wechat: Wechat;
}

export function createDeps(base: BaseDeps): Deps {
  return { ...base, wechat: createWechat(base.config.wx) };
}
```

`src/routes.ts` 顶部加 `import { authRoutes } from './modules/auth/routes.ts';`，`registerRoutes` 内加：

```ts
  await app.register(authRoutes(deps), { prefix: '/api/auth' });
```

`tests/helpers.ts` 末尾追加：

```ts
export async function loginUser(ctx: Ctx, code: string): Promise<{ token: string; userId: number }> {
  const res = await call(ctx, 'POST', '/api/auth/wxlogin', { body: { code } });
  const body = res.json();
  return { token: body.token, userId: body.user.id };
}
```

**Step 4: 运行，确认通过**

Run: `cd apps/server && pnpm vitest run src/modules/auth`
Expected: PASS（4 tests）

Run（项目根）：`pnpm fix && pnpm check`

**Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: 微信登录（含 MOCK）与用户 JWT 鉴权"
```

---

### Task 6: 管理员登录（会话 Cookie）、审计日志与建号脚本

**Files:**
- Create: `src/lib/audit.ts`、`src/modules/admin/service.ts`、`src/modules/admin/guard.ts`、`src/modules/admin/routes.ts`、`src/scripts/create-admin.ts`
- Modify: `src/routes.ts`、`tests/helpers.ts`（追加 `adminCookie`）
- Test: `src/modules/admin/admin.test.ts`

**规则：**
- 密码用 argon2id 哈希。会话令牌为 32 字节随机数，库里只存 sha256；有效期 12 小时；登出即删除，可随时强制下线。
- Cookie：`ly_admin`，`HttpOnly`、`SameSite=Strict`、`Path=/api/admin`，生产环境加 `Secure`。
- 登录成功写审计日志 `admin.login`。

**Step 1: 写失败测试**

`src/modules/admin/admin.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import { adminCookie, call, loginUser, setup } from '../../../tests/helpers.ts';
import { buildApp } from '../../app.ts';
import { auditLogs } from '../../db/schema.ts';
import { createDeps } from '../../deps.ts';
import { fixedClock } from '../../lib/clock.ts';
import { ADMIN_COOKIE, upsertAdmin } from './service.ts';

describe('管理员登录', () => {
  test('密码错误返回 401', async () => {
    const ctx = await setup();
    await upsertAdmin(ctx.db, 'boss', 'password-123');
    const res = await call(ctx, 'POST', '/api/admin/login', { body: { username: 'boss', password: 'wrong' } });
    expect(res.statusCode).toBe(401);
  });

  test('登录下发安全 Cookie，凭 Cookie 访问 /me', async () => {
    const ctx = await setup();
    await upsertAdmin(ctx.db, 'boss', 'password-123');
    const login = await call(ctx, 'POST', '/api/admin/login', { body: { username: 'boss', password: 'password-123' } });
    expect(login.statusCode).toBe(200);
    const c = login.cookies.find((x) => x.name === ADMIN_COOKIE);
    expect(c?.httpOnly).toBe(true);
    expect(c?.sameSite).toBe('Strict');
    expect(c?.path).toBe('/api/admin');

    const me = await call(ctx, 'GET', '/api/admin/me', { cookie: `${ADMIN_COOKIE}=${c?.value}` });
    expect(me.json().username).toBe('boss');
  });

  test('用户 token 不能访问管理接口', async () => {
    const ctx = await setup();
    const { token } = await loginUser(ctx, 'u1');
    expect((await call(ctx, 'GET', '/api/admin/me', { token })).statusCode).toBe(401);
  });

  test('登出后会话失效', async () => {
    const ctx = await setup();
    const cookie = await adminCookie(ctx);
    await call(ctx, 'POST', '/api/admin/logout', { cookie });
    expect((await call(ctx, 'GET', '/api/admin/me', { cookie })).statusCode).toBe(401);
  });

  test('会话 12 小时后过期', async () => {
    const ctx = await setup();
    const cookie = await adminCookie(ctx);
    const later = await buildApp(createDeps({ ...ctx.deps, clock: fixedClock('2026-11-01T16:00:01Z') }));
    expect((await call({ app: later }, 'GET', '/api/admin/me', { cookie })).statusCode).toBe(401);
  });

  test('登录写审计日志', async () => {
    const ctx = await setup();
    await adminCookie(ctx);
    const logs = await ctx.db.select().from(auditLogs);
    expect(logs.map((l) => l.action)).toEqual(['admin.login']);
  });
});
```

**Step 2: 运行，确认失败**

Run: `cd apps/server && pnpm vitest run src/modules/admin`
Expected: FAIL，模块不存在。

**Step 3: 实现**

`src/lib/audit.ts`：

```ts
import type { DbOrTx } from '../db/client.ts';
import { auditLogs } from '../db/schema.ts';

export interface AuditEntry {
  adminId: number | null;
  action: string;
  target: string;
  detail?: Record<string, unknown>;
}

export async function audit(db: DbOrTx, e: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({ adminId: e.adminId, action: e.action, target: e.target, detail: e.detail ?? {} });
}
```

`src/modules/admin/service.ts`：

```ts
import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { and, eq, gt } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { adminSessions, admins } from '../../db/schema.ts';

export const ADMIN_COOKIE = 'ly_admin';
export const SESSION_TTL_MS = 12 * 3_600_000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function upsertAdmin(db: DbOrTx, username: string, password: string): Promise<number> {
  const passwordHash = await hash(password);
  const [a] = await db
    .insert(admins)
    .values({ username, passwordHash })
    .onConflictDoUpdate({ target: admins.username, set: { passwordHash } })
    .returning({ id: admins.id });
  return a.id;
}

export async function verifyAdminLogin(
  db: DbOrTx,
  username: string,
  password: string,
): Promise<{ id: number; username: string } | null> {
  const [a] = await db.select().from(admins).where(eq(admins.username, username));
  if (!a || !(await verify(a.passwordHash, password))) return null;
  return { id: a.id, username: a.username };
}

export async function createSession(db: DbOrTx, now: Date, adminId: number): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db
    .insert(adminSessions)
    .values({ tokenHash: sha256(token), adminId, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) });
  return token;
}

export async function resolveSession(db: DbOrTx, now: Date, token: string): Promise<number | null> {
  const [s] = await db
    .select({ adminId: adminSessions.adminId })
    .from(adminSessions)
    .where(and(eq(adminSessions.tokenHash, sha256(token)), gt(adminSessions.expiresAt, now)));
  return s?.adminId ?? null;
}

export async function deleteSession(db: DbOrTx, token: string): Promise<void> {
  await db.delete(adminSessions).where(eq(adminSessions.tokenHash, sha256(token)));
}
```

`src/modules/admin/guard.ts`：

```ts
import type { FastifyRequest } from 'fastify';
import type { Deps } from '../../deps.ts';
import { HttpError } from '../../lib/errors.ts';
import { ADMIN_COOKIE, resolveSession } from './service.ts';

export function adminGuard(deps: Deps) {
  return async (req: FastifyRequest): Promise<void> => {
    const token = req.cookies[ADMIN_COOKIE];
    const adminId = token ? await resolveSession(deps.db, deps.clock.now(), token) : null;
    if (!adminId) throw new HttpError(401, '未登录或登录已过期');
    req.adminId = adminId;
  };
}
```

`src/modules/admin/routes.ts`：

```ts
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { admins } from '../../db/schema.ts';
import type { Deps } from '../../deps.ts';
import { audit } from '../../lib/audit.ts';
import { HttpError } from '../../lib/errors.ts';
import { adminGuard } from './guard.ts';
import { ADMIN_COOKIE, createSession, deleteSession, SESSION_TTL_MS, verifyAdminLogin } from './service.ts';

export const adminAuthRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.post(
      '/login',
      { schema: { body: z.object({ username: z.string().min(1), password: z.string().min(1) }) } },
      async (req, reply) => {
        const admin = await verifyAdminLogin(deps.db, req.body.username, req.body.password);
        if (!admin) throw new HttpError(401, '账号或密码错误');
        const token = await createSession(deps.db, deps.clock.now(), admin.id);
        await audit(deps.db, { adminId: admin.id, action: 'admin.login', target: `admin:${admin.id}`, detail: { ip: req.ip } });
        reply.setCookie(ADMIN_COOKIE, token, {
          httpOnly: true,
          sameSite: 'strict',
          secure: deps.config.cookieSecure,
          path: '/api/admin',
          maxAge: SESSION_TTL_MS / 1000,
        });
        return admin;
      },
    );

    app.post('/logout', async (req, reply) => {
      const token = req.cookies[ADMIN_COOKIE];
      if (token) await deleteSession(deps.db, token);
      reply.clearCookie(ADMIN_COOKIE, { path: '/api/admin' });
      return { ok: true };
    });

    app.get('/me', { preHandler: adminGuard(deps) }, async (req) => {
      const [a] = await deps.db
        .select({ id: admins.id, username: admins.username })
        .from(admins)
        .where(eq(admins.id, req.adminId));
      return a;
    });
  };
```

`src/scripts/create-admin.ts`：

```ts
import { loadConfig } from '../config.ts';
import { createDb } from '../db/client.ts';
import { runMigrations } from '../db/migrate.ts';
import { upsertAdmin } from '../modules/admin/service.ts';

const [username, password] = process.argv.slice(2);
if (!username || !password || password.length < 10) {
  console.error('用法: pnpm -F @liaoyu/server create-admin <用户名> <密码(至少10位)>');
  process.exit(1);
}

const db = createDb(loadConfig().databaseUrl, 1);
try {
  await runMigrations(db);
  await upsertAdmin(db, username, password);
  console.log(`管理员 ${username} 已创建/更新`);
} finally {
  await db.$client.end();
}
```

`src/routes.ts` 加 `import { adminAuthRoutes } from './modules/admin/routes.ts';`，并注册：

```ts
  await app.register(adminAuthRoutes(deps), { prefix: '/api/admin' });
```

`tests/helpers.ts` 顶部加 `import { ADMIN_COOKIE, upsertAdmin } from '../src/modules/admin/service.ts';`，末尾追加：

```ts
export async function adminCookie(ctx: Ctx, username = 'boss', password = 'password-123'): Promise<string> {
  await upsertAdmin(ctx.db, username, password);
  const res = await call(ctx, 'POST', '/api/admin/login', { body: { username, password } });
  const c = res.cookies.find((x) => x.name === ADMIN_COOKIE);
  if (!c) throw new Error(`管理员登录失败: ${res.body}`);
  return `${c.name}=${c.value}`;
}
```

**Step 4: 运行，确认通过**

Run: `cd apps/server && pnpm vitest run src/modules/admin`
Expected: PASS（6 tests）

Run（项目根）：`pnpm fix && pnpm check`

**Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: 管理员会话登录、审计日志与建号脚本"
```

---

### Task 7: 老师入驻申请与管理员审核定级

**Files:**
- Create: `src/lib/zod.ts`、`src/modules/teachers/service.ts`、`src/modules/teachers/routes.ts`、`src/modules/teachers/admin-routes.ts`
- Modify: `src/routes.ts`
- Test: `src/modules/teachers/apply.test.ts`

**规则：**
- 真实姓名用 `FIELD_KEY` 加密后入库，只有管理端列表解密展示。
- 已有申请且状态不是 `rejected` 时再次申请 → 409；被拒后可重新申请。用一条 `INSERT ... ON CONFLICT DO UPDATE ... WHERE status = 'rejected'` 完成，并发安全。
- 审核：通过须给初始等级 1~3；只能审核 `pending` 状态；审核与审计日志在同一事务内。

**Step 1: 写失败测试**

`src/modules/teachers/apply.test.ts`：

```ts
import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { adminCookie, call, loginUser, setup } from '../../../tests/helpers.ts';
import { auditLogs, teacherProfiles } from '../../db/schema.ts';

const APPLY = { displayName: '小林老师', realName: '林某', intro: '十年情感咨询', directions: ['情感'], credentials: ['证书A'] };

describe('老师入驻与审核', () => {
  test('入驻申请 → 待审核，重复申请 409', async () => {
    const ctx = await setup();
    const { token } = await loginUser(ctx, 't1');
    const r1 = await call(ctx, 'POST', '/api/teacher/apply', { token, body: APPLY });
    expect(r1.statusCode).toBe(201);
    expect(r1.json().status).toBe('pending');
    expect((await call(ctx, 'POST', '/api/teacher/apply', { token, body: APPLY })).statusCode).toBe(409);
  });

  test('缺少擅长方向返回 400', async () => {
    const ctx = await setup();
    const { token } = await loginUser(ctx, 't1');
    const res = await call(ctx, 'POST', '/api/teacher/apply', { token, body: { ...APPLY, directions: [] } });
    expect(res.statusCode).toBe(400);
  });

  test('真实姓名加密入库', async () => {
    const ctx = await setup();
    const { token, userId } = await loginUser(ctx, 't1');
    await call(ctx, 'POST', '/api/teacher/apply', { token, body: APPLY });
    const [row] = await ctx.db.select().from(teacherProfiles).where(eq(teacherProfiles.userId, userId));
    expect(row.realNameEnc.startsWith('v1:')).toBe(true);
    expect(row.realNameEnc).not.toContain('林某');
  });

  test('管理员审核通过并定级，写审计日志', async () => {
    const ctx = await setup();
    const { token, userId } = await loginUser(ctx, 't1');
    await call(ctx, 'POST', '/api/teacher/apply', { token, body: APPLY });
    const cookie = await adminCookie(ctx);

    const list = await call(ctx, 'GET', '/api/admin/teachers', { cookie, query: { status: 'pending' } });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].userId).toBe(userId);
    expect(list.json()[0].realName).toBe('林某');
    expect(list.json()[0].realNameEnc).toBeUndefined();

    const url = `/api/admin/teachers/${userId}/review`;
    expect((await call(ctx, 'POST', url, { cookie, body: { approve: true, level: 4 } })).statusCode).toBe(400);
    const ok = await call(ctx, 'POST', url, { cookie, body: { approve: true, level: 3 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'active', level: 3 });
    expect((await call(ctx, 'POST', url, { cookie, body: { approve: true, level: 3 } })).statusCode).toBe(409);

    const me = await call(ctx, 'GET', '/api/auth/me', { token });
    expect(me.json().teacher.status).toBe('active');

    const logs = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, 'teacher.approve'));
    expect(logs).toHaveLength(1);
  });

  test('被拒绝后可重新申请；审核不存在的申请 404', async () => {
    const ctx = await setup();
    const { token, userId } = await loginUser(ctx, 't1');
    await call(ctx, 'POST', '/api/teacher/apply', { token, body: APPLY });
    const cookie = await adminCookie(ctx);
    await call(ctx, 'POST', `/api/admin/teachers/${userId}/review`, { cookie, body: { approve: false } });
    expect((await call(ctx, 'POST', '/api/teacher/apply', { token, body: APPLY })).statusCode).toBe(201);
    expect((await call(ctx, 'POST', '/api/admin/teachers/999/review', { cookie, body: { approve: false } })).statusCode).toBe(
      404,
    );
  });
});
```

**Step 2: 运行，确认失败**

Run: `cd apps/server && pnpm vitest run src/modules/teachers`
Expected: FAIL（404）

**Step 3: 实现**

`src/lib/zod.ts`：

```ts
import { z } from 'zod';

export const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
export const IdParam = z.coerce.number().int().positive();
```

`src/modules/teachers/service.ts`：

```ts
import { and, asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { type TeacherStatus, teacherProfiles } from '../../db/schema.ts';
import type { Clock } from '../../lib/clock.ts';
import { decryptField, encryptField } from '../../lib/crypto.ts';
import { HttpError } from '../../lib/errors.ts';

export interface ApplyInput {
  displayName: string;
  realName: string;
  intro: string;
  directions: string[];
  credentials: string[];
}

export async function applyTeacher(db: DbOrTx, fieldKey: string, userId: number, input: ApplyInput): Promise<void> {
  const values = {
    displayName: input.displayName,
    realNameEnc: encryptField(fieldKey, input.realName),
    intro: input.intro,
    directions: input.directions,
    credentials: input.credentials,
    status: 'pending' as const,
    reviewedAt: null,
  };
  const rows = await db
    .insert(teacherProfiles)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: teacherProfiles.userId, set: values, setWhere: eq(teacherProfiles.status, 'rejected') })
    .returning({ userId: teacherProfiles.userId });
  if (rows.length === 0) throw new HttpError(409, '已提交过入驻申请');
}

export async function requireActiveTeacher(db: DbOrTx, userId: number): Promise<{ level: number }> {
  const [t] = await db
    .select({ level: teacherProfiles.level, status: teacherProfiles.status })
    .from(teacherProfiles)
    .where(eq(teacherProfiles.userId, userId));
  if (!t || t.status !== 'active') throw new HttpError(403, '仅已认证老师可操作');
  return { level: t.level };
}

export async function listTeachersForAdmin(db: DbOrTx, fieldKey: string, status?: TeacherStatus) {
  const rows = await db
    .select()
    .from(teacherProfiles)
    .where(status ? eq(teacherProfiles.status, status) : undefined)
    .orderBy(asc(teacherProfiles.createdAt), asc(teacherProfiles.userId));
  return rows.map(({ realNameEnc, ...rest }) => ({ ...rest, realName: decryptField(fieldKey, realNameEnc) }));
}

export async function reviewTeacher(
  db: DbOrTx,
  clock: Clock,
  userId: number,
  d: { approve: boolean; level?: number },
) {
  if (d.approve && (d.level === undefined || d.level < 1 || d.level > 3)) throw new HttpError(400, '初始等级须为 1~3');
  const set = d.approve
    ? { status: 'active' as const, level: d.level, reviewedAt: clock.now() }
    : { status: 'rejected' as const, reviewedAt: clock.now() };
  const [row] = await db
    .update(teacherProfiles)
    .set(set)
    .where(and(eq(teacherProfiles.userId, userId), eq(teacherProfiles.status, 'pending')))
    .returning({ userId: teacherProfiles.userId, status: teacherProfiles.status, level: teacherProfiles.level });
  if (row) return row;
  const [exists] = await db
    .select({ userId: teacherProfiles.userId })
    .from(teacherProfiles)
    .where(eq(teacherProfiles.userId, userId));
  throw exists ? new HttpError(409, '该申请不在待审核状态') : new HttpError(404, '申请不存在');
}
```

`src/modules/teachers/routes.ts`：

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { userGuard } from '../auth/guards.ts';
import { applyTeacher } from './service.ts';

const ApplyBody = z.object({
  displayName: z.string().trim().min(1).max(30),
  realName: z.string().trim().min(1).max(30),
  intro: z.string().max(2000).default(''),
  directions: z.array(z.string().trim().min(1)).min(1).max(5),
  credentials: z.array(z.string().trim().min(1)).max(10).default([]),
});

export const teacherRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.addHook('preHandler', userGuard(deps));

    app.post('/apply', { schema: { body: ApplyBody } }, async (req, reply) => {
      await applyTeacher(deps.db, deps.config.fieldKey, req.userId, req.body);
      return reply.status(201).send({ status: 'pending' });
    });
  };
```

`src/modules/teachers/admin-routes.ts`：

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { teacherStatus } from '../../db/schema.ts';
import type { Deps } from '../../deps.ts';
import { audit } from '../../lib/audit.ts';
import { IdParam } from '../../lib/zod.ts';
import { adminGuard } from '../admin/guard.ts';
import { listTeachersForAdmin, reviewTeacher } from './service.ts';

export const adminTeacherRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.addHook('preHandler', adminGuard(deps));

    app.get(
      '/',
      { schema: { querystring: z.object({ status: z.enum(teacherStatus.enumValues).optional() }) } },
      async (req) => listTeachersForAdmin(deps.db, deps.config.fieldKey, req.query.status),
    );

    app.post(
      '/:userId/review',
      {
        schema: {
          params: z.object({ userId: IdParam }),
          body: z.object({ approve: z.boolean(), level: z.number().int().optional() }),
        },
      },
      async (req) =>
        deps.db.transaction(async (tx) => {
          const row = await reviewTeacher(tx, deps.clock, req.params.userId, req.body);
          await audit(tx, {
            adminId: req.adminId,
            action: req.body.approve ? 'teacher.approve' : 'teacher.reject',
            target: `teacher:${req.params.userId}`,
            detail: { level: req.body.level ?? null },
          });
          return row;
        }),
    );
  };
```

`src/routes.ts` 加 import 并注册：

```ts
  await app.register(teacherRoutes(deps), { prefix: '/api/teacher' });
  await app.register(adminTeacherRoutes(deps), { prefix: '/api/admin/teachers' });
```

**Step 4: 运行，确认通过**

Run: `cd apps/server && pnpm vitest run src/modules/teachers`
Expected: PASS（5 tests）

Run（项目根）：`pnpm fix && pnpm check`

**Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: 老师入驻申请（实名加密）与管理员审核定级"
```

---

### Task 8: 老师套餐管理

**Files:**
- Create: `src/modules/packages/service.ts`、`src/modules/packages/routes.ts`
- Modify: `src/routes.ts`
- Test: `src/modules/packages/packages.test.ts`

**规则：** 类型 single/month/quarter/year 对应有效天数 0/30/90/365；single 强制 `callQuota = 1`；year 仅 L3 及以上；价格为正整数（分）；只能改自己的套餐，改别人的返回 404。

**Step 1: 写失败测试**

`src/modules/packages/packages.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import { type Ctx, call, loginUser, makeTeacherProfile, setup } from '../../../tests/helpers.ts';

async function teacher(ctx: Ctx, code: string, level: number) {
  const u = await loginUser(ctx, code);
  await makeTeacherProfile(ctx.db, u.userId, { level });
  return u;
}

const PKG_URL = '/api/teacher/packages';

describe('老师套餐', () => {
  test('非老师不能建套餐', async () => {
    const ctx = await setup();
    const { token } = await loginUser(ctx, 'u1');
    const res = await call(ctx, 'POST', PKG_URL, { token, body: { type: 'month', title: '包月', priceCents: 3000 } });
    expect(res.statusCode).toBe(403);
  });

  test('建包月套餐，天数自动为 30', async () => {
    const ctx = await setup();
    const t = await teacher(ctx, 't1', 2);
    const res = await call(ctx, 'POST', PKG_URL, {
      token: t.token,
      body: { type: 'month', title: '包月', priceCents: 3000, callQuota: 4, replyHours: 12 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ days: 30, callQuota: 4, replyHours: 12, onSale: true });
  });

  test('单次套餐通话次数强制为 1', async () => {
    const ctx = await setup();
    const t = await teacher(ctx, 't1', 1);
    const res = await call(ctx, 'POST', PKG_URL, {
      token: t.token,
      body: { type: 'single', title: '单次', priceCents: 500, callQuota: 9 },
    });
    expect(res.json().callQuota).toBe(1);
  });

  test('年包仅 L3 及以上', async () => {
    const ctx = await setup();
    const low = await teacher(ctx, 't1', 2);
    const high = await teacher(ctx, 't2', 3);
    const body = { type: 'year', title: '包年', priceCents: 300000 };
    expect((await call(ctx, 'POST', PKG_URL, { token: low.token, body })).statusCode).toBe(403);
    expect((await call(ctx, 'POST', PKG_URL, { token: high.token, body })).statusCode).toBe(201);
  });

  test('价格非法返回 400', async () => {
    const ctx = await setup();
    const t = await teacher(ctx, 't1', 2);
    const res = await call(ctx, 'POST', PKG_URL, { token: t.token, body: { type: 'month', title: '包月', priceCents: 12.5 } });
    expect(res.statusCode).toBe(400);
  });

  test('下架自己的套餐；不能改别人的套餐；空修改 400', async () => {
    const ctx = await setup();
    const a = await teacher(ctx, 't1', 2);
    const b = await teacher(ctx, 't2', 2);
    const created = await call(ctx, 'POST', PKG_URL, {
      token: a.token,
      body: { type: 'month', title: '包月', priceCents: 3000 },
    });
    const id = created.json().id;
    const off = await call(ctx, 'PATCH', `${PKG_URL}/${id}`, { token: a.token, body: { onSale: false } });
    expect(off.json().onSale).toBe(false);
    expect((await call(ctx, 'PATCH', `${PKG_URL}/${id}`, { token: b.token, body: { onSale: true } })).statusCode).toBe(404);
    expect((await call(ctx, 'PATCH', `${PKG_URL}/${id}`, { token: a.token, body: {} })).statusCode).toBe(400);
    expect((await call(ctx, 'GET', PKG_URL, { token: a.token })).json()).toHaveLength(1);
  });
});
```

**Step 2: 运行，确认失败**

Run: `cd apps/server && pnpm vitest run src/modules/packages`
Expected: FAIL（404）

**Step 3: 实现**

`src/modules/packages/service.ts`：

```ts
import { and, asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { type PackageType, packages } from '../../db/schema.ts';
import { HttpError } from '../../lib/errors.ts';
import { requireActiveTeacher } from '../teachers/service.ts';

export const PACKAGE_DAYS: Record<PackageType, number> = { single: 0, month: 30, quarter: 90, year: 365 };

export interface CreatePackageInput {
  type: PackageType;
  title: string;
  priceCents: number;
  callQuota: number;
  replyHours: number;
}

export async function createPackage(db: DbOrTx, teacherId: number, input: CreatePackageInput) {
  const t = await requireActiveTeacher(db, teacherId);
  if (input.type === 'year' && t.level < 3) throw new HttpError(403, '年包仅 L3 及以上老师可开放');
  const [p] = await db
    .insert(packages)
    .values({
      teacherId,
      ...input,
      days: PACKAGE_DAYS[input.type],
      callQuota: input.type === 'single' ? 1 : input.callQuota,
    })
    .returning();
  return p;
}

export async function listOwnPackages(db: DbOrTx, teacherId: number) {
  await requireActiveTeacher(db, teacherId);
  return db.select().from(packages).where(eq(packages.teacherId, teacherId)).orderBy(asc(packages.id));
}

export async function updateOwnPackage(
  db: DbOrTx,
  teacherId: number,
  id: number,
  patch: { onSale?: boolean; priceCents?: number; title?: string },
) {
  await requireActiveTeacher(db, teacherId);
  const [p] = await db
    .update(packages)
    .set(patch)
    .where(and(eq(packages.id, id), eq(packages.teacherId, teacherId)))
    .returning();
  if (!p) throw new HttpError(404, '套餐不存在');
  return p;
}
```

`src/modules/packages/routes.ts`：

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { packageType } from '../../db/schema.ts';
import type { Deps } from '../../deps.ts';
import { IdParam } from '../../lib/zod.ts';
import { userGuard } from '../auth/guards.ts';
import { createPackage, listOwnPackages, updateOwnPackage } from './service.ts';

const Title = z.string().trim().min(1).max(50);
const Price = z.number().int().positive();

export const teacherPackageRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.addHook('preHandler', userGuard(deps));

    app.post(
      '/',
      {
        schema: {
          body: z.object({
            type: z.enum(packageType.enumValues),
            title: Title,
            priceCents: Price,
            callQuota: z.number().int().min(0).default(0),
            replyHours: z.number().int().positive().default(24),
          }),
        },
      },
      async (req, reply) => reply.status(201).send(await createPackage(deps.db, req.userId, req.body)),
    );

    app.get('/', async (req) => listOwnPackages(deps.db, req.userId));

    app.patch(
      '/:id',
      {
        schema: {
          params: z.object({ id: IdParam }),
          body: z
            .object({ onSale: z.boolean().optional(), priceCents: Price.optional(), title: Title.optional() })
            .refine((o) => Object.keys(o).length > 0, '至少修改一项'),
        },
      },
      async (req) => updateOwnPackage(deps.db, req.userId, req.params.id, req.body),
    );
  };
```

`src/routes.ts` 注册：

```ts
  await app.register(teacherPackageRoutes(deps), { prefix: '/api/teacher/packages' });
```

**Step 4: 运行，确认通过**

Run: `cd apps/server && pnpm vitest run src/modules/packages`
Expected: PASS（6 tests）

Run（项目根）：`pnpm fix && pnpm check`

**Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: 老师套餐管理"
```

---

### Task 9: 公开老师列表与详情

**Files:**
- Modify: `src/modules/teachers/service.ts`（追加公开查询）
- Create: `src/modules/teachers/public-routes.ts`
- Modify: `src/routes.ts`
- Test: `src/modules/teachers/public.test.ts`

**规则：** 只返回 `active` 老师，绝不返回实名字段；列表带最低在售价；可按方向、等级筛选；按等级降序、ID 升序。

**Step 1: 写失败测试**

`src/modules/teachers/public.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import { call, insertPackage, insertTeacher, setup } from '../../../tests/helpers.ts';

describe('公开老师列表与详情', () => {
  test('只返回已认证老师，含最低在售价，可按方向/等级筛选', async () => {
    const ctx = await setup();
    const a = await insertTeacher(ctx.db, 'a', { level: 3, directions: ['情感', '职业'] });
    const b = await insertTeacher(ctx.db, 'b', { level: 1, directions: ['健身'] });
    await insertTeacher(ctx.db, 'c', { status: 'pending' });
    await insertPackage(ctx.db, a, { priceCents: 3000 });
    await insertPackage(ctx.db, a, { type: 'single', days: 0, priceCents: 500 });
    await insertPackage(ctx.db, a, { type: 'single', days: 0, priceCents: 100, onSale: false });

    const all = (await call(ctx, 'GET', '/api/teachers')).json();
    expect(all.map((t: { id: number }) => t.id)).toEqual([a, b]);
    expect(all[0].minPriceCents).toBe(500);
    expect(all[0].directions).toEqual(['情感', '职业']);
    expect(all[0].realName).toBeUndefined();
    expect(all[0].realNameEnc).toBeUndefined();
    expect(all[1].minPriceCents).toBeNull();

    const byDir = (await call(ctx, 'GET', '/api/teachers', { query: { direction: '健身' } })).json();
    expect(byDir.map((t: { id: number }) => t.id)).toEqual([b]);

    const byLevel = (await call(ctx, 'GET', '/api/teachers', { query: { level: 3 } })).json();
    expect(byLevel.map((t: { id: number }) => t.id)).toEqual([a]);
  });

  test('详情只含在售套餐；未认证老师 404', async () => {
    const ctx = await setup();
    const a = await insertTeacher(ctx.db, 'a');
    const pending = await insertTeacher(ctx.db, 'p', { status: 'pending' });
    await insertPackage(ctx.db, a);
    await insertPackage(ctx.db, a, { onSale: false });

    const res = await call(ctx, 'GET', `/api/teachers/${a}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().packages).toHaveLength(1);
    expect((await call(ctx, 'GET', `/api/teachers/${pending}`)).statusCode).toBe(404);
  });
});
```

**Step 2: 运行，确认失败**

Run: `cd apps/server && pnpm vitest run src/modules/teachers/public.test.ts`
Expected: FAIL（404）

**Step 3: 实现**

`src/modules/teachers/service.ts`：把顶部 import 改为

```ts
import { and, arrayContains, asc, desc, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { packages, type TeacherStatus, teacherProfiles } from '../../db/schema.ts';
```

（其余 import 不变），并在文件末尾追加：

```ts
const minPriceCents = sql<number | null>`(
  SELECT MIN(${packages.priceCents}) FROM ${packages}
  WHERE ${packages.teacherId} = ${teacherProfiles.userId} AND ${packages.onSale}
)`;

const publicColumns = {
  id: teacherProfiles.userId,
  displayName: teacherProfiles.displayName,
  intro: teacherProfiles.intro,
  directions: teacherProfiles.directions,
  level: teacherProfiles.level,
  minPriceCents,
};

export async function listPublicTeachers(db: DbOrTx, f: { direction?: string; level?: number }) {
  return db
    .select(publicColumns)
    .from(teacherProfiles)
    .where(
      and(
        eq(teacherProfiles.status, 'active'),
        f.direction ? arrayContains(teacherProfiles.directions, [f.direction]) : undefined,
        f.level ? eq(teacherProfiles.level, f.level) : undefined,
      ),
    )
    .orderBy(desc(teacherProfiles.level), asc(teacherProfiles.userId));
}

export async function getPublicTeacher(db: DbOrTx, id: number) {
  const [t] = await db
    .select(publicColumns)
    .from(teacherProfiles)
    .where(and(eq(teacherProfiles.userId, id), eq(teacherProfiles.status, 'active')));
  if (!t) throw new HttpError(404, '老师不存在');
  const pkgs = await db
    .select({
      id: packages.id,
      type: packages.type,
      title: packages.title,
      priceCents: packages.priceCents,
      days: packages.days,
      callQuota: packages.callQuota,
      replyHours: packages.replyHours,
    })
    .from(packages)
    .where(and(eq(packages.teacherId, id), eq(packages.onSale, true)))
    .orderBy(asc(packages.priceCents));
  return { ...t, packages: pkgs };
}
```

`src/modules/teachers/public-routes.ts`：

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { IdParam } from '../../lib/zod.ts';
import { getPublicTeacher, listPublicTeachers } from './service.ts';

export const publicTeacherRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      '/',
      {
        schema: {
          querystring: z.object({
            direction: z.string().min(1).optional(),
            level: z.coerce.number().int().min(1).max(5).optional(),
          }),
        },
      },
      async (req) => listPublicTeachers(deps.db, req.query),
    );

    app.get('/:id', { schema: { params: z.object({ id: IdParam }) } }, async (req) =>
      getPublicTeacher(deps.db, req.params.id),
    );
  };
```

`src/routes.ts` 注册：

```ts
  await app.register(publicTeacherRoutes(deps), { prefix: '/api/teachers' });
```

**Step 4: 运行，确认通过**

Run: `cd apps/server && pnpm vitest run src/modules/teachers`
Expected: PASS（7 tests）

Run（项目根）：`pnpm fix && pnpm check`

**Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: 公开老师列表与详情"
```

---

### Task 10: 支付抽象与 ZPAY

**Files:**
- Create: `src/providers/payment/types.ts`、`src/providers/payment/zpay.ts`
- Modify: `src/deps.ts`
- Test: `src/providers/payment/zpay.test.ts`

参考：`/data/workspace/ngr/wx/divination/server/zpay.js`（只借鉴签名规则：过滤空值与 `sign/sign_type` → 按键名排序 → `k=v&...` → 拼接 key 后 md5）。区别：配置注入、固定支付宝、验签用定长比较、校验 `pid`、金额严格解析、MOCK 模式拒绝一切回调。

**Step 1: 写失败测试**

`src/providers/payment/zpay.test.ts`：

```ts
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { buildSignStr, createZPayProvider, zpaySign } from './zpay.ts';

const CFG = { pid: 'p1', key: 'k1', gateway: 'https://z-pay.cn', publicBaseUrl: 'http://h' };
const signed = (p: Record<string, string>, key = 'k1') => ({ ...p, sign: zpaySign(p, key), sign_type: 'MD5' });
const BASE = { pid: 'p1', trade_no: 'Z1', out_trade_no: 'O1', type: 'alipay', name: '包月', trade_status: 'TRADE_SUCCESS' };

describe('ZPAY', () => {
  test('未配置 pid/key 为 MOCK：链接指向本地模拟收银台，且拒绝一切回调', () => {
    const z = createZPayProvider({ ...CFG, key: '' });
    expect(z.isMock).toBe(true);
    expect(z.payUrl({ outTradeNo: 'O1', amountCents: 3000, subject: 'x' })).toBe('http://h/api/pay/mock?out_trade_no=O1');
    expect(z.parseNotify(signed({ ...BASE, money: '30.00' }, '')).kind).toBe('invalid');
  });

  test('待签名串：过滤空值与 sign/sign_type，按键名排序', () => {
    expect(buildSignStr({ b: '2', a: '1', sign: 'x', sign_type: 'MD5', c: '' })).toBe('a=1&b=2');
  });

  test('签名 = md5(signStr + key)', () => {
    const p = { pid: 'p1', out_trade_no: 'O1', money: '30.00' };
    const expected = createHash('md5').update(`${buildSignStr(p)}k1`, 'utf8').digest('hex');
    expect(zpaySign(p, 'k1')).toBe(expected);
  });

  test('payUrl 指向 submit.php，含回调地址、中文标题与签名', () => {
    const url = createZPayProvider(CFG).payUrl({ outTradeNo: 'O1', amountCents: 3000, subject: '包月陪伴' });
    expect(url.startsWith('https://z-pay.cn/submit.php?')).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.get('type')).toBe('alipay');
    expect(q.get('money')).toBe('30.00');
    expect(q.get('name')).toBe('包月陪伴');
    expect(q.get('notify_url')).toBe('http://h/api/pay/zpay/notify');
    expect(q.get('sign_type')).toBe('MD5');
    const params = Object.fromEntries([...q].filter(([k]) => k !== 'sign' && k !== 'sign_type'));
    expect(q.get('sign')).toBe(zpaySign(params, 'k1'));
  });

  test('parseNotify：验签通过且成功 → paid', () => {
    expect(createZPayProvider(CFG).parseNotify(signed({ ...BASE, money: '30.00' }))).toEqual({
      kind: 'paid',
      outTradeNo: 'O1',
      tradeNo: 'Z1',
      paidCents: 3000,
    });
  });

  test('parseNotify：签名错误/篡改金额/pid 不符 → invalid；非成功状态 → ignored', () => {
    const z = createZPayProvider(CFG);
    const good = signed({ ...BASE, money: '30.00' });
    expect(z.parseNotify({ ...good, sign: 'x'.repeat(32) }).kind).toBe('invalid');
    expect(z.parseNotify({ ...good, money: '0.01' }).kind).toBe('invalid');
    expect(z.parseNotify(signed({ ...BASE, pid: 'p2', money: '30.00' })).kind).toBe('invalid');
    expect(z.parseNotify({ ...BASE, money: '30.00' }).kind).toBe('invalid');
    expect(z.parseNotify(signed({ ...BASE, money: '30.00', trade_status: 'WAIT' })).kind).toBe('ignored');
  });
});
```

**Step 2: 运行，确认失败**

Run: `cd apps/server && pnpm vitest run src/providers/payment`
Expected: FAIL，模块不存在。

**Step 3: 实现**

`src/providers/payment/types.ts`：

```ts
export interface PayRequest {
  outTradeNo: string;
  amountCents: number;
  subject: string;
}

export type NotifyResult =
  | { kind: 'invalid' }
  | { kind: 'ignored' }
  | { kind: 'paid'; outTradeNo: string; tradeNo: string; paidCents: number };

export interface PaymentProvider {
  readonly name: string;
  readonly isMock: boolean;
  payUrl(req: PayRequest): string;
  parseNotify(params: Record<string, unknown>): NotifyResult;
}
```

`src/providers/payment/zpay.ts`：

```ts
import { createHash, timingSafeEqual } from 'node:crypto';
import { centsToYuan, yuanToCents } from '../../lib/money.ts';
import type { NotifyResult, PaymentProvider, PayRequest } from './types.ts';

export interface ZPayConfig {
  pid: string;
  key: string;
  gateway: string;
  publicBaseUrl: string;
}

export function buildSignStr(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

export const zpaySign = (params: Record<string, string>, key: string): string =>
  createHash('md5').update(buildSignStr(params) + key, 'utf8').digest('hex');

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function toStringRecord(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) if (typeof v === 'string') out[k] = v;
  return out;
}

export function createZPayProvider(cfg: ZPayConfig): PaymentProvider {
  const isMock = !cfg.pid || !cfg.key;

  return {
    name: 'zpay',
    isMock,

    payUrl({ outTradeNo, amountCents, subject }: PayRequest): string {
      if (isMock) return `${cfg.publicBaseUrl}/api/pay/mock?out_trade_no=${encodeURIComponent(outTradeNo)}`;
      const params = {
        pid: cfg.pid,
        money: centsToYuan(amountCents),
        name: subject,
        notify_url: `${cfg.publicBaseUrl}/api/pay/zpay/notify`,
        out_trade_no: outTradeNo,
        return_url: `${cfg.publicBaseUrl}/api/pay/return`,
        sitename: 'LiaoYu',
        type: 'alipay',
      };
      const query = new URLSearchParams({ ...params, sign: zpaySign(params, cfg.key), sign_type: 'MD5' });
      return `${cfg.gateway}/submit.php?${query.toString()}`;
    },

    parseNotify(raw): NotifyResult {
      if (isMock) return { kind: 'invalid' };
      const p = toStringRecord(raw);
      if (!p.sign || !safeEqual(zpaySign(p, cfg.key), p.sign.toLowerCase())) return { kind: 'invalid' };
      if (p.pid !== cfg.pid) return { kind: 'invalid' };
      if (p.trade_status !== 'TRADE_SUCCESS') return { kind: 'ignored' };
      const paidCents = yuanToCents(p.money ?? '');
      if (paidCents === null || !p.out_trade_no) return { kind: 'invalid' };
      return { kind: 'paid', outTradeNo: p.out_trade_no, tradeNo: p.trade_no ?? '', paidCents };
    },
  };
}
```

`src/deps.ts` 改为：

```ts
import type { Config } from './config.ts';
import type { DbOrTx } from './db/client.ts';
import type { Clock } from './lib/clock.ts';
import type { PaymentProvider } from './providers/payment/types.ts';
import { createZPayProvider } from './providers/payment/zpay.ts';
import { createWechat, type Wechat } from './providers/wechat.ts';

export interface BaseDeps {
  config: Config;
  clock: Clock;
  db: DbOrTx;
}

export interface Deps extends BaseDeps {
  wechat: Wechat;
  payment: PaymentProvider;
}

export function createDeps(base: BaseDeps): Deps {
  return {
    ...base,
    wechat: createWechat(base.config.wx),
    payment: createZPayProvider({ ...base.config.zpay, publicBaseUrl: base.config.publicBaseUrl }),
  };
}
```

**Step 4: 运行，确认通过**

Run: `cd apps/server && pnpm vitest run src/providers/payment`
Expected: PASS（6 tests）

Run（项目根）：`pnpm fix && pnpm check`

**Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: PaymentProvider 抽象与 ZPAY 实现"
```

---

### Task 11: 服务分段纯函数

**Files:**
- Create: `src/domain/segments.ts`
- Test: `src/domain/segments.test.ts`

**思路：** 把分段展开成逐日数组 → 修改 → 重新压缩。代码最短、最不易错，内测规模下性能足够。`domain/` 只放纯函数，不碰数据库。

**Step 1: 写失败测试**

`src/domain/segments.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import { activeDayIndex, applyPause, applySubstitute, initialSegments, segmentOn } from './segments.ts';

const base = () => initialSegments(1, '2026-11-01', '2026-11-30');

describe('服务分段', () => {
  test('代班：中间插入代班分段', () => {
    expect(applySubstitute(base(), { from: '2026-11-10', to: '2026-11-12', teacherId: 2 })).toEqual([
      { kind: 'normal', teacherId: 1, startDate: '2026-11-01', endDate: '2026-11-09' },
      { kind: 'substitute', teacherId: 2, startDate: '2026-11-10', endDate: '2026-11-12' },
      { kind: 'normal', teacherId: 1, startDate: '2026-11-13', endDate: '2026-11-30' },
    ]);
  });

  test('暂停：插入暂停分段并整体顺延', () => {
    expect(applyPause(base(), { from: '2026-11-10', to: '2026-11-14' })).toEqual([
      { kind: 'normal', teacherId: 1, startDate: '2026-11-01', endDate: '2026-11-09' },
      { kind: 'paused', teacherId: null, startDate: '2026-11-10', endDate: '2026-11-14' },
      { kind: 'normal', teacherId: 1, startDate: '2026-11-15', endDate: '2026-12-05' },
    ]);
  });

  test('代班不覆盖暂停日', () => {
    const paused = applyPause(base(), { from: '2026-11-10', to: '2026-11-14' });
    const segs = applySubstitute(paused, { from: '2026-11-12', to: '2026-11-16', teacherId: 2 });
    expect(segs).toEqual([
      { kind: 'normal', teacherId: 1, startDate: '2026-11-01', endDate: '2026-11-09' },
      { kind: 'paused', teacherId: null, startDate: '2026-11-10', endDate: '2026-11-14' },
      { kind: 'substitute', teacherId: 2, startDate: '2026-11-15', endDate: '2026-11-16' },
      { kind: 'normal', teacherId: 1, startDate: '2026-11-17', endDate: '2026-12-05' },
    ]);
  });

  test('暂停起始日晚于服务期则报错', () => {
    expect(() => applyPause(base(), { from: '2026-12-01', to: '2026-12-02' })).toThrow();
  });

  test('segmentOn 与 activeDayIndex 跳过暂停日', () => {
    const segs = applyPause(base(), { from: '2026-11-10', to: '2026-11-14' });
    expect(segmentOn(segs, '2026-11-12')?.kind).toBe('paused');
    expect(segmentOn(segs, '2026-12-06')).toBeNull();
    expect(activeDayIndex(segs, '2026-11-01')).toBe(0);
    expect(activeDayIndex(segs, '2026-11-15')).toBe(9);
    expect(activeDayIndex(segs, '2026-12-05')).toBe(29);
  });
});
```

**Step 2: 运行，确认失败**

Run: `cd apps/server && pnpm vitest run src/domain`
Expected: FAIL

**Step 3: 实现**

`src/domain/segments.ts`：

```ts
import { addDays, diffDays, eachDay } from '../lib/dates.ts';

export type SegmentKind = 'normal' | 'substitute' | 'paused';

export interface Segment {
  kind: SegmentKind;
  teacherId: number | null;
  startDate: string;
  endDate: string;
}

interface Day {
  date: string;
  kind: SegmentKind;
  teacherId: number | null;
}

function expand(segments: readonly Segment[]): Day[] {
  return segments.flatMap((s) =>
    eachDay(s.startDate, s.endDate).map((date) => ({ date, kind: s.kind, teacherId: s.teacherId })),
  );
}

function compress(days: readonly Day[]): Segment[] {
  const out: Segment[] = [];
  for (const d of days) {
    const last = out.at(-1);
    if (last && last.kind === d.kind && last.teacherId === d.teacherId && addDays(last.endDate, 1) === d.date) {
      last.endDate = d.date;
    } else {
      out.push({ kind: d.kind, teacherId: d.teacherId, startDate: d.date, endDate: d.date });
    }
  }
  return out;
}

export const initialSegments = (teacherId: number, startDate: string, endDate: string): Segment[] => [
  { kind: 'normal', teacherId, startDate, endDate },
];

export function applySubstitute(
  segments: readonly Segment[],
  { from, to, teacherId }: { from: string; to: string; teacherId: number },
): Segment[] {
  return compress(
    expand(segments).map((d) =>
      d.date >= from && d.date <= to && d.kind === 'normal' ? { ...d, kind: 'substitute', teacherId } : d,
    ),
  );
}

export function applyPause(segments: readonly Segment[], { from, to }: { from: string; to: string }): Segment[] {
  const days = expand(segments);
  const idx = days.findIndex((d) => d.date >= from);
  if (idx === -1) throw new Error('暂停起始日不在服务期内');
  const paused: Omit<Day, 'date'>[] = Array.from({ length: diffDays(from, to) + 1 }, () => ({
    kind: 'paused',
    teacherId: null,
  }));
  const seq = [...days.slice(0, idx), ...paused, ...days.slice(idx)];
  const start = segments[0].startDate;
  return compress(seq.map((d, i) => ({ kind: d.kind, teacherId: d.teacherId, date: addDays(start, i) })));
}

export const segmentOn = (segments: readonly Segment[], date: string): Segment | null =>
  segments.find((s) => s.startDate <= date && date <= s.endDate) ?? null;

export function activeDayIndex(segments: readonly Segment[], date: string): number {
  let n = 0;
  for (const s of segments) {
    if (s.kind === 'paused') continue;
    if (s.endDate < date) n += diffDays(s.startDate, s.endDate) + 1;
    else if (s.startDate < date) n += diffDays(s.startDate, date);
  }
  return n;
}
```

**Step 4: 运行，确认通过**

Run: `cd apps/server && pnpm vitest run src/domain`
Expected: PASS（5 tests）

Run（项目根）：`pnpm fix && pnpm check`

**Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: 服务分段纯函数（代班/暂停顺延）"
```

---

### Task 12: 下单与履约服务（行锁、续费顺接、并发测试）

**Files:**
- Create: `src/modules/relations/service.ts`、`src/modules/orders/service.ts`
- Modify: `tests/helpers.ts`（追加 `buyAndPay`）
- Test: `src/modules/orders/service.test.ts`、`src/modules/relations/service.test.ts`

**规则：**
- 订单保存套餐快照；服务关系复制金额/天数/通话次数/回复时效。不能购买自己的套餐；套餐须在售且老师已认证。
- 履约在事务内：先 `SELECT ... FOR UPDATE` 锁订单行（重复回调串行化，只开通一次），再锁用户行（同一用户的并发续费串行化，避免两段服务重叠）。金额不符不履约。
- 周期套餐：同一用户对同一老师已有未到期的周期服务时，新服务从其结束日次日开始（续费顺接）。
- 单次套餐：有效期 30 天、通话 1 次、`totalDays = 0`（不参与日计提，第二阶段按通话计提）。
- 改写分段统一走 `rewriteSegments`：事务内锁服务关系行 → 读分段 → 纯函数改写 → 整体替换 → 同步 `endDate`。第二阶段请假/代班直接复用。

**Step 1: 写失败测试**

`tests/helpers.ts` 顶部加：

```ts
import { eq } from 'drizzle-orm';
import { serviceRelations } from '../src/db/schema.ts';
import { createOrder, fulfillOrder } from '../src/modules/orders/service.ts';
```

（`serviceRelations` 合并进已有的 schema import），末尾追加：

```ts
export async function buyAndPay(ctx: Ctx, userId: number, packageId: number) {
  const order = await createOrder(ctx.db, ctx.clock, { userId, packageId, provider: 'zpay' });
  await fulfillOrder(ctx.db, ctx.clock, order.outTradeNo, { tradeNo: 'T', paidCents: order.amountCents });
  const [rel] = await ctx.db.select().from(serviceRelations).where(eq(serviceRelations.orderId, order.id));
  return rel;
}
```

`src/modules/orders/service.test.ts`：

```ts
import { asc } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { insertPackage, insertTeacher, insertUser, setup } from '../../../tests/helpers.ts';
import { orders, serviceRelations } from '../../db/schema.ts';
import { loadSegments } from '../relations/service.ts';
import { createOrder, fulfillOrder } from './service.ts';

async function world() {
  const ctx = await setup();
  const teacher = await insertTeacher(ctx.db, 't');
  const user = await insertUser(ctx.db, 'u');
  const month = await insertPackage(ctx.db, teacher, { priceCents: 3000 });
  const single = await insertPackage(ctx.db, teacher, { type: 'single', days: 0, callQuota: 1, priceCents: 500 });
  const order = (packageId: number, userId = user) =>
    createOrder(ctx.db, ctx.clock, { userId, packageId, provider: 'zpay' });
  const pay = (outTradeNo: string, paidCents: number) =>
    fulfillOrder(ctx.db, ctx.clock, outTradeNo, { tradeNo: 'T1', paidCents });
  const relations = () => ctx.db.select().from(serviceRelations).orderBy(asc(serviceRelations.startDate));
  return { ctx, db: ctx.db, teacher, user, month, single, order, pay, relations };
}

describe('下单与履约', () => {
  test('创建订单保存快照与金额', async () => {
    const w = await world();
    const o = await w.order(w.month);
    expect(o.status).toBe('pending');
    expect(o.amountCents).toBe(3000);
    expect(o.teacherId).toBe(w.teacher);
    expect(o.packageSnapshot.type).toBe('month');
    expect(o.outTradeNo).toMatch(/^20261101120000\d{6}$/);
  });

  test('下架套餐、自己的套餐不能下单', async () => {
    const w = await world();
    const off = await insertPackage(w.db, w.teacher, { onSale: false });
    await expect(w.order(off)).rejects.toThrow(/下架/);
    await expect(w.order(w.month, w.teacher)).rejects.toThrow(/自己/);
  });

  test('履约创建服务关系与初始分段，且幂等', async () => {
    const w = await world();
    const o = await w.order(w.month);
    expect(await w.pay(o.outTradeNo, 3000)).toEqual({ ok: true, fulfilled: true });
    expect(await w.pay(o.outTradeNo, 3000)).toEqual({ ok: true, fulfilled: false });

    const rels = await w.relations();
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({
      startDate: '2026-11-01',
      endDate: '2026-11-30',
      totalDays: 30,
      callsLeft: 4,
      replyHours: 12,
    });
    expect(await loadSegments(w.db, rels[0].id)).toEqual([
      { kind: 'normal', teacherId: w.teacher, startDate: '2026-11-01', endDate: '2026-11-30' },
    ]);
  });

  test('金额不符不履约；订单不存在返回 not_found', async () => {
    const w = await world();
    const o = await w.order(w.month);
    expect(await w.pay(o.outTradeNo, 1)).toEqual({ ok: false, reason: 'amount_mismatch' });
    const [row] = await w.db.select().from(orders);
    expect(row.status).toBe('pending');
    expect(await w.pay('NOPE', 1)).toEqual({ ok: false, reason: 'not_found' });
  });

  test('续费顺接：第二个包月从上一个结束次日开始', async () => {
    const w = await world();
    for (let i = 0; i < 2; i++) {
      const o = await w.order(w.month);
      await w.pay(o.outTradeNo, 3000);
    }
    const rels = await w.relations();
    expect(rels[1]).toMatchObject({ startDate: '2026-12-01', endDate: '2026-12-30' });
  });

  test('单次套餐：有效 30 天、1 次通话、不参与日计提', async () => {
    const w = await world();
    const o = await w.order(w.single);
    await w.pay(o.outTradeNo, 500);
    const [rel] = await w.relations();
    expect(rel).toMatchObject({ totalDays: 0, callsLeft: 1, endDate: '2026-11-30' });
  });

  test('并发重复回调只开通一次', async () => {
    const w = await world();
    const o = await w.order(w.month);
    const rs = await Promise.all([1, 2, 3, 4].map(() => w.pay(o.outTradeNo, 3000)));
    expect(rs.filter((r) => r.ok && r.fulfilled)).toHaveLength(1);
    expect(await w.relations()).toHaveLength(1);
  });

  test('并发续费不会产生重叠的服务期', async () => {
    const w = await world();
    const a = await w.order(w.month);
    const b = await w.order(w.month);
    await Promise.all([w.pay(a.outTradeNo, 3000), w.pay(b.outTradeNo, 3000)]);
    const rels = await w.relations();
    expect(rels.map((r) => [r.startDate, r.endDate])).toEqual([
      ['2026-11-01', '2026-11-30'],
      ['2026-12-01', '2026-12-30'],
    ]);
  });
});
```

`src/modules/relations/service.test.ts`：

```ts
import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { buyAndPay, insertPackage, insertTeacher, insertUser, setup } from '../../../tests/helpers.ts';
import { serviceRelations } from '../../db/schema.ts';
import { applyPause, applySubstitute } from '../../domain/segments.ts';
import { loadSegments, rewriteSegments } from './service.ts';

describe('改写服务分段', () => {
  test('改写后同步服务关系结束日', async () => {
    const ctx = await setup();
    const t = await insertTeacher(ctx.db, 't');
    const rel = await buyAndPay(ctx, await insertUser(ctx.db, 'u'), await insertPackage(ctx.db, t));
    await rewriteSegments(ctx.db, rel.id, (s) => applyPause(s, { from: '2026-11-10', to: '2026-11-14' }));
    const [r] = await ctx.db.select().from(serviceRelations).where(eq(serviceRelations.id, rel.id));
    expect(r.endDate).toBe('2026-12-05');
  });

  test('并发改写串行执行，不丢失任何一次修改', async () => {
    const ctx = await setup();
    const t = await insertTeacher(ctx.db, 't');
    const sub = await insertTeacher(ctx.db, 's');
    const rel = await buyAndPay(ctx, await insertUser(ctx.db, 'u'), await insertPackage(ctx.db, t));
    await Promise.all([
      rewriteSegments(ctx.db, rel.id, (s) => applyPause(s, { from: '2026-11-10', to: '2026-11-14' })),
      rewriteSegments(ctx.db, rel.id, (s) => applySubstitute(s, { from: '2026-11-20', to: '2026-11-22', teacherId: sub })),
    ]);
    const segs = await loadSegments(ctx.db, rel.id);
    expect(segs.filter((s) => s.kind === 'paused')).toHaveLength(1);
    expect(segs.filter((s) => s.kind === 'substitute')).toHaveLength(1);
    expect(segs.at(-1)?.endDate).toBe('2026-12-05');
  });

  test('服务关系不存在返回 404', async () => {
    const ctx = await setup();
    await expect(rewriteSegments(ctx.db, 999, (s) => s)).rejects.toThrow(/不存在/);
  });
});
```

**Step 2: 运行，确认失败**

Run: `cd apps/server && pnpm vitest run src/modules/orders src/modules/relations`
Expected: FAIL，模块不存在。

**Step 3: 实现**

`src/modules/relations/service.ts`：

```ts
import { and, asc, eq, max, ne } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { type orders, serviceRelations, serviceSegments } from '../../db/schema.ts';
import { initialSegments, type Segment } from '../../domain/segments.ts';
import { addDays } from '../../lib/dates.ts';
import { HttpError } from '../../lib/errors.ts';

export const SINGLE_VALID_DAYS = 30;

type Order = typeof orders.$inferSelect;

export async function loadSegments(db: DbOrTx, relationId: number): Promise<Segment[]> {
  return db
    .select({
      kind: serviceSegments.kind,
      teacherId: serviceSegments.teacherId,
      startDate: serviceSegments.startDate,
      endDate: serviceSegments.endDate,
    })
    .from(serviceSegments)
    .where(eq(serviceSegments.relationId, relationId))
    .orderBy(asc(serviceSegments.startDate));
}

/** 调用方必须处于事务中，且已锁住该服务关系行 */
async function replaceSegments(tx: DbOrTx, relationId: number, segments: readonly Segment[]): Promise<void> {
  const last = segments.at(-1);
  if (!last) throw new Error('分段不能为空');
  await tx.delete(serviceSegments).where(eq(serviceSegments.relationId, relationId));
  await tx.insert(serviceSegments).values(segments.map((s) => ({ relationId, ...s })));
  await tx.update(serviceRelations).set({ endDate: last.endDate }).where(eq(serviceRelations.id, relationId));
}

export async function rewriteSegments(
  db: DbOrTx,
  relationId: number,
  change: (segments: Segment[]) => Segment[],
): Promise<Segment[]> {
  return db.transaction(async (tx) => {
    const [rel] = await tx
      .select({ id: serviceRelations.id })
      .from(serviceRelations)
      .where(eq(serviceRelations.id, relationId))
      .for('update');
    if (!rel) throw new HttpError(404, '服务关系不存在');
    const next = change(await loadSegments(tx, relationId));
    await replaceSegments(tx, relationId, next);
    return next;
  });
}

/** 调用方必须处于事务中，且已锁住该用户行（保证续费顺接不重叠） */
export async function createRelationForOrder(tx: DbOrTx, order: Order, today: string): Promise<number> {
  const snap = order.packageSnapshot;
  const isSingle = snap.type === 'single';
  let start = today;
  if (!isSingle) {
    const [row] = await tx
      .select({ last: max(serviceRelations.endDate) })
      .from(serviceRelations)
      .where(
        and(
          eq(serviceRelations.userId, order.userId),
          eq(serviceRelations.teacherId, order.teacherId),
          eq(serviceRelations.status, 'active'),
          ne(serviceRelations.packageType, 'single'),
        ),
      );
    if (row?.last && row.last >= today) start = addDays(row.last, 1);
  }
  const totalDays = isSingle ? 0 : snap.days;
  const end = addDays(start, (isSingle ? SINGLE_VALID_DAYS : totalDays) - 1);
  const [rel] = await tx
    .insert(serviceRelations)
    .values({
      orderId: order.id,
      userId: order.userId,
      teacherId: order.teacherId,
      packageType: snap.type,
      amountCents: order.amountCents,
      totalDays,
      startDate: start,
      endDate: end,
      callsLeft: snap.callQuota,
      replyHours: snap.replyHours,
    })
    .returning({ id: serviceRelations.id });
  await replaceSegments(tx, rel.id, initialSegments(order.teacherId, start, end));
  return rel.id;
}
```

`src/modules/orders/service.ts`：

```ts
import { randomInt } from 'node:crypto';
import { eq, getTableColumns } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { orders, type PackageSnapshot, packages, teacherProfiles, users } from '../../db/schema.ts';
import type { Clock } from '../../lib/clock.ts';
import { formatDateTimeCN, todayCN } from '../../lib/dates.ts';
import { HttpError } from '../../lib/errors.ts';
import { createRelationForOrder } from '../relations/service.ts';

export type Order = typeof orders.$inferSelect;

export type FulfillResult = { ok: true; fulfilled: boolean } | { ok: false; reason: 'not_found' | 'amount_mismatch' };

export function genOutTradeNo(now: Date): string {
  return `${formatDateTimeCN(now).replace(/\D/g, '')}${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
}

export async function getOrderByOutTradeNo(db: DbOrTx, outTradeNo: string): Promise<Order | undefined> {
  const [o] = await db.select().from(orders).where(eq(orders.outTradeNo, outTradeNo));
  return o;
}

export async function createOrder(
  db: DbOrTx,
  clock: Clock,
  input: { userId: number; packageId: number; provider: string },
): Promise<Order> {
  const [pkg] = await db
    .select({ ...getTableColumns(packages), teacherStatus: teacherProfiles.status })
    .from(packages)
    .innerJoin(teacherProfiles, eq(teacherProfiles.userId, packages.teacherId))
    .where(eq(packages.id, input.packageId));
  if (!pkg || !pkg.onSale || pkg.teacherStatus !== 'active') throw new HttpError(400, '套餐不存在或已下架');
  if (pkg.teacherId === input.userId) throw new HttpError(400, '不能购买自己的套餐');

  const snapshot: PackageSnapshot = {
    type: pkg.type,
    title: pkg.title,
    priceCents: pkg.priceCents,
    days: pkg.days,
    callQuota: pkg.callQuota,
    replyHours: pkg.replyHours,
  };
  const now = clock.now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const [order] = await db
      .insert(orders)
      .values({
        outTradeNo: genOutTradeNo(now),
        userId: input.userId,
        teacherId: pkg.teacherId,
        packageId: pkg.id,
        packageSnapshot: snapshot,
        amountCents: pkg.priceCents,
        payProvider: input.provider,
        createdAt: now,
      })
      .onConflictDoNothing({ target: orders.outTradeNo })
      .returning();
    if (order) return order;
  }
  throw new Error('生成订单号失败');
}

export async function fulfillOrder(
  db: DbOrTx,
  clock: Clock,
  outTradeNo: string,
  paid: { tradeNo: string; paidCents: number },
): Promise<FulfillResult> {
  return db.transaction(async (tx): Promise<FulfillResult> => {
    const [order] = await tx.select().from(orders).where(eq(orders.outTradeNo, outTradeNo)).for('update');
    if (!order) return { ok: false, reason: 'not_found' };
    if (order.status === 'paid') return { ok: true, fulfilled: false };
    if (paid.paidCents !== order.amountCents) return { ok: false, reason: 'amount_mismatch' };

    await tx.select({ id: users.id }).from(users).where(eq(users.id, order.userId)).for('update');
    const now = clock.now();
    await tx.update(orders).set({ status: 'paid', tradeNo: paid.tradeNo, paidAt: now }).where(eq(orders.id, order.id));
    await createRelationForOrder(tx, order, todayCN(now));
    return { ok: true, fulfilled: true };
  });
}
```

**Step 4: 运行，确认通过**

Run: `cd apps/server && pnpm vitest run src/modules/orders src/modules/relations`
Expected: PASS（11 tests）

验证锁确实起作用：临时注释掉 `fulfillOrder` 里锁用户行那一句，重跑，`并发续费不会产生重叠的服务期` 应 FAIL；恢复后再 PASS。

Run（项目根）：`pnpm fix && pnpm check`

**Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: 下单与履约（行锁、续费顺接、分段改写）"
```

---

### Task 13: 订单、支付回调与我的服务接口

**Files:**
- Create: `src/modules/orders/routes.ts`、`src/modules/pay/routes.ts`、`src/modules/relations/routes.ts`
- Modify: `src/modules/relations/service.ts`（追加列表查询）、`src/routes.ts`
- Test: `src/modules/orders/routes.test.ts`

**接口：**
- `POST /api/orders {packageId}` → 201 `{ outTradeNo, amountCents, payUrl, mock }`（小程序把 `payUrl` 复制到浏览器打开）
- `GET /api/orders/:outTradeNo` → 仅本人可查，`{ outTradeNo, status, paid, amountCents }`
- `GET|POST /api/pay/zpay/notify` → ZPAY 异步回调，返回纯文本 `success` / `fail`
- `GET /api/pay/return` → 浏览器同步回跳页，提示"返回小程序"
- `GET /api/pay/mock`、`POST /api/pay/mock/confirm` → 仅 MOCK 模式可用，否则 404
- `GET /api/relations` → 我购买的服务（含 `teacherName`）
- `GET /api/teacher/students` → 老师名下的服务关系（含 `userNickname`），非认证老师 403

**规则：** 回调结果 `invalid` → `fail`；`ignored`（非成功状态）→ `success`，避免 ZPAY 反复重发；履约失败（金额不符、订单不存在）→ `fail` 并记错误日志。HTML 页面中的动态内容一律转义。

**Step 1: 写失败测试**

`src/modules/orders/routes.test.ts`：

```ts
import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import {
  buyAndPay,
  call,
  insertPackage,
  insertTeacher,
  insertUser,
  loginUser,
  makeTeacherProfile,
  setup,
} from '../../../tests/helpers.ts';
import type { Config } from '../../config.ts';
import { orders, serviceRelations } from '../../db/schema.ts';
import { zpaySign } from '../../providers/payment/zpay.ts';

const ZPAY = { pid: 'p1', key: 'k1', gateway: 'https://z-pay.cn' };

async function world(config?: Partial<Config>) {
  const ctx = await setup({ config });
  const teacher = await insertTeacher(ctx.db, 't');
  const pkg = await insertPackage(ctx.db, teacher, { priceCents: 3000 });
  const { token } = await loginUser(ctx, 'u1');
  const createOrder = () => call(ctx, 'POST', '/api/orders', { token, body: { packageId: pkg } });
  return { ctx, teacher, pkg, token, createOrder };
}

describe('订单、支付回调与我的服务接口', () => {
  test('MOCK：下单 → 模拟确认 → 订单已付 → 我的服务出现', async () => {
    const w = await world();
    const created = await w.createOrder();
    expect(created.statusCode).toBe(201);
    const { outTradeNo, payUrl, ...rest } = created.json();
    expect(rest).toEqual({ amountCents: 3000, mock: true });
    expect(payUrl).toBe(`http://test.local/api/pay/mock?out_trade_no=${outTradeNo}`);

    const status = async () => (await call(w.ctx, 'GET', `/api/orders/${outTradeNo}`, { token: w.token })).json();
    expect((await status()).paid).toBe(false);

    const page = await call(w.ctx, 'GET', '/api/pay/mock', { query: { out_trade_no: outTradeNo } });
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.body).toContain('30.00');
    const confirm = await call(w.ctx, 'POST', '/api/pay/mock/confirm', { query: { out_trade_no: outTradeNo } });
    expect(confirm.statusCode).toBe(200);
    expect((await status()).paid).toBe(true);

    const rels = (await call(w.ctx, 'GET', '/api/relations', { token: w.token })).json();
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({ teacherId: w.teacher, teacherName: `老师${w.teacher}`, status: 'active' });
  });

  test('他人订单不可查', async () => {
    const w = await world();
    const { outTradeNo } = (await w.createOrder()).json();
    const other = await loginUser(w.ctx, 'u2');
    expect((await call(w.ctx, 'GET', `/api/orders/${outTradeNo}`, { token: other.token })).statusCode).toBe(404);
  });

  test('真实模式：返回 ZPAY 收银台链接，mock 接口不可用', async () => {
    const w = await world({ zpay: ZPAY });
    const { outTradeNo, payUrl, mock } = (await w.createOrder()).json();
    expect(mock).toBe(false);
    expect(payUrl.startsWith('https://z-pay.cn/submit.php?')).toBe(true);
    expect(new URL(payUrl).searchParams.get('notify_url')).toBe('http://test.local/api/pay/zpay/notify');
    expect((await call(w.ctx, 'GET', '/api/pay/mock', { query: { out_trade_no: outTradeNo } })).statusCode).toBe(404);
    expect((await call(w.ctx, 'POST', '/api/pay/mock/confirm', { query: { out_trade_no: outTradeNo } })).statusCode).toBe(
      404,
    );
  });

  test('notify：验签失败/金额不符 → fail；正确 → success 并只履约一次；非成功状态 → success', async () => {
    const w = await world({ zpay: ZPAY });
    const { outTradeNo } = (await w.createOrder()).json();
    const signed = (p: Record<string, string>) => ({ ...p, sign: zpaySign(p, 'k1'), sign_type: 'MD5' });
    const base = { pid: 'p1', trade_no: 'Z1', out_trade_no: outTradeNo, type: 'alipay', name: '包月陪伴' };
    const notify = async (query: Record<string, string>) =>
      (await call(w.ctx, 'GET', '/api/pay/zpay/notify', { query })).body;

    expect(await notify(signed({ ...base, money: '30.00', trade_status: 'WAIT_BUYER_PAY' }))).toBe('success');
    expect(await notify({ ...signed({ ...base, money: '30.00', trade_status: 'TRADE_SUCCESS' }), sign: 'x'.repeat(32) })).toBe(
      'fail',
    );
    expect(await notify(signed({ ...base, money: '0.01', trade_status: 'TRADE_SUCCESS' }))).toBe('fail');
    const [pending] = await w.ctx.db.select().from(orders).where(eq(orders.outTradeNo, outTradeNo));
    expect(pending.status).toBe('pending');

    const ok = signed({ ...base, money: '30.00', trade_status: 'TRADE_SUCCESS' });
    expect(await notify(ok)).toBe('success');
    expect(await notify(ok)).toBe('success');
    const [paid] = await w.ctx.db.select().from(orders).where(eq(orders.outTradeNo, outTradeNo));
    expect(paid).toMatchObject({ status: 'paid', tradeNo: 'Z1' });
    expect(await w.ctx.db.$count(serviceRelations)).toBe(1);
  });

  test('老师查看名下学员；非老师 403', async () => {
    const ctx = await setup();
    const t = await loginUser(ctx, 'teacher-login');
    await makeTeacherProfile(ctx.db, t.userId);
    const u = await insertUser(ctx.db, 'u');
    await buyAndPay(ctx, u, await insertPackage(ctx.db, t.userId));

    const res = await call(ctx, 'GET', '/api/teacher/students', { token: t.token });
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0]).toMatchObject({ userId: u, userNickname: '' });

    const nobody = await loginUser(ctx, 'nobody');
    expect((await call(ctx, 'GET', '/api/teacher/students', { token: nobody.token })).statusCode).toBe(403);
  });
});
```

**Step 2: 运行，确认失败**

Run: `cd apps/server && pnpm vitest run src/modules/orders/routes.test.ts`
Expected: FAIL（404）

**Step 3: 实现**

`src/modules/relations/service.ts`：把顶部两行 import 改为

```ts
import { and, asc, desc, eq, getTableColumns, max, ne } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { type orders, serviceRelations, serviceSegments, teacherProfiles, users } from '../../db/schema.ts';
```

（其余 import 不变），并在文件末尾追加：

```ts
export async function listUserRelations(db: DbOrTx, userId: number) {
  return db
    .select({ ...getTableColumns(serviceRelations), teacherName: teacherProfiles.displayName })
    .from(serviceRelations)
    .innerJoin(teacherProfiles, eq(teacherProfiles.userId, serviceRelations.teacherId))
    .where(eq(serviceRelations.userId, userId))
    .orderBy(desc(serviceRelations.id));
}

export async function listTeacherStudents(db: DbOrTx, teacherId: number) {
  return db
    .select({ ...getTableColumns(serviceRelations), userNickname: users.nickname })
    .from(serviceRelations)
    .innerJoin(users, eq(users.id, serviceRelations.userId))
    .where(eq(serviceRelations.teacherId, teacherId))
    .orderBy(asc(serviceRelations.status), asc(serviceRelations.endDate));
}
```

`src/modules/relations/routes.ts`：

```ts
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
```

`src/modules/orders/routes.ts`：

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { HttpError } from '../../lib/errors.ts';
import { IdParam } from '../../lib/zod.ts';
import { userGuard } from '../auth/guards.ts';
import { createOrder, getOrderByOutTradeNo } from './service.ts';

export const orderRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.addHook('preHandler', userGuard(deps));

    app.post('/', { schema: { body: z.object({ packageId: IdParam }) } }, async (req, reply) => {
      const order = await createOrder(deps.db, deps.clock, {
        userId: req.userId,
        packageId: req.body.packageId,
        provider: deps.payment.name,
      });
      const payUrl = deps.payment.payUrl({
        outTradeNo: order.outTradeNo,
        amountCents: order.amountCents,
        subject: order.packageSnapshot.title,
      });
      return reply
        .status(201)
        .send({ outTradeNo: order.outTradeNo, amountCents: order.amountCents, payUrl, mock: deps.payment.isMock });
    });

    app.get(
      '/:outTradeNo',
      { schema: { params: z.object({ outTradeNo: z.string().min(1).max(64) }) } },
      async (req) => {
        const o = await getOrderByOutTradeNo(deps.db, req.params.outTradeNo);
        if (!o || o.userId !== req.userId) throw new HttpError(404, '订单不存在');
        return { outTradeNo: o.outTradeNo, status: o.status, paid: o.status === 'paid', amountCents: o.amountCents };
      },
    );
  };
```

`src/modules/pay/routes.ts`：

```ts
import type { FastifyBaseLogger } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { HttpError } from '../../lib/errors.ts';
import { centsToYuan } from '../../lib/money.ts';
import { fulfillOrder, getOrderByOutTradeNo } from '../orders/service.ts';

const HTML = 'text/html; charset=utf-8';

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (body: string): string => `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>LiaoYu 支付</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;
min-height:100vh;margin:0;background:#f5f6f8}.c{background:#fff;padding:32px;border-radius:16px;text-align:center;
max-width:340px;width:90%}button{width:100%;padding:14px;border:0;border-radius:10px;background:#1677ff;color:#fff;
font-size:16px}</style></head><body><div class="c">${body}</div></body></html>`;

const OutTradeNoQuery = z.object({ out_trade_no: z.string().min(1).max(64) });

export const payRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    async function handleNotify(params: unknown, log: FastifyBaseLogger): Promise<'success' | 'fail'> {
      const r = deps.payment.parseNotify((params ?? {}) as Record<string, unknown>);
      if (r.kind === 'invalid') {
        log.warn('支付回调验签失败');
        return 'fail';
      }
      if (r.kind === 'ignored') return 'success';
      const f = await fulfillOrder(deps.db, deps.clock, r.outTradeNo, { tradeNo: r.tradeNo, paidCents: r.paidCents });
      if (!f.ok) {
        log.error({ outTradeNo: r.outTradeNo, reason: f.reason, paidCents: r.paidCents }, '支付回调履约失败');
        return 'fail';
      }
      return 'success';
    }

    app.get('/zpay/notify', { schema: { hide: true } }, async (req, reply) =>
      reply.type('text/plain').send(await handleNotify(req.query, req.log)),
    );
    app.post('/zpay/notify', { schema: { hide: true } }, async (req, reply) =>
      reply.type('text/plain').send(await handleNotify(req.body, req.log)),
    );

    app.get('/return', { schema: { hide: true } }, async (_req, reply) =>
      reply.type(HTML).send(page('<h3>支付已提交</h3><p>请返回微信小程序查看服务是否已开通。</p>')),
    );

    app.get('/mock', { schema: { querystring: OutTradeNoQuery, hide: true } }, async (req, reply) => {
      if (!deps.payment.isMock) throw new HttpError(404, 'Not Found');
      const o = await getOrderByOutTradeNo(deps.db, req.query.out_trade_no);
      if (!o) throw new HttpError(404, '订单不存在');
      const action = `/api/pay/mock/confirm?out_trade_no=${encodeURIComponent(o.outTradeNo)}`;
      return reply.type(HTML).send(
        page(`<p>开发模拟收银台（不会真实扣款）</p><h3>${esc(o.packageSnapshot.title)}</h3>
<h2>¥${centsToYuan(o.amountCents)}</h2><form method="post" action="${esc(action)}"><button>确认支付</button></form>`),
      );
    });

    app.post('/mock/confirm', { schema: { querystring: OutTradeNoQuery, hide: true } }, async (req, reply) => {
      if (!deps.payment.isMock) throw new HttpError(404, 'Not Found');
      const o = await getOrderByOutTradeNo(deps.db, req.query.out_trade_no);
      if (!o) throw new HttpError(404, '订单不存在');
      await fulfillOrder(deps.db, deps.clock, o.outTradeNo, { tradeNo: `MOCK_${o.outTradeNo}`, paidCents: o.amountCents });
      return reply.type(HTML).send(page('<h3>模拟支付成功</h3><p>请返回微信小程序。</p>'));
    });
  };
```

`src/routes.ts` 加 import 并注册：

```ts
  await app.register(orderRoutes(deps), { prefix: '/api/orders' });
  await app.register(payRoutes(deps), { prefix: '/api/pay' });
  await app.register(relationRoutes(deps), { prefix: '/api/relations' });
  await app.register(teacherStudentRoutes(deps), { prefix: '/api/teacher/students' });
```

**Step 4: 运行，确认通过**

Run: `cd apps/server && pnpm vitest run src/modules/orders`
Expected: PASS（13 tests：本 Task 5 个 + Task 12 的 8 个）

Run（项目根）：`pnpm fix && pnpm check`

**Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: 订单、ZPAY 回调、MOCK 收银台与我的服务接口"
```

---

### Task 14: 日计提与每日任务

**Files:**
- Create: `src/modules/accrual/service.ts`、`src/jobs/daily.ts`
- Test: `src/modules/accrual/accrual.test.ts`

**规则：**
- 只处理「`active`、未冻结、非单次」的服务关系（`accruable` 条件）。
- 当天落在 normal/substitute 分段 → 计给该分段老师；落在 paused 分段 → 不计。
- 日额 = `splitEvenly(金额, totalDays, 第几个有效日)`，保证合计精确等于订单金额。
- `(relation_id, date)` 唯一 + `ON CONFLICT DO NOTHING`，重复跑幂等；`accrueUpTo` 从最早开始日补齐，所以解冻后会自动补算。
- 每条服务关系的计提在独立事务里先 `FOR SHARE` 锁住关系行，与 `rewriteSegments` 的 `FOR UPDATE` 互斥，保证读到一致的分段。
- 每日任务 `runDailyJobs(db, today)`：先计提到昨天，再把 `endDate < today` 且未冻结的关系置为 `ended`。

**Step 1: 写失败测试**

`src/modules/accrual/accrual.test.ts`：

```ts
import { eq, sql } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { buyAndPay, insertPackage, insertTeacher, insertUser, setup } from '../../../tests/helpers.ts';
import type { DbOrTx } from '../../db/client.ts';
import { accruals, serviceRelations } from '../../db/schema.ts';
import { applyPause, applySubstitute } from '../../domain/segments.ts';
import { runDailyJobs } from '../../jobs/daily.ts';
import { rewriteSegments } from '../relations/service.ts';
import { accrueForDate, accrueUpTo } from './service.ts';

async function world(priceCents = 3000) {
  const ctx = await setup();
  const teacher = await insertTeacher(ctx.db, 'a');
  const sub = await insertTeacher(ctx.db, 'b');
  const user = await insertUser(ctx.db, 'u');
  const rel = await buyAndPay(ctx, user, await insertPackage(ctx.db, teacher, { priceCents }));
  return { ctx, db: ctx.db, teacher, sub, rel };
}

async function sumBy(db: DbOrTx, teacherId: number): Promise<number> {
  const [r] = await db
    .select({ s: sql<number>`COALESCE(SUM(${accruals.amountCents}), 0)::bigint` })
    .from(accruals)
    .where(eq(accruals.teacherId, teacherId));
  return r.s;
}

const setFrozen = (db: DbOrTx, frozen: boolean) => db.update(serviceRelations).set({ frozen });

describe('日计提', () => {
  test('按日计提且幂等', async () => {
    const w = await world();
    expect(await accrueForDate(w.db, '2026-11-01')).toBe(1);
    expect(await accrueForDate(w.db, '2026-11-01')).toBe(0);
    const [row] = await w.db.select().from(accruals);
    expect(row).toMatchObject({ amountCents: 100, teacherId: w.teacher, date: '2026-11-01' });
  });

  test('服务期外不计提', async () => {
    const w = await world();
    expect(await accrueForDate(w.db, '2026-10-31')).toBe(0);
    expect(await accrueForDate(w.db, '2026-12-01')).toBe(0);
  });

  test('代班期间计给代班老师', async () => {
    const w = await world();
    await rewriteSegments(w.db, w.rel.id, (s) =>
      applySubstitute(s, { from: '2026-11-10', to: '2026-11-12', teacherId: w.sub }),
    );
    await accrueUpTo(w.db, '2026-11-30');
    expect(await sumBy(w.db, w.sub)).toBe(300);
    expect(await sumBy(w.db, w.teacher)).toBe(2700);
  });

  test('暂停不计提并顺延，总额精确等于订单金额', async () => {
    const w = await world(1000);
    await rewriteSegments(w.db, w.rel.id, (s) => applyPause(s, { from: '2026-11-10', to: '2026-11-14' }));
    await accrueUpTo(w.db, '2026-12-05');
    expect(await w.db.$count(accruals, eq(accruals.date, '2026-11-10'))).toBe(0);
    const [d15] = await w.db.select().from(accruals).where(eq(accruals.date, '2026-11-15'));
    expect(d15.amountCents).toBe(34);
    expect(await w.db.$count(accruals)).toBe(30);
    expect(await sumBy(w.db, w.teacher)).toBe(1000);
  });

  test('冻结不计提，解冻后补算', async () => {
    const w = await world();
    await setFrozen(w.db, true);
    expect(await accrueUpTo(w.db, '2026-11-05')).toBe(0);
    await setFrozen(w.db, false);
    expect(await accrueUpTo(w.db, '2026-11-05')).toBe(5);
  });

  test('单次套餐不参与日计提', async () => {
    const ctx = await setup();
    const t = await insertTeacher(ctx.db, 'a');
    const pkg = await insertPackage(ctx.db, t, { type: 'single', days: 0, callQuota: 1, priceCents: 500 });
    await buyAndPay(ctx, await insertUser(ctx.db, 'u'), pkg);
    expect(await accrueUpTo(ctx.db, '2026-11-30')).toBe(0);
  });

  test('每日任务：计提到昨天并结束到期关系', async () => {
    const w = await world();
    expect(await runDailyJobs(w.db, '2026-12-01')).toEqual({ accrued: 30, ended: 1 });
    const [r] = await w.db.select().from(serviceRelations);
    expect(r.status).toBe('ended');
    expect(await sumBy(w.db, w.teacher)).toBe(3000);
    expect(await runDailyJobs(w.db, '2026-12-01')).toEqual({ accrued: 0, ended: 0 });
  });
});
```

**Step 2: 运行，确认失败**

Run: `cd apps/server && pnpm vitest run src/modules/accrual`
Expected: FAIL，模块不存在。

**Step 3: 实现**

`src/modules/accrual/service.ts`：

```ts
import { and, eq, gte, lte, min, ne } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { accruals, serviceRelations } from '../../db/schema.ts';
import { activeDayIndex, segmentOn } from '../../domain/segments.ts';
import { eachDay } from '../../lib/dates.ts';
import { splitEvenly } from '../../lib/money.ts';
import { loadSegments } from '../relations/service.ts';

/** 参与日计提的服务关系：进行中、未冻结、非单次 */
export const accruable = and(
  eq(serviceRelations.status, 'active'),
  eq(serviceRelations.frozen, false),
  ne(serviceRelations.packageType, 'single'),
);

export async function accrueForDate(db: DbOrTx, date: string): Promise<number> {
  const rels = await db
    .select({ id: serviceRelations.id, amountCents: serviceRelations.amountCents, totalDays: serviceRelations.totalDays })
    .from(serviceRelations)
    .where(and(accruable, lte(serviceRelations.startDate, date), gte(serviceRelations.endDate, date)));

  let created = 0;
  for (const r of rels) {
    created += await db.transaction(async (tx) => {
      // 与 rewriteSegments 的 FOR UPDATE 互斥，保证读到一致的分段
      await tx
        .select({ id: serviceRelations.id })
        .from(serviceRelations)
        .where(eq(serviceRelations.id, r.id))
        .for('share');
      const segs = await loadSegments(tx, r.id);
      const seg = segmentOn(segs, date);
      if (!seg || seg.teacherId === null) return 0;
      const idx = activeDayIndex(segs, date);
      if (idx >= r.totalDays) return 0;
      const rows = await tx
        .insert(accruals)
        .values({
          relationId: r.id,
          date,
          teacherId: seg.teacherId,
          amountCents: splitEvenly(r.amountCents, r.totalDays, idx),
        })
        .onConflictDoNothing({ target: [accruals.relationId, accruals.date] })
        .returning({ id: accruals.id });
      return rows.length;
    });
  }
  return created;
}

/** 从最早的可计提开始日补齐到 date（含），幂等 */
export async function accrueUpTo(db: DbOrTx, date: string): Promise<number> {
  const [row] = await db.select({ first: min(serviceRelations.startDate) }).from(serviceRelations).where(accruable);
  if (!row?.first || row.first > date) return 0;
  let n = 0;
  for (const d of eachDay(row.first, date)) n += await accrueForDate(db, d);
  return n;
}
```

`src/jobs/daily.ts`：

```ts
import { and, eq, lt } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { serviceRelations } from '../db/schema.ts';
import { addDays } from '../lib/dates.ts';
import { accrueUpTo } from '../modules/accrual/service.ts';

export async function runDailyJobs(db: DbOrTx, today: string): Promise<{ accrued: number; ended: number }> {
  const accrued = await accrueUpTo(db, addDays(today, -1));
  const ended = await db
    .update(serviceRelations)
    .set({ status: 'ended' })
    .where(
      and(eq(serviceRelations.status, 'active'), eq(serviceRelations.frozen, false), lt(serviceRelations.endDate, today)),
    )
    .returning({ id: serviceRelations.id });
  return { accrued, ended: ended.length };
}
```

**Step 4: 运行，确认通过**

Run: `cd apps/server && pnpm vitest run src/modules/accrual`
Expected: PASS（7 tests）

Run（项目根）：`pnpm fix && pnpm check`

**Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: 按服务分段日计提与每日任务"
```

---

### Task 15: 周结算、人工打款登记与抽成配置

**Files:**
- Create: `src/modules/settlement/service.ts`、`src/modules/settlement/admin-routes.ts`
- Modify: `src/routes.ts`
- Test: `src/modules/settlement/settlement.test.ts`

**规则：**
- 抽成比例存 `settings.commission_bps`（基点），默认 2000（20%），范围 `[0, 9999]`。结算单快照当期 `commissionBps`。
- 生成结算：按老师汇总区间内**未结算**且**所属关系未冻结**的计提，`commission = commissionOf(gross, bps)`，`net = gross − commission`，回写 `accruals.settlement_id`。重复生成不会重复计入。
- 并发：生成结算在事务内先取 `pg_advisory_xact_lock(72001)`，同一时刻只有一个生成过程（定时任务与管理员手动触发可能撞车）。
- `runWeeklySettlement(db, today)`：生成上周一到上周日的结算。
- 打款登记：仅 `pending` 可标记为 `paid`，必须填写凭证，记录操作人与时间。
- 所有管理端写操作与审计日志在同一事务内。

**Step 1: 写失败测试**

`src/modules/settlement/settlement.test.ts`：

```ts
import { asc } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { adminCookie, buyAndPay, call, insertPackage, insertTeacher, insertUser, setup } from '../../../tests/helpers.ts';
import { auditLogs, serviceRelations } from '../../db/schema.ts';
import { accrueUpTo } from '../accrual/service.ts';
import { generateSettlements, runWeeklySettlement } from './service.ts';

const WEEK = { periodStart: '2026-11-01', periodEnd: '2026-11-07' };

async function world() {
  const ctx = await setup();
  const teacher = await insertTeacher(ctx.db, 'a');
  const user = await insertUser(ctx.db, 'u');
  await buyAndPay(ctx, user, await insertPackage(ctx.db, teacher, { priceCents: 3000 }));
  await accrueUpTo(ctx.db, '2026-11-08');
  return { ctx, db: ctx.db, teacher };
}

describe('周结算', () => {
  test('默认抽成 20%，重复生成不重复计入', async () => {
    const w = await world();
    const [s] = await generateSettlements(w.db, WEEK);
    expect(s).toMatchObject({
      teacherId: w.teacher,
      grossCents: 700,
      commissionBps: 2000,
      commissionCents: 140,
      netCents: 560,
      status: 'pending',
    });
    expect(await generateSettlements(w.db, WEEK)).toEqual([]);
  });

  test('冻结关系的计提不进入结算', async () => {
    const w = await world();
    await w.db.update(serviceRelations).set({ frozen: true });
    expect(await generateSettlements(w.db, WEEK)).toEqual([]);
  });

  test('并发生成只结算一次', async () => {
    const w = await world();
    const rs = await Promise.all([1, 2, 3].map(() => generateSettlements(w.db, WEEK)));
    expect(rs.flat()).toHaveLength(1);
  });

  test('周任务结算上周一到上周日', async () => {
    const w = await world();
    const [s] = await runWeeklySettlement(w.db, '2026-11-09');
    expect(s).toMatchObject({ periodStart: '2026-11-02', periodEnd: '2026-11-08', grossCents: 700 });
  });

  test('管理接口：改抽成 → 生成 → 列表 → 登记打款 → 重复登记 409，全程审计', async () => {
    const w = await world();
    const cookie = await adminCookie(w.ctx);
    const bpsUrl = '/api/admin/settings/commission-bps';

    expect((await call(w.ctx, 'PUT', bpsUrl, { cookie, body: { bps: 10000 } })).statusCode).toBe(400);
    expect((await call(w.ctx, 'PUT', bpsUrl, { cookie, body: { bps: 3000 } })).statusCode).toBe(200);
    expect((await call(w.ctx, 'GET', bpsUrl, { cookie })).json()).toEqual({ bps: 3000 });

    const gen = await call(w.ctx, 'POST', '/api/admin/settlements/generate', { cookie, body: WEEK });
    expect(gen.statusCode).toBe(201);
    expect(gen.json()[0]).toMatchObject({ commissionBps: 3000, commissionCents: 210, netCents: 490 });

    const list = await call(w.ctx, 'GET', '/api/admin/settlements', { cookie, query: { status: 'pending' } });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].teacherName).toBe(`老师${w.teacher}`);

    const payUrl = `/api/admin/settlements/${gen.json()[0].id}/pay`;
    const paid = await call(w.ctx, 'POST', payUrl, { cookie, body: { proof: '支付宝转账单号 123' } });
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toMatchObject({ status: 'paid', proof: '支付宝转账单号 123' });
    expect((await call(w.ctx, 'POST', payUrl, { cookie, body: { proof: 'x' } })).statusCode).toBe(409);

    const logs = await w.db.select({ action: auditLogs.action }).from(auditLogs).orderBy(asc(auditLogs.id));
    expect(logs.map((l) => l.action)).toEqual([
      'admin.login',
      'settings.commission_bps',
      'settlement.generate',
      'settlement.pay',
    ]);
  });

  test('参数校验：缺少凭证、区间颠倒均返回 400', async () => {
    const w = await world();
    const cookie = await adminCookie(w.ctx);
    const [s] = await generateSettlements(w.db, WEEK);
    expect((await call(w.ctx, 'POST', `/api/admin/settlements/${s.id}/pay`, { cookie, body: {} })).statusCode).toBe(400);
    const bad = { periodStart: '2026-11-07', periodEnd: '2026-11-01' };
    expect((await call(w.ctx, 'POST', '/api/admin/settlements/generate', { cookie, body: bad })).statusCode).toBe(400);
  });
});
```

**Step 2: 运行，确认失败**

Run: `cd apps/server && pnpm vitest run src/modules/settlement`
Expected: FAIL，模块不存在。

**Step 3: 实现**

`src/modules/settlement/service.ts`：

```ts
import { and, asc, desc, eq, getTableColumns, gte, isNull, lte, notInArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { accruals, serviceRelations, settings, settlements, teacherProfiles } from '../../db/schema.ts';
import type { Clock } from '../../lib/clock.ts';
import { previousWeek } from '../../lib/dates.ts';
import { HttpError } from '../../lib/errors.ts';
import { commissionOf } from '../../lib/money.ts';

export const COMMISSION_KEY = 'commission_bps';
export const DEFAULT_COMMISSION_BPS = 2000;

export type Settlement = typeof settlements.$inferSelect;
export type SettlementStatus = Settlement['status'];

export async function getCommissionBps(db: DbOrTx): Promise<number> {
  const [r] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, COMMISSION_KEY));
  return typeof r?.value === 'number' ? r.value : DEFAULT_COMMISSION_BPS;
}

export async function setCommissionBps(db: DbOrTx, bps: number): Promise<void> {
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) throw new HttpError(400, '抽成基点须为 0~9999 的整数');
  await db
    .insert(settings)
    .values({ key: COMMISSION_KEY, value: bps })
    .onConflictDoUpdate({ target: settings.key, set: { value: bps } });
}

export async function generateSettlements(
  db: DbOrTx,
  { periodStart, periodEnd }: { periodStart: string; periodEnd: string },
): Promise<Settlement[]> {
  if (periodStart > periodEnd) throw new HttpError(400, '结算区间非法');
  return db.transaction(async (tx) => {
    // 72001：结算专用咨询锁，事务结束自动释放
    await tx.execute(sql`SELECT pg_advisory_xact_lock(72001)`);
    const bps = await getCommissionBps(tx);
    const frozenIds = tx.select({ id: serviceRelations.id }).from(serviceRelations).where(eq(serviceRelations.frozen, true));
    const unsettled = and(
      isNull(accruals.settlementId),
      gte(accruals.date, periodStart),
      lte(accruals.date, periodEnd),
      notInArray(accruals.relationId, frozenIds),
    );
    const rows = await tx
      .select({ teacherId: accruals.teacherId, gross: sql<number>`SUM(${accruals.amountCents})::bigint` })
      .from(accruals)
      .where(unsettled)
      .groupBy(accruals.teacherId)
      .orderBy(asc(accruals.teacherId));

    const out: Settlement[] = [];
    for (const r of rows) {
      const commissionCents = commissionOf(r.gross, bps);
      const [s] = await tx
        .insert(settlements)
        .values({
          teacherId: r.teacherId,
          periodStart,
          periodEnd,
          grossCents: r.gross,
          commissionBps: bps,
          commissionCents,
          netCents: r.gross - commissionCents,
        })
        .returning();
      await tx
        .update(accruals)
        .set({ settlementId: s.id })
        .where(and(unsettled, eq(accruals.teacherId, r.teacherId)));
      out.push(s);
    }
    return out;
  });
}

export async function runWeeklySettlement(db: DbOrTx, today: string): Promise<Settlement[]> {
  const [periodStart, periodEnd] = previousWeek(today);
  return generateSettlements(db, { periodStart, periodEnd });
}

export async function listSettlements(db: DbOrTx, status?: SettlementStatus) {
  return db
    .select({ ...getTableColumns(settlements), teacherName: teacherProfiles.displayName })
    .from(settlements)
    .innerJoin(teacherProfiles, eq(teacherProfiles.userId, settlements.teacherId))
    .where(status ? eq(settlements.status, status) : undefined)
    .orderBy(desc(settlements.id));
}

export async function markSettlementPaid(
  db: DbOrTx,
  clock: Clock,
  id: number,
  { proof, adminId }: { proof: string; adminId: number },
): Promise<Settlement> {
  const [s] = await db
    .update(settlements)
    .set({ status: 'paid', proof, operatorId: adminId, paidAt: clock.now() })
    .where(and(eq(settlements.id, id), eq(settlements.status, 'pending')))
    .returning();
  if (!s) throw new HttpError(409, '结算单不存在或已打款');
  return s;
}
```

`src/modules/settlement/admin-routes.ts`：

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { settlementStatus } from '../../db/schema.ts';
import type { Deps } from '../../deps.ts';
import { audit } from '../../lib/audit.ts';
import { DateStr, IdParam } from '../../lib/zod.ts';
import { adminGuard } from '../admin/guard.ts';
import {
  generateSettlements,
  getCommissionBps,
  listSettlements,
  markSettlementPaid,
  setCommissionBps,
} from './service.ts';

export const adminSettlementRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.addHook('preHandler', adminGuard(deps));

    app.get('/settings/commission-bps', async () => ({ bps: await getCommissionBps(deps.db) }));

    app.put(
      '/settings/commission-bps',
      { schema: { body: z.object({ bps: z.number().int().min(0).max(9999) }) } },
      async (req) =>
        deps.db.transaction(async (tx) => {
          await setCommissionBps(tx, req.body.bps);
          await audit(tx, {
            adminId: req.adminId,
            action: 'settings.commission_bps',
            target: 'settings',
            detail: { bps: req.body.bps },
          });
          return { bps: req.body.bps };
        }),
    );

    app.post(
      '/settlements/generate',
      { schema: { body: z.object({ periodStart: DateStr, periodEnd: DateStr }) } },
      async (req, reply) => {
        const rows = await deps.db.transaction(async (tx) => {
          const created = await generateSettlements(tx, req.body);
          await audit(tx, {
            adminId: req.adminId,
            action: 'settlement.generate',
            target: `period:${req.body.periodStart}~${req.body.periodEnd}`,
            detail: { ids: created.map((s) => s.id) },
          });
          return created;
        });
        return reply.status(201).send(rows);
      },
    );

    app.get(
      '/settlements',
      { schema: { querystring: z.object({ status: z.enum(settlementStatus.enumValues).optional() }) } },
      async (req) => listSettlements(deps.db, req.query.status),
    );

    app.post(
      '/settlements/:id/pay',
      {
        schema: {
          params: z.object({ id: IdParam }),
          body: z.object({ proof: z.string().trim().min(1).max(200) }),
        },
      },
      async (req) =>
        deps.db.transaction(async (tx) => {
          const s = await markSettlementPaid(tx, deps.clock, req.params.id, {
            proof: req.body.proof,
            adminId: req.adminId,
          });
          await audit(tx, {
            adminId: req.adminId,
            action: 'settlement.pay',
            target: `settlement:${s.id}`,
            detail: { netCents: s.netCents, proof: s.proof },
          });
          return s;
        }),
    );
  };
```

`src/routes.ts` 加 import 并注册（与 `adminAuthRoutes` 同前缀；未用 `fastify-plugin` 包装，`adminGuard` 钩子只作用于本插件内的路由，不影响 `/api/admin/login`）：

```ts
  await app.register(adminSettlementRoutes(deps), { prefix: '/api/admin' });
```

**Step 4: 运行，确认通过**

Run: `cd apps/server && pnpm vitest run src/modules/settlement`
Expected: PASS（6 tests）

验证锁确实起作用：临时注释掉 `pg_advisory_xact_lock` 那一句，重跑，`并发生成只结算一次` 应 FAIL（或偶发 FAIL，可多跑几次）；恢复后再 PASS。

Run（项目根）：`pnpm fix && pnpm check`

**Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: 周结算（咨询锁防并发）、人工打款登记与抽成配置"
```

---

### Task 16: 管理端订单查询与 CSV 导出

**Files:**
- Create: `src/lib/csv.ts`、`src/modules/orders/admin-routes.ts`
- Modify: `src/modules/orders/service.ts`（追加 `queryOrders`）、`src/routes.ts`
- Test: `src/lib/csv.test.ts`、`src/modules/orders/admin.test.ts`

**目标：** 回答"哪个用户给哪个老师付了多少钱"。支持按 `userId`、`teacherId`、`status`、`from`、`to`（北京时间日期，含首尾）筛选。CSV 带 BOM，Excel 可直接打开；以 `= + - @` 开头的单元格前加 `'`，防止公式注入（昵称、套餐标题由用户/老师填写）。导出写审计日志 `orders.export`。

**Step 1: 写失败测试**

`src/lib/csv.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import { csvCell, toCsv } from './csv.ts';

describe('csv', () => {
  test('转义引号/逗号/换行，阻止公式注入，BOM 开头', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('x\ny')).toBe('"x\ny"');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    for (const s of ['+1', '-1', '@a']) expect(csvCell(s)).toBe(`'${s}`);
    expect(csvCell(null)).toBe('');
    expect(csvCell(30)).toBe('30');
    expect(toCsv(['a', 'b'], [[1, 'x,y']])).toBe('\ufeffa,b\n1,"x,y"\n');
  });
});
```

`src/modules/orders/admin.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import {
  adminCookie,
  buyAndPay,
  call,
  insertPackage,
  insertTeacher,
  insertUser,
  setup,
} from '../../../tests/helpers.ts';
import { auditLogs } from '../../db/schema.ts';
import { createOrder } from './service.ts';

async function world() {
  const ctx = await setup();
  const a = await insertTeacher(ctx.db, 'a');
  const b = await insertTeacher(ctx.db, 'b');
  const u = await insertUser(ctx.db, 'u');
  await buyAndPay(ctx, u, await insertPackage(ctx.db, a, { priceCents: 3000, title: '包月, 情感' }));
  await createOrder(ctx.db, ctx.clock, {
    userId: u,
    packageId: await insertPackage(ctx.db, b, { priceCents: 500 }),
    provider: 'zpay',
  });
  const cookie = await adminCookie(ctx);
  const list = async (query: Record<string, string | number> = {}) =>
    (await call(ctx, 'GET', '/api/admin/orders', { cookie, query })).json();
  return { ctx, a, b, u, cookie, list };
}

describe('管理端订单查询与导出', () => {
  test('订单列表含用户、老师、套餐、金额，可按老师/用户/状态筛选；需管理员登录', async () => {
    const w = await world();
    expect((await call(w.ctx, 'GET', '/api/admin/orders')).statusCode).toBe(401);
    expect(await w.list()).toHaveLength(2);

    const byA = await w.list({ teacherId: w.a });
    expect(byA).toHaveLength(1);
    expect(byA[0]).toMatchObject({
      userId: w.u,
      teacherId: w.a,
      teacherName: `老师${w.a}`,
      packageTitle: '包月, 情感',
      amountCents: 3000,
      status: 'paid',
    });
    expect(await w.list({ userId: w.u })).toHaveLength(2);
    expect(await w.list({ status: 'pending' })).toHaveLength(1);
  });

  test('按北京时间日期筛选（含首尾）', async () => {
    const w = await world();
    expect(await w.list({ from: '2026-11-01', to: '2026-11-01' })).toHaveLength(2);
    expect(await w.list({ from: '2026-11-02' })).toHaveLength(0);
    expect(await w.list({ to: '2026-10-31' })).toHaveLength(0);
    expect((await call(w.ctx, 'GET', '/api/admin/orders', { cookie: w.cookie, query: { from: '11/01' } })).statusCode).toBe(
      400,
    );
  });

  test('CSV 导出：BOM + 表头 + 北京时间 + 写审计', async () => {
    const w = await world();
    const res = await call(w.ctx, 'GET', '/api/admin/orders.csv', { cookie: w.cookie, query: { status: 'paid' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.body.startsWith('\ufeff')).toBe(true);
    const lines = res.body.slice(1).trimEnd().split('\n');
    expect(lines[0]).toBe('订单号,用户ID,用户昵称,老师ID,老师,套餐,金额(元),状态,支付时间');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/,"包月, 情感",30\.00,paid,2026-11-01 12:00:00$/);

    const logs = await w.ctx.db.select({ action: auditLogs.action }).from(auditLogs);
    expect(logs.map((l) => l.action)).toContain('orders.export');
  });
});
```

**Step 2: 运行，确认失败**

Run: `cd apps/server && pnpm vitest run src/lib/csv.test.ts src/modules/orders/admin.test.ts`
Expected: FAIL，模块不存在。

**Step 3: 实现**

`src/lib/csv.ts`：

```ts
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (FORMULA_PREFIX.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return `\ufeff${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n')}\n`;
}
```

`src/modules/orders/service.ts`：把 `drizzle-orm` 与 `lib/dates` 两行 import 改为

```ts
import { and, desc, eq, getTableColumns, gte, lt, sql } from 'drizzle-orm';
import { addDays, dayStartCN, formatDateTimeCN, todayCN } from '../../lib/dates.ts';
```

（其余 import 不变），并在文件末尾追加：

```ts
export interface OrderQuery {
  userId?: number;
  teacherId?: number;
  status?: Order['status'];
  /** 北京时间日期，含 */
  from?: string;
  /** 北京时间日期，含 */
  to?: string;
}

export async function queryOrders(db: DbOrTx, q: OrderQuery) {
  return db
    .select({
      outTradeNo: orders.outTradeNo,
      userId: orders.userId,
      userNickname: users.nickname,
      teacherId: orders.teacherId,
      teacherName: teacherProfiles.displayName,
      packageTitle: sql<string>`${orders.packageSnapshot}->>'title'`,
      amountCents: orders.amountCents,
      status: orders.status,
      tradeNo: orders.tradeNo,
      paidAt: orders.paidAt,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .innerJoin(users, eq(users.id, orders.userId))
    .innerJoin(teacherProfiles, eq(teacherProfiles.userId, orders.teacherId))
    .where(
      and(
        q.userId ? eq(orders.userId, q.userId) : undefined,
        q.teacherId ? eq(orders.teacherId, q.teacherId) : undefined,
        q.status ? eq(orders.status, q.status) : undefined,
        q.from ? gte(orders.createdAt, dayStartCN(q.from)) : undefined,
        q.to ? lt(orders.createdAt, dayStartCN(addDays(q.to, 1))) : undefined,
      ),
    )
    .orderBy(desc(orders.id));
}
```

`src/modules/orders/admin-routes.ts`：

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { orderStatus } from '../../db/schema.ts';
import type { Deps } from '../../deps.ts';
import { audit } from '../../lib/audit.ts';
import { toCsv } from '../../lib/csv.ts';
import { formatDateTimeCN } from '../../lib/dates.ts';
import { centsToYuan } from '../../lib/money.ts';
import { DateStr, IdParam } from '../../lib/zod.ts';
import { adminGuard } from '../admin/guard.ts';
import { queryOrders } from './service.ts';

const OrderQuerySchema = z.object({
  userId: IdParam.optional(),
  teacherId: IdParam.optional(),
  status: z.enum(orderStatus.enumValues).optional(),
  from: DateStr.optional(),
  to: DateStr.optional(),
});

const CSV_HEADER = ['订单号', '用户ID', '用户昵称', '老师ID', '老师', '套餐', '金额(元)', '状态', '支付时间'];

export const adminOrderRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.addHook('preHandler', adminGuard(deps));

    app.get('/orders', { schema: { querystring: OrderQuerySchema } }, async (req) => queryOrders(deps.db, req.query));

    app.get('/orders.csv', { schema: { querystring: OrderQuerySchema } }, async (req, reply) => {
      const rows = await queryOrders(deps.db, req.query);
      await audit(deps.db, {
        adminId: req.adminId,
        action: 'orders.export',
        target: 'orders',
        detail: { ...req.query, count: rows.length },
      });
      const csv = toCsv(
        CSV_HEADER,
        rows.map((o) => [
          o.outTradeNo,
          o.userId,
          o.userNickname,
          o.teacherId,
          o.teacherName,
          o.packageTitle,
          centsToYuan(o.amountCents),
          o.status,
          o.paidAt ? formatDateTimeCN(o.paidAt) : '',
        ]),
      );
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="orders.csv"')
        .send(csv);
    });
  };
```

`src/routes.ts` 加 import 并注册：

```ts
  await app.register(adminOrderRoutes(deps), { prefix: '/api/admin' });
```

**Step 4: 运行，确认通过**

Run: `cd apps/server && pnpm vitest run src/lib/csv.test.ts src/modules/orders/admin.test.ts`
Expected: PASS（4 tests）

Run（项目根）：`pnpm fix && pnpm check`

**Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: 管理端订单查询与 CSV 导出（防公式注入）"
```

---

### Task 17: 定时任务（pg-boss）、启动入口与冒烟验证

**Files:**
- Create: `src/jobs/index.ts`、`src/index.ts`、`/README.md`
- Test: `src/jobs/jobs.test.ts`

**规则：**
- 任务清单 `JOBS`：`daily`（每天 00:10，计提到昨天并结束到期关系）、`weekly-settlement`（每周一 02:00，生成上周结算），时区 `Asia/Shanghai`。
- 两个任务本身都幂等（计提唯一键、结算只取未结算计提），pg-boss 重试或手动重跑都安全。
- `registerJobs` 只依赖 pg-boss 的最小接口 `JobBoss`，测试用假实现，不启动真实队列。任务失败时记错误日志并抛出，交给 pg-boss 重试。
- 启动顺序：读配置 → 迁移 → 构建应用 → 启动 pg-boss 并注册任务 → 监听端口。收到 `SIGTERM/SIGINT` 依次关闭 HTTP、pg-boss、连接池。

**Step 1: 写失败测试**

`src/jobs/jobs.test.ts`：

```ts
import { describe, expect, test, vi } from 'vitest';
import { buyAndPay, insertPackage, insertTeacher, insertUser, setup } from '../../tests/helpers.ts';
import { fixedClock } from '../lib/clock.ts';
import { JOBS, type JobBoss, type JobContext, registerJobs, TZ } from './index.ts';

type Handler = (jobs: unknown[]) => Promise<unknown>;

function fakeBoss(existing: string[] = []) {
  const queues = new Set(existing);
  const created: string[] = [];
  const handlers = new Map<string, Handler>();
  const schedules: { name: string; cron: string; tz: string }[] = [];
  const boss: JobBoss = {
    getQueue: async (name) => (queues.has(name) ? { name } : null),
    createQueue: async (name) => {
      queues.add(name);
      created.push(name);
    },
    work: async (name, handler) => {
      handlers.set(name, handler);
      return name;
    },
    schedule: async (name, cron, _data, options) => {
      schedules.push({ name, cron, tz: options.tz });
    },
  };
  return { boss, created, handlers, schedules };
}

const fakeLog = () => ({ info: vi.fn(), error: vi.fn() });

describe('定时任务', () => {
  test('任务清单与调度时间', () => {
    expect(JOBS.map((j) => [j.name, j.cron])).toEqual([
      ['daily', '10 0 * * *'],
      ['weekly-settlement', '0 2 * * 1'],
    ]);
    expect(TZ).toBe('Asia/Shanghai');
  });

  test('注册：缺失的队列才创建，按北京时间调度；daily 处理器计提并结束到期关系', async () => {
    const ctx = await setup();
    const t = await insertTeacher(ctx.db, 't');
    await buyAndPay(ctx, await insertUser(ctx.db, 'u'), await insertPackage(ctx.db, t));

    const f = fakeBoss(['daily']);
    const log = fakeLog();
    const jobCtx: JobContext = { db: ctx.db, clock: fixedClock('2026-12-01T04:00:00Z'), log };
    await registerJobs(f.boss, jobCtx);

    expect(f.created).toEqual(['weekly-settlement']);
    expect(f.schedules).toEqual([
      { name: 'daily', cron: '10 0 * * *', tz: TZ },
      { name: 'weekly-settlement', cron: '0 2 * * 1', tz: TZ },
    ]);
    expect(await f.handlers.get('daily')?.([])).toEqual({ accrued: 30, ended: 1 });
    expect(log.info).toHaveBeenCalled();
  });

  test('任务失败：记录错误并抛出，交给 pg-boss 重试', async () => {
    const ctx = await setup();
    const f = fakeBoss();
    const log = fakeLog();
    const boom = {
      name: 'boom',
      cron: '* * * * *',
      run: async () => {
        throw new Error('炸了');
      },
    };
    await registerJobs(f.boss, { db: ctx.db, clock: ctx.clock, log }, [boom]);
    await expect(f.handlers.get('boom')?.([])).rejects.toThrow('炸了');
    expect(log.error).toHaveBeenCalled();
  });
});
```

**Step 2: 运行，确认失败**

Run: `cd apps/server && pnpm vitest run src/jobs`
Expected: FAIL，`./index.ts` 不存在。

**Step 3: 实现**

`src/jobs/index.ts`：

```ts
import type { FastifyBaseLogger } from 'fastify';
import { PgBoss } from 'pg-boss';
import type { DbOrTx } from '../db/client.ts';
import type { Clock } from '../lib/clock.ts';
import { todayCN } from '../lib/dates.ts';
import { runWeeklySettlement } from '../modules/settlement/service.ts';
import { runDailyJobs } from './daily.ts';

export const TZ = 'Asia/Shanghai';

export interface JobContext {
  db: DbOrTx;
  clock: Clock;
  log: Pick<FastifyBaseLogger, 'info' | 'error'>;
}

export interface JobDef {
  name: string;
  cron: string;
  run(ctx: JobContext): Promise<unknown>;
}

export const JOBS: readonly JobDef[] = [
  {
    name: 'daily',
    cron: '10 0 * * *',
    run: ({ db, clock }) => runDailyJobs(db, todayCN(clock.now())),
  },
  {
    name: 'weekly-settlement',
    cron: '0 2 * * 1',
    run: async ({ db, clock }) => ({ created: (await runWeeklySettlement(db, todayCN(clock.now()))).length }),
  },
];

/** pg-boss 的最小子集，便于测试替换 */
export interface JobBoss {
  getQueue(name: string): Promise<unknown>;
  createQueue(name: string): Promise<void>;
  work(name: string, handler: (jobs: unknown[]) => Promise<unknown>): Promise<string>;
  schedule(name: string, cron: string, data: object, options: { tz: string }): Promise<void>;
}

export async function registerJobs(boss: JobBoss, ctx: JobContext, jobs: readonly JobDef[] = JOBS): Promise<void> {
  for (const job of jobs) {
    if (!(await boss.getQueue(job.name))) await boss.createQueue(job.name);
    await boss.work(job.name, async () => {
      try {
        const result = await job.run(ctx);
        ctx.log.info({ job: job.name, result }, '定时任务完成');
        return result;
      } catch (err) {
        ctx.log.error({ job: job.name, err }, '定时任务失败');
        throw err;
      }
    });
    await boss.schedule(job.name, job.cron, {}, { tz: TZ });
  }
}

export async function startJobs(databaseUrl: string, ctx: JobContext): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: databaseUrl, schema: 'pgboss' });
  boss.on('error', (err) => ctx.log.error({ err }, 'pg-boss 错误'));
  await boss.start();
  await registerJobs(boss, ctx);
  return boss;
}
```

`src/index.ts`：

```ts
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createDb } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { createDeps } from './deps.ts';
import { startJobs } from './jobs/index.ts';
import { systemClock } from './lib/clock.ts';

const config = loadConfig();
const db = createDb(config.databaseUrl);
await runMigrations(db);

const deps = createDeps({ config, clock: systemClock, db });
const app = await buildApp(deps);
const boss = await startJobs(config.databaseUrl, { db, clock: systemClock, log: app.log });

if (deps.payment.isMock) app.log.warn('ZPAY 未配置，支付走 MOCK 收银台');
if (deps.wechat.isMock) app.log.warn('微信未配置，登录走 MOCK');

await app.listen({ host: '0.0.0.0', port: config.port });

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, '正在关闭');
  try {
    await app.close();
    await boss.stop({ graceful: true, timeout: 10_000 });
    await db.$client.end();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, '关闭失败');
    process.exit(1);
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
```

`/README.md`：

````markdown
# LiaoYu

陪伴咨询平台。后端位于 `apps/server`（Node 24 + TypeScript + Fastify + PostgreSQL）。

## 本地开发

```bash
source ~/.nvm/nvm.sh && nvm use 24
corepack enable pnpm
pnpm install
pnpm db:up                                    # 启动开发 PostgreSQL（端口 54329，含 liaoyu_test 测试库）
pnpm -F @liaoyu/server create-admin boss 'password-123456'
pnpm -F @liaoyu/server dev                    # http://localhost:8700
```

- 未配置 `ZPAY_PID/ZPAY_KEY` 时支付走本地模拟收银台；未配置 `WX_APPID/WX_APPSECRET` 时微信登录走 MOCK。
- 接口文档（非生产环境）：`GET /api/openapi.json`。
- 环境变量见 `apps/server/src/config.ts`，可写在 `apps/server/.env`。

## 质量门禁

```bash
pnpm fix      # 格式化 + 整理 import
pnpm check    # Biome + tsc + Vitest（需先 pnpm db:up）
```

## 目录

- `apps/server/src/modules/*`：按业务域划分，`routes.ts` 只做校验与调用，`service.ts` 负责事务与 IO
- `apps/server/src/domain/*`：纯函数（分段改写等），不碰数据库
- `apps/server/src/jobs/*`：pg-boss 定时任务
- `deploy/`：开发与生产的 Docker Compose、Caddy、备份脚本
````

**Step 4: 运行，确认通过**

Run: `cd apps/server && pnpm vitest run src/jobs`
Expected: PASS（3 tests）

Run（项目根）：`pnpm fix && pnpm check`
Expected: 全部通过（约 98 个用例）。

**Step 5: 冒烟**

```bash
cd /data/workspace/ngr/wx/LiaoYu/apps/server
PORT=8711 node src/index.ts > /tmp/liaoyu-smoke.log 2>&1 &
sleep 3
curl -s http://localhost:8711/api/health
curl -s -X POST http://localhost:8711/api/auth/wxlogin -H 'Content-Type: application/json' -d '{"code":"smoke"}'
curl -s http://localhost:8711/api/openapi.json | head -c 200; echo
docker compose -f ../../deploy/docker-compose.dev.yml exec -T postgres \
  psql -U liaoyu -d liaoyu -Atc "SELECT name, cron, timezone FROM pgboss.schedule ORDER BY name"
kill %1; wait
grep -E '正在关闭|error' /tmp/liaoyu-smoke.log
```

Expected:
- `{"ok":true}`；登录返回含 `token` 的 JSON；OpenAPI 输出以 `{"openapi":"3.` 开头。
- 调度表含 `daily|10 0 * * *|Asia/Shanghai` 与 `weekly-settlement|0 2 * * 1|Asia/Shanghai`。
- 日志里有 `正在关闭`，没有 `error`。

**Step 6: Commit**

```bash
cd /data/workspace/ngr/wx/LiaoYu
git add README.md apps/server
git commit -m "feat: pg-boss 定时任务、启动入口与优雅关闭"
```

---

### Task 18: 生产部署文件

**Files:**
- Create: `apps/server/Dockerfile`、`/.dockerignore`
- Create: `/deploy/docker-compose.yml`、`/deploy/Caddyfile`、`/deploy/.env.example`、`/deploy/backup.sh`
- Modify: `/README.md`（追加部署章节）

**要点：**
- 镜像 `node:24-slim`（glibc，`@node-rs/argon2` 预编译包可直接用），构建上下文为项目根，pnpm 按 filter 只装 server 的生产依赖；源码直接运行，无构建步骤；以 `node` 用户运行。
- Compose：`postgres` + `server` + `caddy`。server 不对外暴露端口，只由 Caddy 反代并自动签发 HTTPS 证书。生产必需变量用 `${VAR:?}`，缺一项 `docker compose` 直接报错（配合 `config.ts` 的生产校验，双保险）。
- 备份：宿主机 cron 每天 04:00 执行 `backup.sh`，`pg_dump -Fc` 上传 COS（`coscli`），本地保留 7 天；COS 桶上配置 30 天生命周期规则。

**Step 1: 镜像**

`apps/server/Dockerfile`：

```dockerfile
FROM node:24-slim
ENV NODE_ENV=production CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --prod --filter @liaoyu/server

COPY apps/server/src apps/server/src

USER node
WORKDIR /app/apps/server
EXPOSE 8700
CMD ["node", "src/index.ts"]
```

`/.dockerignore`：

```
**/node_modules
**/.env
**/*.test.ts
.git
docs
coverage
deploy
apps/server/tests
```

**Step 2: 生产编排**

`/deploy/docker-compose.yml`：

```yaml
name: liaoyu
services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: liaoyu
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?请在 deploy/.env 设置 POSTGRES_PASSWORD}
      POSTGRES_DB: liaoyu
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U liaoyu -d liaoyu"]
      interval: 5s
      timeout: 3s
      retries: 30

  server:
    build:
      context: ..
      dockerfile: apps/server/Dockerfile
    image: liaoyu-server
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      NODE_ENV: production
      PORT: "8700"
      DATABASE_URL: postgres://liaoyu:${POSTGRES_PASSWORD}@postgres:5432/liaoyu
      PUBLIC_BASE_URL: https://${DOMAIN:?请设置 DOMAIN}
      JWT_SECRET: ${JWT_SECRET:?请设置 JWT_SECRET}
      FIELD_KEY: ${FIELD_KEY:?请设置 FIELD_KEY}
      COOKIE_SECURE: "true"
      ZPAY_PID: ${ZPAY_PID:?请设置 ZPAY_PID}
      ZPAY_KEY: ${ZPAY_KEY:?请设置 ZPAY_KEY}
      WX_APPID: ${WX_APPID:?请设置 WX_APPID}
      WX_APPSECRET: ${WX_APPSECRET:?请设置 WX_APPSECRET}

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    depends_on:
      - server
    ports:
      - "80:80"
      - "443:443"
    environment:
      DOMAIN: ${DOMAIN}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  pgdata:
  caddy_data:
  caddy_config:
```

`/deploy/Caddyfile`：

```
{$DOMAIN} {
	encode gzip
	reverse_proxy server:8700
}
```

`/deploy/.env.example`：

```bash
# 复制为 deploy/.env 后填写；该文件不入库
# 已备案域名，DNS 指向本机
DOMAIN=api.example.com
# openssl rand -hex 24（只用十六进制，避免破坏 DATABASE_URL）
POSTGRES_PASSWORD=
# openssl rand -hex 32
JWT_SECRET=
# openssl rand -base64 32；丢失后实名数据无法解密，务必离线备份
FIELD_KEY=
ZPAY_PID=
ZPAY_KEY=
WX_APPID=
WX_APPSECRET=
# backup.sh 使用，例如 liaoyu-backup-1250000000
COS_BUCKET=
```

`/deploy/backup.sh`：

```bash
#!/usr/bin/env bash
# 宿主机 crontab：0 4 * * * /opt/liaoyu/deploy/backup.sh >> /var/log/liaoyu-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")"
set -a
# shellcheck disable=SC1091
source ./.env
set +a
: "${COS_BUCKET:?请在 deploy/.env 设置 COS_BUCKET}"

DIR=/var/backups/liaoyu
mkdir -p "$DIR"
FILE="$DIR/liaoyu-$(date +%Y%m%d-%H%M%S).dump"

docker compose exec -T postgres pg_dump -U liaoyu -d liaoyu -Fc > "$FILE"
test -s "$FILE"
coscli cp "$FILE" "cos://${COS_BUCKET}/liaoyu/$(basename "$FILE")"
find "$DIR" -name 'liaoyu-*.dump' -mtime +7 -delete
echo "[$(date '+%F %T')] 备份完成 $FILE"
```

（`/.gitignore` 中已有的 `.env` 规则会忽略 `deploy/.env`，`.env.example` 不受影响，无需修改。）

**Step 3: README 追加部署章节**

在 `/README.md` 末尾追加：

````markdown
## 生产部署（腾讯云轻量服务器）

前置：域名已 ICP 备案并解析到服务器；安装 Docker 与 [coscli](https://cloud.tencent.com/document/product/436/63143)。

```bash
git clone <repo> /opt/liaoyu && cd /opt/liaoyu/deploy
cp .env.example .env && vi .env          # 填写全部变量
docker compose up -d --build
docker compose exec server node src/scripts/create-admin.ts boss '<至少10位强密码>'
curl -s https://$DOMAIN/api/health        # {"ok":true}
chmod +x backup.sh && crontab -e          # 0 4 * * * /opt/liaoyu/deploy/backup.sh >> /var/log/liaoyu-backup.log 2>&1
```

- 升级：`git pull && docker compose up -d --build server`（启动时自动执行数据库迁移）。
- 小程序后台把 `https://$DOMAIN` 加入 request 合法域名；ZPAY 后台无需配置回调地址（随下单参数传递）。
- 恢复演练（每月一次）：

```bash
docker compose exec -T postgres createdb -U liaoyu liaoyu_restore
docker compose exec -T postgres pg_restore -U liaoyu -d liaoyu_restore --no-owner < /var/backups/liaoyu/<文件>.dump
docker compose exec -T postgres psql -U liaoyu -d liaoyu_restore -c 'SELECT COUNT(*) FROM orders'
docker compose exec -T postgres dropdb -U liaoyu liaoyu_restore
```
````

**Step 4: 验证**

Run（项目根）：

```bash
bash -n deploy/backup.sh && echo backup-ok
docker compose -f deploy/docker-compose.yml config > /dev/null
```

Expected: 输出 `backup-ok`；`config` 因缺少变量报错并提示 `请在 deploy/.env 设置 POSTGRES_PASSWORD`（证明缺项即失败）。

```bash
cp deploy/.env.example /tmp/liaoyu.env
sed -i 's/^\([A-Z_]*\)=$/\1=x/' /tmp/liaoyu.env
docker compose -f deploy/docker-compose.yml --env-file /tmp/liaoyu.env config > /dev/null && echo compose-ok
rm /tmp/liaoyu.env
```

Expected: `compose-ok`。

构建镜像，并连开发库冒烟（用开发模式跳过生产配置校验）：

```bash
docker build -f apps/server/Dockerfile -t liaoyu-server .
docker run --rm -d --name liaoyu-smoke --network host \
  -e NODE_ENV=development -e PORT=8712 \
  -e DATABASE_URL=postgres://liaoyu:liaoyu@localhost:54329/liaoyu liaoyu-server
sleep 3
curl -s http://localhost:8712/api/health
docker stop liaoyu-smoke
```

Expected: `{"ok":true}`。

再验证生产配置校验在容器内生效：

```bash
docker run --rm liaoyu-server 2>&1 | grep -m1 JWT_SECRET
```

Expected: 输出包含 `生产环境必须设置 JWT_SECRET` 的配置错误，容器立即退出。

**Step 5: Commit**

```bash
git add apps/server/Dockerfile .dockerignore deploy README.md
git commit -m "chore: 生产部署文件（Docker、Compose、Caddy、备份脚本）"
```

---

## 第一阶段完成标准

- `pnpm check` 全绿（约 98 个用例）。
- MOCK 模式下可走通：登录 → 申请入驻 → 管理员审核 → 建套餐 → 用户下单 → 模拟付款 → 服务关系生成 → 每日任务计提 → 生成周结算 → 登记打款 → 导出订单 CSV。
- 配置 `ZPAY_PID/ZPAY_KEY/PUBLIC_BASE_URL` 后，真实支付宝付款可通过 `/api/pay/zpay/notify` 自动开通服务。
- `docker compose up -d --build` 一条命令完成生产部署；缺少任何生产配置时拒绝启动。

## 已知遗留（后续阶段处理）

- 请假/代班/暂停的业务接口（第二阶段，复用 `rewriteSegments` + `applySubstitute` / `applyPause`）。
- 单次套餐按通话完成计提（第二阶段）。
- 工单与冻结的业务入口（第五阶段，计提与结算已支持 `frozen`）。
- 管理员登录限流、pino 日志文件轮转、企业微信告警（回调金额不符、任务连续失败、备份失败）。
- 审计日志的数据库账号级权限收紧（当前由触发器保证只追加）。
