# LiaoYu 第二阶段：服务交付（TypeScript 版）Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在第一阶段后端核心之上，实现「排班 → 预约通话（TRTC）→ 单次套餐按通话计提」「请假 → 代班邀请 → 学员选择 / 暂停顺延」「腾讯云 IM 聊天权限、危机词与私下交易提示、回复时效统计」以及站内通知。

**Architecture:** 沿用第一阶段结构：`src/modules/*` 按业务域划分（`routes.ts` 用 Zod 校验后调用 `service.ts`），分段改写等纯函数放 `src/domain/*`，定时任务注册到 pg-boss。请假与代班完全复用第一阶段的「服务分段」：请假生效时把受影响服务关系的窗口内正常日改为暂停并顺延，学员选定代班后把暂停日改为代班分段并收回顺延，日计提逻辑不用改。「老师同一时段只能有一个有效预约」「同一老师请假不重叠」「排班不重叠」「同一对师生只有一条未回复计时」都由数据库约束兜底。腾讯云 IM / TRTC 只做服务端部分：签发 UserSig、接收回调；未配置密钥时走 MOCK。

**Tech Stack:** 与第一阶段相同（Node 24、TypeScript 5.9、Fastify 5、Zod 4、Drizzle ORM 0.45、PostgreSQL 17、pg-boss 12、Vitest 4、Biome 2）；UserSig 签名用 Node 内置 `crypto`、`zlib`，不引入新依赖。

**前置：** `docs/plans/2026-10-25-liaoyu-phase1-backend-core-ts.md` 已全部完成，且项目根 `pnpm check` 全绿。

**设计文档：** `docs/plans/2026-10-24-liaoyu-platform-design.md`、`docs/plans/2026-10-25-liaoyu-tech-stack-design.md`

**替代：** 本文件替代 `archive/2026-10-24-liaoyu-phase2-service-delivery.md`（Express + SQLite 版）。业务规则与测试场景全部平移过来，并补了并发与约束相关的用例。

---

## 本阶段采用的业务规则

设计文档已定的规则直接沿用：代班期间的计提全部归代班老师；学员未选择前先暂停；请假期间的预约自动取消并退还次数；代班冲突要校验；不限制代班人数。下表是本计划补充的默认值，都定义成常量，后续可以调整：

| 项 | 规则 |
|---|---|
| 排班 | 老师按「星期几 + 时段」设置每周可约时间，每次保存整体覆盖 |
| 通话时长 | 固定 60 分钟，起始时间以 30 分钟为粒度 |
| 可预约窗口 | 开始时间距现在 ≥ 1 小时，且在 14 天以内 |
| 预约归属 | 归预约日所在分段的负责老师（代班日即代班老师）；暂停日不可预约 |
| 用户取消 | 开始前 ≥ 12 小时可以取消并退还次数，之后不能取消 |
| 老师取消 | 开始前都可以取消，退还次数并通知用户 |
| 进入通话 | 开始前 10 分钟到结束时间之间 |
| 老师爽约 | 开始 15 分钟后老师仍未进房 → `teacher_no_show`，退还次数 |
| 自动完成 | 老师进过房，结束 30 分钟后仍没收到解散房间回调 → 自动完成 |
| 单次套餐计提 | 通话完成后，用户确认或 48 小时内无异议 → 全额计给上课老师，服务关系结束；用户有异议则不计提（第五阶段工单处理） |
| 请假 | 起始日不早于今天，最长 60 天；同一老师请假不可重叠；MVP 不支持撤销请假 |
| 代班候选 | 1~3 位，须为已认证老师、等级 ≥ 请假老师当前等级、该时段不在请假 |
| 学员选择期限 | 每条受影响服务关系从通知起 48 小时 |
| 撤销代班 | 原老师可以撤销已同意的代班老师；已选该老师的学员分段改回暂停、相关预约取消，并重新获得 48 小时选择期 |
| 顺延与续费 | 只顺延受影响的那条服务关系；若与已购续费重叠，两者各自计提，互不调整 |
| 聊天权限 | 学员 ↔ 原老师（存在有效服务关系）；学员 ↔ 代班老师（仅当天处于该老师的代班分段） |
| 危机词 / 私下交易 | 命中后消息照常发出并记录事件；给发送者发站内提示（危机给热线，默认 `12356`），危机另外通知对方 |
| 回复时效 | 学员发给**当天负责老师**的消息开始计时，老师回复即结束；超过套餐承诺小时数算未达标 |
| 通知 | 站内通知表 `notifications`；小程序订阅消息推送放到第四阶段 |
| 内容安全检测 | 本阶段不做 |

---

## 约定

- 与第一阶段相同：项目根 `/data/workspace/ngr/wx/LiaoYu`，后端 `apps/server`，下文路径如无特别说明都相对 `apps/server/`；每个新 shell 先执行 `source ~/.nvm/nvm.sh && nvm use 24`；跑测试前在项目根执行 `pnpm db:up`。
- 单个测试：`cd /data/workspace/ngr/wx/LiaoYu/apps/server && pnpm vitest run <文件或目录>`；全量门禁：项目根 `pnpm fix && pnpm check`。
- 固定测试时钟：`2026-11-01T04:00:00Z`（北京时间 2026-11-01 **周日** 12:00）。2026-11-02 是周一，2026-11-10 是周二。
- Task 1 起 `setup()` 返回可调的 `ctx.clock`（`TestClock`）：HTTP 测试需要推进时间时调用 `ctx.clock.set(...)`。路由每次请求都会读 `deps.clock.now()`，所以修改立即生效。
- 服务函数统一显式接收 `now: Date`，不在内部读时钟；路由层传 `deps.clock.now()`。
- 业务日期（北京时间）用 `YYYY-MM-DD` 字符串；时刻用 `Date` / `timestamptz`。接口 JSON 字段一律 camelCase，`Date` 序列化为 ISO 字符串。
- **锁顺序**（防死锁，所有写路径都遵守）：老师行 `teacher_profiles` → 请假选择行 `leave_choices` → 服务关系行 `service_relations` → 预约行 `appointments`。预约时先无锁读出负责老师，加锁后再读一遍校验。
- 事务内的循环 `await` 是有意顺序执行（同一连接无法并发）。如果 Biome 报 `noAwaitInLoops`，在该行上方加 `// biome-ignore lint/performance/noAwaitInLoops: 事务内顺序执行`。
- 数据库约束冲突用 `pgConstraint(err)`（Task 1）识别后转成 409，不要用字符串匹配错误信息。
- 每个 Task 结束都提交一次 git。

## 文件总览

| 文件 | 职责 |
|---|---|
| `src/lib/notify.ts` | 写站内通知（支持批量） |
| `src/lib/pg-errors.ts` | 取出数据库约束名 |
| `src/domain/segments.ts` | 新增 `pauseRange` / `substituteFromPause` / `pauseFromSubstitute` |
| `src/domain/keywords.ts` | 危机词 / 私下交易关键词扫描 |
| `src/providers/tencent.ts` | UserSig 签发、IM 账号映射、MOCK 判定 |
| `src/providers/tencent-callback.ts` | IM / TRTC 回调验签 |
| `src/modules/teachers/guard.ts` | `teacherGuard`：登录 + 已认证老师 |
| `src/modules/notifications/*` | `/api/notifications` |
| `src/modules/schedule/*` | `/api/teacher/schedule` |
| `src/modules/appointments/*` | 可约时段、预约、取消、进房、完成、爽约、单次确认与计提；`/api/appointments`、`/api/teacher/appointments` |
| `src/modules/leaves/*` | 请假、代班邀请、学员选择、撤销代班、选择过期；`/api/teacher/leaves`、`/api/teacher/substitute-invites`、`/api/leave-choices` |
| `src/modules/chat/*` | 聊天权限、联系人、发送后处理、回复时效；`/api/teacher/reply-stats` |
| `src/modules/im/routes.ts` | `/api/im`（UserSig、联系人、IM 回调） |
| `src/modules/trtc/routes.ts` | `/api/trtc/callback`（原始请求体验签） |
| `src/jobs/frequent.ts` | 分钟级任务：选择过期、爽约、自动完成、自动确认 |

---

### Task 1: 第二阶段 schema、配置与公共工具

**Files:**
- Modify: `src/db/schema.ts`（末尾追加）
- Create（生成）: `src/db/migrations/0002_service_delivery.sql`、`src/db/migrations/0003_service_delivery_constraints.sql`
- Modify: `src/config.ts`、`src/config.test.ts`
- Modify: `src/lib/dates.ts`、`src/lib/dates.test.ts`、`src/lib/zod.ts`
- Create: `src/lib/notify.ts`、`src/lib/pg-errors.ts`
- Modify: `src/modules/teachers/service.ts`（追加 `lockTeacher`）
- Create: `src/modules/teachers/guard.ts`
- Modify: `src/modules/relations/service.ts`（追加 `lockRelation`）
- Modify: `tests/helpers.ts`
- Test: `src/db/service-delivery.test.ts`

**Step 1: 写失败测试**

`src/db/service-delivery.test.ts`：

```ts
import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { pgError } from '../../tests/db-utils.ts';
import { buyAndPay, insertPackage, insertTeacher, insertUser, setup } from '../../tests/helpers.ts';
import { appointments, leaves, replyWaits, schedules } from './schema.ts';

async function world() {
  const ctx = await setup();
  const teacherId = await insertTeacher(ctx.db, 't');
  const userId = await insertUser(ctx.db, 'u');
  const rel = await buyAndPay(ctx, userId, await insertPackage(ctx.db, teacherId));
  return { db: ctx.db, teacherId, userId, relationId: rel.id };
}

const at = (iso: string) => new Date(iso);

describe('第二阶段数据库约束', () => {
  test('迁移后包含第二阶段全部表', async () => {
    const { db } = await world();
    const { rows } = await db.$client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    const names = rows.map((r) => r.tablename);
    for (const t of [
      'notifications',
      'schedules',
      'appointments',
      'leaves',
      'substitute_candidates',
      'leave_choices',
      'crisis_events',
      'risk_events',
      'reply_waits',
    ]) {
      expect(names).toContain(t);
    }
  });

  test('同一老师的有效预约时段不得重叠；相邻可以；取消后可再约', async () => {
    const w = await world();
    const appt = (startAt: string, endAt: string) =>
      w.db
        .insert(appointments)
        .values({
          relationId: w.relationId,
          userId: w.userId,
          teacherId: w.teacherId,
          date: '2026-11-02',
          startAt: at(startAt),
          endAt: at(endAt),
        })
        .returning({ id: appointments.id });
    const [a] = await appt('2026-11-02T02:00:00Z', '2026-11-02T03:00:00Z');
    expect((await pgError(appt('2026-11-02T02:30:00Z', '2026-11-02T03:30:00Z'))).constraint).toBe(
      'appointments_teacher_no_overlap',
    );
    await appt('2026-11-02T03:00:00Z', '2026-11-02T04:00:00Z');
    await w.db.update(appointments).set({ status: 'cancelled' }).where(eq(appointments.id, a.id));
    await appt('2026-11-02T02:00:00Z', '2026-11-02T03:00:00Z');
  });

  test('同一老师请假日期不得重叠（首尾同日也算）', async () => {
    const w = await world();
    const leave = (startDate: string, endDate: string) =>
      w.db.insert(leaves).values({ teacherId: w.teacherId, startDate, endDate });
    await leave('2026-11-10', '2026-11-14');
    expect((await pgError(leave('2026-11-14', '2026-11-16'))).constraint).toBe('leaves_no_overlap');
    await leave('2026-11-15', '2026-11-16');
  });

  test('同一老师同一天排班时段不得重叠，相邻可以', async () => {
    const w = await world();
    const slot = (weekday: number, startMin: number, endMin: number) =>
      w.db.insert(schedules).values({ teacherId: w.teacherId, weekday, startMin, endMin });
    await slot(1, 540, 660);
    await slot(1, 660, 720);
    await slot(2, 600, 700);
    expect((await pgError(slot(1, 600, 700))).constraint).toBe('schedules_no_overlap');
    expect((await pgError(slot(7, 0, 60))).constraint).toBe('schedule_weekday');
  });

  test('同一对师生同时只能有一条未回复的计时', async () => {
    const w = await world();
    const wait = () =>
      w.db.insert(replyWaits).values({
        teacherId: w.teacherId,
        userId: w.userId,
        relationId: w.relationId,
        replyHours: 12,
        askedAt: at('2026-11-01T04:00:00Z'),
      });
    await wait();
    expect((await pgError(wait())).constraint).toBe('reply_waits_open_uq');
    await w.db.update(replyWaits).set({ repliedAt: at('2026-11-01T05:00:00Z') });
    await wait();
  });
});
```

`src/lib/dates.test.ts`：import 改为

```ts
import {
  addDays,
  cnTime,
  dayStartCN,
  diffDays,
  eachDay,
  formatDateTimeCN,
  hhmmToMin,
  isValidDate,
  minToHhmm,
  previousWeek,
  todayCN,
  weekdayOf,
} from './dates.ts';
```

在 `describe('dates', ...)` 内末尾追加：

```ts
  test('cnTime 与 weekdayOf 按北京时间', () => {
    expect(cnTime('2026-11-01', 720).toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(cnTime('2026-11-02', 600).toISOString()).toBe('2026-11-02T02:00:00.000Z');
    expect(weekdayOf('2026-11-01')).toBe(0);
    expect(weekdayOf('2026-11-02')).toBe(1);
  });

  test('isValidDate 与时分换算', () => {
    expect(isValidDate('2026-11-01')).toBe(true);
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('20261101')).toBe(false);
    expect(hhmmToMin('09:30')).toBe(570);
    expect(hhmmToMin('24:00')).toBe(1440);
    expect(minToHhmm(570)).toBe('09:30');
    expect(minToHhmm(1440)).toBe('24:00');
  });
```

`src/config.test.ts`：`PROD` 改为

```ts
const PROD = {
  NODE_ENV: 'production',
  JWT_SECRET: 'x'.repeat(32),
  FIELD_KEY: Buffer.alloc(32, 7).toString('base64'),
  COOKIE_SECURE: 'true',
  ZPAY_PID: 'p',
  ZPAY_KEY: 'k',
  WX_APPID: 'wx1',
  WX_APPSECRET: 's',
  TENCENT_SDKAPPID: '1400000001',
  TENCENT_SECRETKEY: 'sk',
  IM_CALLBACK_TOKEN: 'tok',
  TRTC_CALLBACK_KEY: 'ck',
};
```

在 `describe('config', ...)` 内末尾追加：

```ts
  test('腾讯云默认 MOCK，生产环境必须配置齐全', () => {
    const c = loadConfig({});
    expect(c.tencent).toEqual({ sdkAppId: 0, secretKey: '', imCallbackToken: '', trtcCallbackKey: '' });
    expect(c.crisisHotline).toBe('12356');
    expect(() => loadConfig({ ...PROD, TRTC_CALLBACK_KEY: '' })).toThrow(/TENCENT/);
    expect(loadConfig(PROD).tencent.sdkAppId).toBe(1400000001);
  });
```

**Step 2: 运行，确认失败**

Run: `pnpm vitest run src/db/service-delivery.test.ts src/lib/dates.test.ts src/config.test.ts`
Expected: FAIL（`appointments` 等导出不存在；`cnTime` 未导出；`c.tencent` 为 `undefined`）。

**Step 3: 实现 schema 与迁移**

`src/db/schema.ts`：`drizzle-orm/pg-core` 的 import 中补上 `uniqueIndex`，文件末尾追加：

```ts
// ===== 第二阶段：服务交付 =====
export const appointmentStatus = pgEnum('appointment_status', ['booked', 'completed', 'cancelled', 'teacher_no_show']);
export const cancelActor = pgEnum('cancel_actor', ['user', 'teacher', 'leave']);
export const confirmStatus = pgEnum('confirm_status', ['pending', 'confirmed', 'disputed', 'auto']);
export const candidateStatus = pgEnum('candidate_status', ['invited', 'accepted', 'rejected', 'revoked']);
export const choiceStatus = pgEnum('choice_status', ['pending', 'substitute', 'wait', 'expired']);
export const crisisStatus = pgEnum('crisis_status', ['open', 'handled']);

export type CancelActor = (typeof cancelActor.enumValues)[number];

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    isRead: boolean('is_read').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.isRead)],
);

export const schedules = pgTable(
  'schedules',
  {
    id: id(),
    teacherId: integer('teacher_id')
      .notNull()
      .references(() => users.id),
    weekday: integer('weekday').notNull(),
    startMin: integer('start_min').notNull(),
    endMin: integer('end_min').notNull(),
  },
  (t) => [
    index('schedules_teacher_idx').on(t.teacherId, t.weekday),
    check('schedule_weekday', sql`${t.weekday} BETWEEN 0 AND 6`),
    check('schedule_minutes', sql`${t.startMin} >= 0 AND ${t.endMin} <= 1440 AND ${t.startMin} < ${t.endMin}`),
  ],
);

export const appointments = pgTable(
  'appointments',
  {
    id: id(),
    relationId: integer('relation_id')
      .notNull()
      .references(() => serviceRelations.id),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    teacherId: integer('teacher_id')
      .notNull()
      .references(() => users.id),
    date: day('date').notNull(),
    startAt: tstz('start_at').notNull(),
    endAt: tstz('end_at').notNull(),
    status: appointmentStatus('status').notNull().default('booked'),
    cancelBy: cancelActor('cancel_by'),
    teacherJoinedAt: tstz('teacher_joined_at'),
    userJoinedAt: tstz('user_joined_at'),
    endedAt: tstz('ended_at'),
    confirmStatus: confirmStatus('confirm_status'),
    createdAt: createdAt(),
  },
  (t) => [
    index('appointments_teacher_date_idx').on(t.teacherId, t.date),
    index('appointments_relation_idx').on(t.relationId),
    index('appointments_user_idx').on(t.userId),
    index('appointments_status_start_idx').on(t.status, t.startAt),
    check('appointment_range', sql`${t.endAt} > ${t.startAt}`),
  ],
);

export const leaves = pgTable(
  'leaves',
  {
    id: id(),
    teacherId: integer('teacher_id')
      .notNull()
      .references(() => users.id),
    startDate: day('start_date').notNull(),
    endDate: day('end_date').notNull(),
    reason: text('reason').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [
    index('leaves_teacher_idx').on(t.teacherId, t.startDate),
    check('leave_dates', sql`${t.endDate} >= ${t.startDate}`),
  ],
);

export const substituteCandidates = pgTable(
  'substitute_candidates',
  {
    id: id(),
    leaveId: integer('leave_id')
      .notNull()
      .references(() => leaves.id),
    teacherId: integer('teacher_id')
      .notNull()
      .references(() => users.id),
    status: candidateStatus('status').notNull().default('invited'),
    respondedAt: tstz('responded_at'),
  },
  (t) => [
    unique('substitute_candidates_uq').on(t.leaveId, t.teacherId),
    index('substitute_candidates_teacher_idx').on(t.teacherId),
  ],
);

export const leaveChoices = pgTable(
  'leave_choices',
  {
    id: id(),
    leaveId: integer('leave_id')
      .notNull()
      .references(() => leaves.id),
    relationId: integer('relation_id')
      .notNull()
      .references(() => serviceRelations.id),
    status: choiceStatus('status').notNull().default('pending'),
    substituteTeacherId: integer('substitute_teacher_id').references(() => users.id),
    deadlineAt: tstz('deadline_at').notNull(),
    decidedAt: tstz('decided_at'),
  },
  (t) => [
    unique('leave_choices_uq').on(t.leaveId, t.relationId),
    index('leave_choices_due_idx').on(t.status, t.deadlineAt),
    check('leave_choice_substitute', sql`(${t.status} = 'substitute') = (${t.substituteTeacherId} IS NOT NULL)`),
  ],
);

export const crisisEvents = pgTable(
  'crisis_events',
  {
    id: id(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    peerId: integer('peer_id')
      .notNull()
      .references(() => users.id),
    keyword: text('keyword').notNull(),
    excerpt: text('excerpt').notNull(),
    status: crisisStatus('status').notNull().default('open'),
    handledBy: integer('handled_by').references(() => admins.id),
    handledNote: text('handled_note'),
    handledAt: tstz('handled_at'),
    createdAt: createdAt(),
  },
  (t) => [index('crisis_events_status_idx').on(t.status, t.createdAt)],
);

export const riskEvents = pgTable(
  'risk_events',
  {
    id: id(),
    fromUserId: integer('from_user_id')
      .notNull()
      .references(() => users.id),
    toUserId: integer('to_user_id')
      .notNull()
      .references(() => users.id),
    keyword: text('keyword').notNull(),
    excerpt: text('excerpt').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('risk_events_from_idx').on(t.fromUserId)],
);

export const replyWaits = pgTable(
  'reply_waits',
  {
    id: id(),
    teacherId: integer('teacher_id')
      .notNull()
      .references(() => users.id),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    relationId: integer('relation_id')
      .notNull()
      .references(() => serviceRelations.id),
    replyHours: integer('reply_hours').notNull(),
    askedAt: tstz('asked_at').notNull(),
    repliedAt: tstz('replied_at'),
  },
  (t) => [
    uniqueIndex('reply_waits_open_uq').on(t.teacherId, t.userId).where(sql`${t.repliedAt} IS NULL`),
    index('reply_waits_teacher_asked_idx').on(t.teacherId, t.askedAt),
  ],
);
```

生成迁移：

```bash
cd /data/workspace/ngr/wx/LiaoYu/apps/server
pnpm drizzle-kit generate --name service_delivery
pnpm drizzle-kit generate --custom --name service_delivery_constraints
```

Expected: 生成 `0002_service_delivery.sql`（9 张表、6 个枚举；`reply_waits_open_uq` 带 `WHERE "reply_waits"."replied_at" IS NULL`）和空的 `0003_service_delivery_constraints.sql`。

把 `src/db/migrations/0003_service_delivery_constraints.sql` 的内容替换为（`btree_gist` 扩展已在 `0001` 中创建）：

```sql
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_no_overlap"
  EXCLUDE USING gist ("teacher_id" WITH =, "weekday" WITH =, int4range("start_min", "end_min") WITH &&);
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_teacher_no_overlap"
  EXCLUDE USING gist ("teacher_id" WITH =, tstzrange("start_at", "end_at") WITH &&) WHERE ("status" = 'booked');
--> statement-breakpoint
ALTER TABLE "leaves" ADD CONSTRAINT "leaves_no_overlap"
  EXCLUDE USING gist ("teacher_id" WITH =, daterange("start_date", "end_date", '[]') WITH &&);
```

（`int4range` / `tstzrange` 默认左闭右开，所以首尾相接的时段不算重叠；请假用 `'[]'` 闭区间，首尾同日也算重叠。）

**Step 4: 实现配置与公共工具**

`src/config.ts`：`EnvSchema` 的 `z.object({...})` 中，在 `WX_APPSECRET` 之后加入

```ts
    TENCENT_SDKAPPID: z.coerce.number().int().nonnegative().default(0),
    TENCENT_SECRETKEY: z.string().default(''),
    IM_CALLBACK_TOKEN: z.string().default(''),
    TRTC_CALLBACK_KEY: z.string().default(''),
    CRISIS_HOTLINE: z.string().min(1).default('12356'),
```

`superRefine` 末尾加入（生产环境若走 MOCK，任何人都能伪造进房和回调，所以必须配置）：

```ts
    need(
      Boolean(e.TENCENT_SDKAPPID && e.TENCENT_SECRETKEY && e.IM_CALLBACK_TOKEN && e.TRTC_CALLBACK_KEY),
      'TENCENT_SECRETKEY',
      '生产环境必须配置 TENCENT_SDKAPPID/TENCENT_SECRETKEY/IM_CALLBACK_TOKEN/TRTC_CALLBACK_KEY',
    );
```

`loadConfig` 的返回对象在 `wx` 之后加入：

```ts
    tencent: {
      sdkAppId: e.TENCENT_SDKAPPID,
      secretKey: e.TENCENT_SECRETKEY,
      imCallbackToken: e.IM_CALLBACK_TOKEN,
      trtcCallbackKey: e.TRTC_CALLBACK_KEY,
    },
    crisisHotline: e.CRISIS_HOTLINE,
```

`src/lib/dates.ts` 末尾追加（`parse`、`fmt`、`CN_OFFSET_MS` 都是本文件已有的私有定义）：

```ts
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

export const addMs = (t: Date, ms: number): Date => new Date(t.getTime() + ms);

export const isValidDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && fmt(parse(s)) === s;

/** 0 = 周日 … 6 = 周六 */
export const weekdayOf = (d: string): number => new Date(parse(d)).getUTCDay();

/** 北京时间某日零点起第 minutes 分钟对应的时刻 */
export const cnTime = (d: string, minutes: number): Date => new Date(parse(d) - CN_OFFSET_MS + minutes * MINUTE_MS);

/** 入参须先经 Zod `HhMm` 校验 */
export function hhmmToMin(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

export const minToHhmm = (n: number): string =>
  `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
```

`src/lib/zod.ts` 整文件替换为：

```ts
import { z } from 'zod';
import { isValidDate } from './dates.ts';

export const DateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
  .refine(isValidDate, '日期不存在');
export const IdParam = z.coerce.number().int().positive();
export const HhMm = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, '时间格式应为 HH:MM');
```

`src/lib/notify.ts`：

```ts
import type { DbOrTx } from '../db/client.ts';
import { notifications } from '../db/schema.ts';

export type NotificationType =
  | 'appointment_booked'
  | 'appointment_cancelled'
  | 'teacher_no_show'
  | 'call_confirm_request'
  | 'call_disputed'
  | 'substitute_invite'
  | 'substitute_response'
  | 'substitute_available'
  | 'substitute_assigned'
  | 'substitute_revoked'
  | 'leave_notice'
  | 'leave_choice'
  | 'leave_choice_expired'
  | 'crisis_hotline'
  | 'crisis_alert'
  | 'private_trade_warning';

export interface Notice {
  userId: number;
  type: NotificationType;
  payload?: Record<string, unknown>;
}

export async function notify(db: DbOrTx, ...notices: Notice[]): Promise<void> {
  if (notices.length === 0) return;
  await db
    .insert(notifications)
    .values(notices.map((n) => ({ userId: n.userId, type: n.type, payload: n.payload ?? {} })));
}
```

`src/lib/pg-errors.ts`：

```ts
/** 取出触发的数据库约束名（兼容 Drizzle 把 pg 错误包在 cause 里） */
export function pgConstraint(err: unknown): string | undefined {
  const inner = err instanceof Error && err.cause instanceof Error ? err.cause : err;
  if (typeof inner !== 'object' || inner === null || !('constraint' in inner)) return undefined;
  return typeof inner.constraint === 'string' ? inner.constraint : undefined;
}
```

`src/modules/teachers/service.ts` 末尾追加：

```ts
/** 事务内锁住老师行。请假、排班、撤销代班用 update；预约用 share（锁顺序见「约定」） */
export async function lockTeacher(tx: DbOrTx, userId: number, mode: 'update' | 'share' = 'update') {
  const [t] = await tx
    .select({ level: teacherProfiles.level, status: teacherProfiles.status })
    .from(teacherProfiles)
    .where(eq(teacherProfiles.userId, userId))
    .for(mode);
  return t;
}
```

`src/modules/teachers/guard.ts`：

```ts
import type { FastifyRequest } from 'fastify';
import type { Deps } from '../../deps.ts';
import { userGuard } from '../auth/guards.ts';
import { requireActiveTeacher } from './service.ts';

export function teacherGuard(deps: Deps) {
  const user = userGuard(deps);
  return async (req: FastifyRequest): Promise<void> => {
    await user(req);
    await requireActiveTeacher(deps.db, req.userId);
  };
}
```

`src/modules/relations/service.ts` 末尾追加：

```ts
/** 事务内锁住服务关系行并返回最新数据 */
export async function lockRelation(tx: DbOrTx, relationId: number) {
  const [r] = await tx.select().from(serviceRelations).where(eq(serviceRelations.id, relationId)).for('update');
  return r;
}
```

`tests/helpers.ts`：
- 删除 `import { fixedClock } from '../src/lib/clock.ts';`，改为 `import type { Clock } from '../src/lib/clock.ts';`
- `drizzle-orm` 的 import 改为 `import { and, asc, eq } from 'drizzle-orm';`；schema 的 import 中补上 `notifications`
- 在 `FIXED_NOW` 之后加入：

```ts
export interface TestClock extends Clock {
  set(t: Date | string): void;
}

export function testClock(iso: string): TestClock {
  let t = new Date(iso).getTime();
  return {
    now: () => new Date(t),
    set: (v) => {
      t = new Date(v).getTime();
    },
  };
}
```

- `setup` 中的 `const clock = fixedClock(opts.now ?? FIXED_NOW);` 改为 `const clock = testClock(opts.now ?? FIXED_NOW);`
- 文件末尾追加：

```ts
export async function loginTeacher(
  ctx: Ctx,
  code: string,
  o: Parameters<typeof makeTeacherProfile>[2] = {},
): Promise<{ token: string; userId: number }> {
  const u = await loginUser(ctx, code);
  await makeTeacherProfile(ctx.db, u.userId, o);
  return u;
}

export async function noticesOf(db: DbOrTx, userId: number, type?: string) {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), type ? eq(notifications.type, type) : undefined))
    .orderBy(asc(notifications.id));
}
```

**Step 5: 运行，确认通过**

Run: `pnpm vitest run src/db src/lib src/config.test.ts`
Expected: 新增 8 个用例 PASS（数据库 5、日期 2、配置 1）。

Run（项目根）：`pnpm fix && pnpm check`
Expected: 全部通过。第一阶段用例不受影响：`fixedClock` 仍被 `auth.test.ts` 等直接使用；`DateStr` 只是更严格。

**Step 6: Commit**

```bash
git add apps/server
git commit -m "feat: 第二阶段 schema、腾讯云配置与公共工具"
```

---

### Task 2: 站内通知接口

**Files:**
- Create: `src/modules/notifications/service.ts`、`src/modules/notifications/routes.ts`
- Modify: `src/routes.ts`
- Test: `src/modules/notifications/notifications.test.ts`

**Step 1: 写失败测试**

`src/modules/notifications/notifications.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import { call, loginUser, noticesOf, setup } from '../../../tests/helpers.ts';
import { notify } from '../../lib/notify.ts';

const URL = '/api/notifications';

describe('站内通知', () => {
  test('列表倒序、未读筛选、标记已读只影响本人', async () => {
    const ctx = await setup();
    const u = await loginUser(ctx, 'u');
    const other = await loginUser(ctx, 'o');
    await notify(
      ctx.db,
      { userId: u.userId, type: 'appointment_booked', payload: { x: 1 } },
      { userId: u.userId, type: 'appointment_cancelled' },
      { userId: other.userId, type: 'appointment_booked' },
    );
    const list = async (query?: Record<string, string>) => (await call(ctx, 'GET', URL, { token: u.token, query })).json();
    const types = (rows: { type: string }[]) => rows.map((n) => n.type);

    const all = await list();
    expect(types(all)).toEqual(['appointment_cancelled', 'appointment_booked']);
    expect(all[1].payload).toEqual({ x: 1 });

    const r = await call(ctx, 'POST', `${URL}/read`, { token: u.token, body: { ids: [all[1].id] } });
    expect(r.json()).toEqual({ updated: 1 });
    expect(types(await list({ unread: '1' }))).toEqual(['appointment_cancelled']);

    expect((await call(ctx, 'POST', `${URL}/read`, { token: u.token, body: {} })).json()).toEqual({ updated: 1 });
    expect(await list({ unread: '1' })).toEqual([]);
    expect((await noticesOf(ctx.db, other.userId)).map((n) => n.isRead)).toEqual([false]);
  });

  test('未登录 401', async () => {
    const ctx = await setup();
    expect((await call(ctx, 'GET', URL)).statusCode).toBe(401);
  });
});
```

**Step 2: 运行，确认失败**

Run: `pnpm vitest run src/modules/notifications`
Expected: FAIL（模块不存在 / 404）。

**Step 3: 实现**

`src/modules/notifications/service.ts`：

```ts
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { notifications } from '../../db/schema.ts';

export async function listNotifications(db: DbOrTx, userId: number, unreadOnly: boolean) {
  return db
    .select({
      id: notifications.id,
      type: notifications.type,
      payload: notifications.payload,
      isRead: notifications.isRead,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), unreadOnly ? eq(notifications.isRead, false) : undefined))
    .orderBy(desc(notifications.id))
    .limit(100);
}

/** 不传 ids 表示全部标记已读 */
export async function markRead(db: DbOrTx, userId: number, ids?: number[]): Promise<number> {
  const rows = await db
    .update(notifications)
    .set({ isRead: true })
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.isRead, false),
        ids?.length ? inArray(notifications.id, ids) : undefined,
      ),
    )
    .returning({ id: notifications.id });
  return rows.length;
}
```

`src/modules/notifications/routes.ts`：

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { userGuard } from '../auth/guards.ts';
import { listNotifications, markRead } from './service.ts';

export const notificationRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.addHook('preHandler', userGuard(deps));

    app.get('/', { schema: { querystring: z.object({ unread: z.stringbool().optional() }) } }, async (req) =>
      listNotifications(deps.db, req.userId, req.query.unread ?? false),
    );

    app.post(
      '/read',
      { schema: { body: z.object({ ids: z.array(z.number().int().positive()).max(100).optional() }) } },
      async (req) => ({ updated: await markRead(deps.db, req.userId, req.body.ids) }),
    );
  };
```

`src/routes.ts` 加 import 并注册：

```ts
  await app.register(notificationRoutes(deps), { prefix: '/api/notifications' });
```

**Step 4: 运行，确认通过**

Run: `pnpm vitest run src/modules/notifications`
Expected: PASS（2 tests）。

**Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: 站内通知接口"
```

---

### Task 3: 分段改写纯函数（请假暂停、暂停↔代班）

**Files:**
- Modify: `src/domain/segments.ts`
- Test: `src/domain/segments-leave.test.ts`

**思路：** 服务关系的「有效天数」（非暂停天数）保持不变。请假相关的改写只改请假窗口内的日期类型，**不平移窗口外的分段**（否则同一关系上其他请假的代班分段会错位）。改完后用 `fitSpan` 在尾部裁掉或补齐原老师的正常日，让有效天数恢复原值。尾部补齐时如果遇到原老师的请假日（`blocked`），就补暂停日而不是正常日。

第一阶段的 `applyPause`（整体后移）保留不动，请假业务改用本 Task 的 `pauseRange`。

**Step 1: 写失败测试**

`src/domain/segments-leave.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import {
  applyPause,
  applySubstitute,
  initialSegments,
  inRange,
  pauseFromSubstitute,
  pauseRange,
  type Segment,
  substituteFromPause,
} from './segments.ts';

const seg = (kind: Segment['kind'], teacherId: number | null, startDate: string, endDate: string): Segment => ({
  kind,
  teacherId,
  startDate,
  endDate,
});
const LEAVE = { from: '2026-11-10', to: '2026-11-14', ownerId: 1, blocked: inRange('2026-11-10', '2026-11-14') };
const month = () => initialSegments(1, '2026-11-01', '2026-11-30');
const paused = () => pauseRange(month(), LEAVE);
const short = () => pauseRange(initialSegments(1, '2026-11-01', '2026-11-12'), LEAVE);

describe('请假分段改写', () => {
  test('pauseRange：窗口内正常日改为暂停并顺延，结果与 applyPause 一致', () => {
    expect(paused()).toEqual([
      seg('normal', 1, '2026-11-01', '2026-11-09'),
      seg('paused', null, '2026-11-10', '2026-11-14'),
      seg('normal', 1, '2026-11-15', '2026-12-05'),
    ]);
    expect(paused()).toEqual(applyPause(month(), { from: '2026-11-10', to: '2026-11-14' }));
  });

  test('pauseRange：服务在请假期间到期，顺延日跳过请假日', () => {
    expect(short()).toEqual([
      seg('normal', 1, '2026-11-01', '2026-11-09'),
      seg('paused', null, '2026-11-10', '2026-11-14'),
      seg('normal', 1, '2026-11-15', '2026-11-17'),
    ]);
  });

  test('pauseRange：不移动窗口外已有的代班分段', () => {
    const base = applySubstitute(month(), { from: '2026-11-20', to: '2026-11-21', teacherId: 3 });
    expect(pauseRange(base, { from: '2026-11-10', to: '2026-11-12', ownerId: 1 })).toEqual([
      seg('normal', 1, '2026-11-01', '2026-11-09'),
      seg('paused', null, '2026-11-10', '2026-11-12'),
      seg('normal', 1, '2026-11-13', '2026-11-19'),
      seg('substitute', 3, '2026-11-20', '2026-11-21'),
      seg('normal', 1, '2026-11-22', '2026-12-03'),
    ]);
  });

  test('暂停日部分改为代班，收回等量顺延天数', () => {
    expect(substituteFromPause(paused(), { ...LEAVE, from: '2026-11-12', teacherId: 2 })).toEqual([
      seg('normal', 1, '2026-11-01', '2026-11-09'),
      seg('paused', null, '2026-11-10', '2026-11-11'),
      seg('substitute', 2, '2026-11-12', '2026-11-14'),
      seg('normal', 1, '2026-11-15', '2026-12-02'),
    ]);
  });

  test('服务在请假期间到期：改为代班后结束日恢复原值', () => {
    expect(substituteFromPause(short(), { ...LEAVE, teacherId: 2 })).toEqual([
      seg('normal', 1, '2026-11-01', '2026-11-09'),
      seg('substitute', 2, '2026-11-10', '2026-11-12'),
    ]);
  });

  test('代班改回暂停：与直接暂停结果一致', () => {
    const sub = substituteFromPause(paused(), { ...LEAVE, teacherId: 2 });
    expect(pauseFromSubstitute(sub, { ...LEAVE, teacherId: 2 })).toEqual(paused());
    const shortSub = substituteFromPause(short(), { ...LEAVE, teacherId: 2 });
    expect(pauseFromSubstitute(shortSub, { ...LEAVE, teacherId: 2 })).toEqual(short());
  });

  test('只改写指定代班老师的分段', () => {
    const base = applySubstitute(month(), { from: '2026-11-10', to: '2026-11-10', teacherId: 3 });
    expect(pauseFromSubstitute(base, { from: '2026-11-01', to: '2026-11-30', teacherId: 2, ownerId: 1 })).toEqual(base);
  });

  test('请假已开始后才选代班：从当天起改为代班，已过去的暂停日保留', () => {
    const w = { from: '2026-11-01', to: '2026-11-05', ownerId: 1, blocked: inRange('2026-11-01', '2026-11-05') };
    const p = pauseRange(month(), w);
    expect(substituteFromPause(p, { ...w, from: '2026-11-03', teacherId: 2 })).toEqual([
      seg('paused', null, '2026-11-01', '2026-11-02'),
      seg('substitute', 2, '2026-11-03', '2026-11-05'),
      seg('normal', 1, '2026-11-06', '2026-12-02'),
    ]);
  });
});
```

**Step 2: 运行，确认失败**

Run: `pnpm vitest run src/domain/segments-leave.test.ts`
Expected: FAIL（`pauseRange` 等未导出）。

**Step 3: 实现**

`src/domain/segments.ts` 末尾追加（`Day`、`expand`、`compress` 是本文件已有的私有定义）：

```ts
export type DayPredicate = (date: string) => boolean;

const NEVER: DayPredicate = () => false;

export const inRange =
  (from: string, to: string): DayPredicate =>
  (d) =>
    d >= from && d <= to;

const countActive = (days: readonly Day[]): number => days.filter((d) => d.kind !== 'paused').length;

/** 调整尾部，让非暂停天数恢复为 span：多了从尾部裁掉；少了在尾部补原老师正常日（遇到 blocked 日补暂停日） */
function fitSpan(days: readonly Day[], span: number, ownerId: number, blocked: DayPredicate): Day[] {
  const out = days.slice();
  let active = countActive(out);
  while (active > span) {
    const d = out.pop();
    if (d && d.kind !== 'paused') active -= 1;
  }
  while (active < span) {
    const last = out.at(-1);
    if (!last) throw new Error('分段不能为空');
    const date = addDays(last.date, 1);
    if (blocked(date)) {
      out.push({ date, kind: 'paused', teacherId: null });
    } else {
      out.push({ date, kind: 'normal', teacherId: ownerId });
      active += 1;
    }
  }
  while (out.at(-1)?.kind === 'paused') out.pop();
  return out;
}

export interface LeaveWindow {
  from: string;
  to: string;
  /** 原老师（服务关系的购买对象） */
  ownerId: number;
  /** 原老师的请假日，尾部补齐时跳过 */
  blocked?: DayPredicate;
}

interface RemapOptions extends LeaveWindow {
  match: (d: Day) => boolean;
  into: Pick<Day, 'kind' | 'teacherId'>;
}

function remap(segments: readonly Segment[], { from, to, match, into, ownerId, blocked = NEVER }: RemapOptions): Segment[] {
  const days = expand(segments);
  const span = countActive(days);
  const mapped = days.map((d) => (d.date >= from && d.date <= to && match(d) ? { ...d, ...into } : d));
  return compress(fitSpan(mapped, span, ownerId, blocked));
}

export const pauseRange = (segments: readonly Segment[], w: LeaveWindow): Segment[] =>
  remap(segments, {
    ...w,
    blocked: w.blocked ?? inRange(w.from, w.to),
    match: (d) => d.kind === 'normal' && d.teacherId === w.ownerId,
    into: { kind: 'paused', teacherId: null },
  });

export const substituteFromPause = (segments: readonly Segment[], w: LeaveWindow & { teacherId: number }): Segment[] =>
  remap(segments, {
    ...w,
    match: (d) => d.kind === 'paused',
    into: { kind: 'substitute', teacherId: w.teacherId },
  });

export const pauseFromSubstitute = (segments: readonly Segment[], w: LeaveWindow & { teacherId: number }): Segment[] =>
  remap(segments, {
    ...w,
    match: (d) => d.kind === 'substitute' && d.teacherId === w.teacherId,
    into: { kind: 'paused', teacherId: null },
  });
```

**Step 4: 运行，确认通过**

Run: `pnpm vitest run src/domain`
Expected: PASS（新增 8 个，加上第一阶段 `segments.test.ts` 的 5 个）。

**Step 5: Commit**

```bash
git add apps/server/src/domain
git commit -m "feat: 请假分段改写纯函数（窗口暂停、暂停↔代班）"
```

---

### Task 4: 老师周排班

**Files:**
- Create: `src/modules/schedule/service.ts`、`src/modules/schedule/routes.ts`
- Modify: `src/routes.ts`
- Test: `src/modules/schedule/schedule.test.ts`

**Step 1: 写失败测试**

`src/modules/schedule/schedule.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import { type Ctx, call, loginTeacher, loginUser, setup } from '../../../tests/helpers.ts';

const URL = '/api/teacher/schedule';
const put = (ctx: Ctx, token: string, items: unknown) => call(ctx, 'PUT', URL, { token, body: { items } });

describe('老师周排班', () => {
  test('设置并读取周排班；重新设置会整体覆盖', async () => {
    const ctx = await setup();
    const t = await loginTeacher(ctx, 't1');
    const items = [
      { weekday: 1, start: '14:00', end: '16:30' },
      { weekday: 1, start: '09:00', end: '12:00' },
    ];
    const saved = await put(ctx, t.token, items);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual([items[1], items[0]]);
    expect((await call(ctx, 'GET', URL, { token: t.token })).json()).toEqual([items[1], items[0]]);

    await put(ctx, t.token, [{ weekday: 3, start: '19:00', end: '24:00' }]);
    expect((await call(ctx, 'GET', URL, { token: t.token })).json()).toEqual([{ weekday: 3, start: '19:00', end: '24:00' }]);
  });

  test('时段非法或重叠返回 400', async () => {
    const ctx = await setup();
    const t = await loginTeacher(ctx, 't1');
    const bad = [
      [{ weekday: 7, start: '09:00', end: '10:00' }],
      [{ weekday: 1, start: '10:00', end: '09:00' }],
      [{ weekday: 1, start: '9:00', end: '10:00' }],
      [
        { weekday: 1, start: '09:00', end: '11:00' },
        { weekday: 1, start: '10:00', end: '12:00' },
      ],
    ];
    for (const items of bad) expect((await put(ctx, t.token, items)).statusCode).toBe(400);
    expect((await call(ctx, 'PUT', URL, { token: t.token, body: {} })).statusCode).toBe(400);
  });

  test('非老师 403', async () => {
    const ctx = await setup();
    const u = await loginUser(ctx, 'u1');
    expect((await put(ctx, u.token, [])).statusCode).toBe(403);
  });
});
```

**Step 2: 运行，确认失败**

Run: `pnpm vitest run src/modules/schedule`
Expected: FAIL（404）。

**Step 3: 实现**

`src/modules/schedule/service.ts`：

```ts
import { asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { schedules } from '../../db/schema.ts';
import { hhmmToMin, minToHhmm } from '../../lib/dates.ts';
import { HttpError } from '../../lib/errors.ts';
import { lockTeacher } from '../teachers/service.ts';

export interface ScheduleItem {
  weekday: number;
  start: string;
  end: string;
}

export function parseSchedule(items: readonly ScheduleItem[]) {
  const rows = items.map((it) => ({ weekday: it.weekday, startMin: hhmmToMin(it.start), endMin: hhmmToMin(it.end) }));
  if (rows.some((r) => r.startMin >= r.endMin)) throw new HttpError(400, '排班时段非法：结束须晚于开始');
  rows.sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].weekday === rows[i - 1].weekday && rows[i].startMin < rows[i - 1].endMin) {
      throw new HttpError(400, '排班时段重叠');
    }
  }
  return rows;
}

export async function setSchedule(db: DbOrTx, teacherId: number, items: readonly ScheduleItem[]): Promise<void> {
  const rows = parseSchedule(items);
  await db.transaction(async (tx) => {
    // 与预约（FOR SHARE）互斥，避免预约读到半新半旧的排班
    await lockTeacher(tx, teacherId);
    await tx.delete(schedules).where(eq(schedules.teacherId, teacherId));
    if (rows.length > 0) await tx.insert(schedules).values(rows.map((r) => ({ teacherId, ...r })));
  });
}

export async function getSchedule(db: DbOrTx, teacherId: number): Promise<ScheduleItem[]> {
  const rows = await db
    .select({ weekday: schedules.weekday, startMin: schedules.startMin, endMin: schedules.endMin })
    .from(schedules)
    .where(eq(schedules.teacherId, teacherId))
    .orderBy(asc(schedules.weekday), asc(schedules.startMin));
  return rows.map((r) => ({ weekday: r.weekday, start: minToHhmm(r.startMin), end: minToHhmm(r.endMin) }));
}
```

`src/modules/schedule/routes.ts`：

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { HhMm } from '../../lib/zod.ts';
import { teacherGuard } from '../teachers/guard.ts';
import { getSchedule, setSchedule } from './service.ts';

const Item = z.object({ weekday: z.number().int().min(0).max(6), start: HhMm, end: HhMm });

export const teacherScheduleRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.addHook('preHandler', teacherGuard(deps));

    app.get('/', async (req) => getSchedule(deps.db, req.userId));

    app.put('/', { schema: { body: z.object({ items: z.array(Item).max(50) }) } }, async (req) => {
      await setSchedule(deps.db, req.userId, req.body.items);
      return getSchedule(deps.db, req.userId);
    });
  };
```

`src/routes.ts` 加 import 并注册：

```ts
  await app.register(teacherScheduleRoutes(deps), { prefix: '/api/teacher/schedule' });
```

**Step 4: 运行，确认通过**

Run: `pnpm vitest run src/modules/schedule`
Expected: PASS（3 tests）。

**Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: 老师周排班"
```

---

### Task 5: 可约时段、预约与取消

**Files:**
- Create: `src/modules/appointments/service.ts`、`src/modules/appointments/routes.ts`
- Modify: `src/routes.ts`
- Test: `src/modules/appointments/appointments.test.ts`

**规则：** 见文首规则表中的「通话时长 / 可预约窗口 / 预约归属 / 用户取消 / 老师取消」。老师请假日没有可约时段（`leaves` 表已在 Task 1 建好，请假业务在 Task 6 实现）。

**并发：** 预约先无锁读出当天负责老师，然后在事务内按顺序「老师行 FOR SHARE → 服务关系行 FOR UPDATE」加锁，再读一遍负责老师做校验。老师行的共享锁与请假、排班保存的排他锁互斥；两个人同时约同一时段时，由排他约束 `appointments_teacher_no_overlap` 兜底，转成 409。

**Step 1: 写失败测试**

`src/modules/appointments/appointments.test.ts`：

```ts
import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { buyAndPay, call, insertPackage, loginTeacher, loginUser, noticesOf, setup } from '../../../tests/helpers.ts';
import { leaves, serviceRelations } from '../../db/schema.ts';
import { applyPause, applySubstitute } from '../../domain/segments.ts';
import { addMs, HOUR_MS } from '../../lib/dates.ts';
import { rewriteSegments } from '../relations/service.ts';
import { setSchedule } from '../schedule/service.ts';
import { cancelByUser } from './service.ts';

const MON = '2026-11-02';

async function world() {
  const ctx = await setup();
  const t = await loginTeacher(ctx, 't1');
  const sub = await loginTeacher(ctx, 't2');
  const u = await loginUser(ctx, 'u1');
  await setSchedule(ctx.db, t.userId, [{ weekday: 1, start: '09:00', end: '12:00' }]);
  await setSchedule(ctx.db, sub.userId, [{ weekday: 1, start: '14:00', end: '16:00' }]);
  const pkg = await insertPackage(ctx.db, t.userId);
  const rel = await buyAndPay(ctx, u.userId, pkg);
  return { ctx, db: ctx.db, t, sub, u, rel, pkg };
}
type World = Awaited<ReturnType<typeof world>>;

const slots = (w: World) =>
  call(w.ctx, 'GET', '/api/appointments/slots', { token: w.u.token, query: { relationId: w.rel.id, date: MON } });
const book = (w: World, start: string, date = MON, who = w.u, relationId = w.rel.id) =>
  call(w.ctx, 'POST', '/api/appointments', { token: who.token, body: { relationId, date, start } });
async function callsLeft(w: World): Promise<number> {
  const [r] = await w.db
    .select({ n: serviceRelations.callsLeft })
    .from(serviceRelations)
    .where(eq(serviceRelations.id, w.rel.id));
  return r.n;
}

describe('可约时段与预约', () => {
  test('按负责老师的排班返回可约时段', async () => {
    const w = await world();
    const res = await slots(w);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ teacherId: w.t.userId, slots: ['09:00', '09:30', '10:00', '10:30', '11:00'] });
  });

  test('预约成功：扣次数、占用时段、通知老师', async () => {
    const w = await world();
    const r = await book(w, '10:00');
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      teacherId: w.t.userId,
      date: MON,
      startAt: '2026-11-02T02:00:00.000Z',
      endAt: '2026-11-02T03:00:00.000Z',
      status: 'booked',
    });
    expect(await callsLeft(w)).toBe(3);
    expect((await slots(w)).json().slots).toEqual(['09:00', '11:00']);
    expect(await noticesOf(w.db, w.t.userId, 'appointment_booked')).toHaveLength(1);
  });

  test('不可约时段 409、服务期外 400、次数用完 409', async () => {
    const w = await world();
    expect((await book(w, '08:00')).statusCode).toBe(409);
    expect((await book(w, '09:00', '2026-12-07')).statusCode).toBe(400);
    await w.db.update(serviceRelations).set({ callsLeft: 0 });
    expect((await book(w, '09:00')).statusCode).toBe(409);
  });

  test('暂停日不可约', async () => {
    const w = await world();
    await rewriteSegments(w.db, w.rel.id, (s) => applyPause(s, { from: MON, to: MON }));
    expect((await slots(w)).json()).toEqual({ teacherId: null, slots: [] });
    expect((await book(w, '09:00')).statusCode).toBe(409);
  });

  test('代班日按代班老师排班，预约归代班老师', async () => {
    const w = await world();
    await rewriteSegments(w.db, w.rel.id, (s) => applySubstitute(s, { from: MON, to: MON, teacherId: w.sub.userId }));
    expect((await slots(w)).json()).toEqual({ teacherId: w.sub.userId, slots: ['14:00', '14:30', '15:00'] });
    expect((await book(w, '14:00')).json().teacherId).toBe(w.sub.userId);
  });

  test('同一时段并发预约只成功一个', async () => {
    const w = await world();
    const u2 = await loginUser(w.ctx, 'u2');
    const rel2 = await buyAndPay(w.ctx, u2.userId, w.pkg);
    const rs = await Promise.all([book(w, '10:00'), book(w, '10:00', MON, u2, rel2.id)]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });
});

describe('取消预约', () => {
  test('用户取消：开始前 12 小时以上可取消并退次数，之后不可', async () => {
    const w = await world();
    const a = (await book(w, '10:00')).json();
    const late = addMs(new Date(a.startAt), -11 * HOUR_MS);
    await expect(cancelByUser(w.db, late, { userId: w.u.userId, id: a.id })).rejects.toThrow(/12 小时/);

    const ok = await call(w.ctx, 'POST', `/api/appointments/${a.id}/cancel`, { token: w.u.token });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'cancelled', cancelBy: 'user' });
    expect(await callsLeft(w)).toBe(4);
    expect((await call(w.ctx, 'POST', `/api/appointments/${a.id}/cancel`, { token: w.u.token })).statusCode).toBe(409);
  });

  test('老师取消：退次数并通知用户；不能取消别人的预约', async () => {
    const w = await world();
    const a = (await book(w, '10:00')).json();
    const url = `/api/teacher/appointments/${a.id}/cancel`;
    expect((await call(w.ctx, 'POST', url, { token: w.sub.token })).statusCode).toBe(404);
    const r = await call(w.ctx, 'POST', url, { token: w.t.token });
    expect(r.json()).toMatchObject({ status: 'cancelled', cancelBy: 'teacher' });
    expect(await callsLeft(w)).toBe(4);
    expect(await noticesOf(w.db, w.u.userId, 'appointment_cancelled')).toHaveLength(1);
  });

  test('用户与老师都能看到预约列表；老师请假日无可约时段', async () => {
    const w = await world();
    await book(w, '10:00');
    const mine = (await call(w.ctx, 'GET', '/api/appointments', { token: w.u.token })).json();
    expect(mine).toHaveLength(1);
    expect(mine[0].teacherName).toBe(`老师${w.t.userId}`);
    expect((await call(w.ctx, 'GET', '/api/teacher/appointments', { token: w.t.token })).json()).toHaveLength(1);

    await w.db.insert(leaves).values({ teacherId: w.t.userId, startDate: MON, endDate: MON });
    expect((await slots(w)).json().slots).toEqual([]);
  });
});
```

**Step 2: 运行，确认失败**

Run: `pnpm vitest run src/modules/appointments`
Expected: FAIL（模块不存在）。

**Step 3: 实现**

`src/modules/appointments/service.ts`：

```ts
import { and, asc, desc, eq, getTableColumns, gte, lte, type SQL, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import {
  appointments,
  type CancelActor,
  leaves,
  schedules,
  serviceRelations,
  teacherProfiles,
  users,
} from '../../db/schema.ts';
import { segmentOn } from '../../domain/segments.ts';
import { addDays, cnTime, HOUR_MS, hhmmToMin, MINUTE_MS, minToHhmm, todayCN, weekdayOf } from '../../lib/dates.ts';
import { HttpError } from '../../lib/errors.ts';
import { notify } from '../../lib/notify.ts';
import { pgConstraint } from '../../lib/pg-errors.ts';
import { loadSegments, lockRelation } from '../relations/service.ts';
import { lockTeacher } from '../teachers/service.ts';

export const CALL_MINUTES = 60;
export const SLOT_STEP_MINUTES = 30;
export const BOOK_LEAD_MINUTES = 60;
export const BOOK_WINDOW_DAYS = 14;
export const USER_CANCEL_HOURS = 12;

export type Appointment = typeof appointments.$inferSelect;
type Relation = typeof serviceRelations.$inferSelect;

export async function getAppointment(db: DbOrTx, id: number): Promise<Appointment | undefined> {
  const [a] = await db.select().from(appointments).where(eq(appointments.id, id));
  return a;
}

export async function teacherOnLeave(db: DbOrTx, teacherId: number, date: string): Promise<boolean> {
  const rows = await db
    .select({ id: leaves.id })
    .from(leaves)
    .where(and(eq(leaves.teacherId, teacherId), lte(leaves.startDate, date), gte(leaves.endDate, date)))
    .limit(1);
  return rows.length > 0;
}

export async function availableSlots(db: DbOrTx, now: Date, teacherId: number, date: string): Promise<string[]> {
  const today = todayCN(now);
  if (date < today || date > addDays(today, BOOK_WINDOW_DAYS)) return [];
  if (await teacherOnLeave(db, teacherId, date)) return [];
  const windows = await db
    .select({ startMin: schedules.startMin, endMin: schedules.endMin })
    .from(schedules)
    .where(and(eq(schedules.teacherId, teacherId), eq(schedules.weekday, weekdayOf(date))))
    .orderBy(asc(schedules.startMin));
  const busy = await db
    .select({ startAt: appointments.startAt, endAt: appointments.endAt })
    .from(appointments)
    .where(and(eq(appointments.teacherId, teacherId), eq(appointments.date, date), eq(appointments.status, 'booked')));

  const earliest = now.getTime() + BOOK_LEAD_MINUTES * MINUTE_MS;
  const out: string[] = [];
  for (const w of windows) {
    const first = Math.ceil(w.startMin / SLOT_STEP_MINUTES) * SLOT_STEP_MINUTES;
    for (let m = first; m + CALL_MINUTES <= w.endMin; m += SLOT_STEP_MINUTES) {
      const s = cnTime(date, m).getTime();
      const e = s + CALL_MINUTES * MINUTE_MS;
      if (s < earliest) continue;
      if (busy.some((b) => b.startAt.getTime() < e && s < b.endAt.getTime())) continue;
      out.push(minToHhmm(m));
    }
  }
  return out;
}

/** 某日负责该服务关系的老师；暂停日或不在服务期内为 null */
export async function responsibleTeacher(db: DbOrTx, relationId: number, date: string): Promise<number | null> {
  const seg = segmentOn(await loadSegments(db, relationId), date);
  return seg && seg.kind !== 'paused' ? seg.teacherId : null;
}

async function getUserRelation(db: DbOrTx, relationId: number, userId: number): Promise<Relation> {
  const [r] = await db
    .select()
    .from(serviceRelations)
    .where(and(eq(serviceRelations.id, relationId), eq(serviceRelations.userId, userId)));
  if (!r) throw new HttpError(404, '服务不存在');
  return r;
}

function assertBookable(rel: Relation, date: string): void {
  if (rel.status !== 'active' || rel.frozen) throw new HttpError(409, '该服务当前不可预约');
  if (date < rel.startDate || date > rel.endDate) throw new HttpError(400, '预约日期不在服务期内');
  if (rel.callsLeft <= 0) throw new HttpError(409, '通话次数已用完');
}

export async function slotsForRelation(
  db: DbOrTx,
  now: Date,
  q: { userId: number; relationId: number; date: string },
): Promise<{ teacherId: number | null; slots: string[] }> {
  const rel = await getUserRelation(db, q.relationId, q.userId);
  if (rel.status !== 'active' || rel.frozen || q.date < rel.startDate || q.date > rel.endDate) {
    return { teacherId: null, slots: [] };
  }
  const teacherId = await responsibleTeacher(db, rel.id, q.date);
  return { teacherId, slots: teacherId === null ? [] : await availableSlots(db, now, teacherId, q.date) };
}

export async function book(
  db: DbOrTx,
  now: Date,
  input: { userId: number; relationId: number; date: string; start: string },
): Promise<Appointment> {
  assertBookable(await getUserRelation(db, input.relationId, input.userId), input.date);
  const teacherId = await responsibleTeacher(db, input.relationId, input.date);
  if (teacherId === null) throw new HttpError(409, '该日期服务暂停，不可预约');

  try {
    return await db.transaction(async (tx) => {
      await lockTeacher(tx, teacherId, 'share');
      const rel = await lockRelation(tx, input.relationId);
      if (!rel || rel.userId !== input.userId) throw new HttpError(404, '服务不存在');
      assertBookable(rel, input.date);
      if ((await responsibleTeacher(tx, rel.id, input.date)) !== teacherId) {
        throw new HttpError(409, '服务安排已变化，请刷新后重试');
      }
      if (!(await availableSlots(tx, now, teacherId, input.date)).includes(input.start)) {
        throw new HttpError(409, '该时段不可预约');
      }
      const startAt = cnTime(input.date, hhmmToMin(input.start));
      const [a] = await tx
        .insert(appointments)
        .values({
          relationId: rel.id,
          userId: input.userId,
          teacherId,
          date: input.date,
          startAt,
          endAt: new Date(startAt.getTime() + CALL_MINUTES * MINUTE_MS),
        })
        .returning();
      await tx
        .update(serviceRelations)
        .set({ callsLeft: sql`${serviceRelations.callsLeft} - 1` })
        .where(eq(serviceRelations.id, rel.id));
      await notify(tx, {
        userId: teacherId,
        type: 'appointment_booked',
        payload: { appointmentId: a.id, date: input.date, start: input.start },
      });
      return a;
    });
  } catch (e) {
    if (pgConstraint(e) === 'appointments_teacher_no_overlap') throw new HttpError(409, '该时段已被预约');
    throw e;
  }
}

/**
 * 释放一个仍为 booked 的预约（取消 / 爽约），退还次数。
 * 调用方须在事务中；按「服务关系 → 预约」顺序加锁。已不是 booked 时返回 null。
 */
export async function releaseCall(
  tx: DbOrTx,
  a: Appointment,
  patch: Partial<typeof appointments.$inferInsert>,
  extra?: SQL,
): Promise<Appointment | null> {
  await lockRelation(tx, a.relationId);
  const [row] = await tx
    .update(appointments)
    .set(patch)
    .where(and(eq(appointments.id, a.id), eq(appointments.status, 'booked'), extra))
    .returning();
  if (!row) return null;
  await tx
    .update(serviceRelations)
    .set({ callsLeft: sql`${serviceRelations.callsLeft} + 1` })
    .where(eq(serviceRelations.id, a.relationId));
  return row;
}

async function cancelOwn(db: DbOrTx, a: Appointment, by: 'user' | 'teacher'): Promise<Appointment> {
  return db.transaction(async (tx) => {
    const row = await releaseCall(tx, a, { status: 'cancelled', cancelBy: by });
    if (!row) throw new HttpError(409, '该预约不可取消');
    await notify(tx, {
      userId: by === 'user' ? a.teacherId : a.userId,
      type: 'appointment_cancelled',
      payload: { appointmentId: a.id, by },
    });
    return row;
  });
}

export async function cancelByUser(db: DbOrTx, now: Date, q: { userId: number; id: number }): Promise<Appointment> {
  const a = await getAppointment(db, q.id);
  if (!a || a.userId !== q.userId) throw new HttpError(404, '预约不存在');
  if (a.status !== 'booked') throw new HttpError(409, '该预约不可取消');
  if (a.startAt.getTime() - now.getTime() < USER_CANCEL_HOURS * HOUR_MS) {
    throw new HttpError(409, `开始前 ${USER_CANCEL_HOURS} 小时内不可取消，请联系老师`);
  }
  return cancelOwn(db, a, 'user');
}

export async function cancelByTeacher(db: DbOrTx, now: Date, q: { teacherId: number; id: number }): Promise<Appointment> {
  const a = await getAppointment(db, q.id);
  if (!a || a.teacherId !== q.teacherId) throw new HttpError(404, '预约不存在');
  if (a.status !== 'booked') throw new HttpError(409, '该预约不可取消');
  if (a.startAt.getTime() <= now.getTime()) throw new HttpError(409, '已开始的预约不可取消');
  return cancelOwn(db, a, 'teacher');
}

/** 批量取消某老师在日期区间内的预约（请假 / 撤销代班使用）。调用方须在事务中 */
export async function cancelAppointments(
  tx: DbOrTx,
  f: { teacherId: number; from: string; to: string; relationId?: number },
  by: CancelActor,
): Promise<number> {
  const rows = await tx
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.status, 'booked'),
        eq(appointments.teacherId, f.teacherId),
        gte(appointments.date, f.from),
        lte(appointments.date, f.to),
        f.relationId ? eq(appointments.relationId, f.relationId) : undefined,
      ),
    )
    .orderBy(asc(appointments.relationId), asc(appointments.id));
  let n = 0;
  for (const a of rows) {
    if (!(await releaseCall(tx, a, { status: 'cancelled', cancelBy: by }))) continue;
    n += 1;
    await notify(tx, { userId: a.userId, type: 'appointment_cancelled', payload: { appointmentId: a.id, by } });
  }
  return n;
}

export async function listForUser(db: DbOrTx, userId: number) {
  return db
    .select({ ...getTableColumns(appointments), teacherName: teacherProfiles.displayName })
    .from(appointments)
    .innerJoin(teacherProfiles, eq(teacherProfiles.userId, appointments.teacherId))
    .where(eq(appointments.userId, userId))
    .orderBy(desc(appointments.startAt));
}

export async function listForTeacher(db: DbOrTx, teacherId: number) {
  return db
    .select({ ...getTableColumns(appointments), userNickname: users.nickname })
    .from(appointments)
    .innerJoin(users, eq(users.id, appointments.userId))
    .where(eq(appointments.teacherId, teacherId))
    .orderBy(desc(appointments.startAt));
}

// 后续 Task 在此追加：进入通话、房间回调、爽约、自动完成、单次确认
```

`src/modules/appointments/routes.ts`：

```ts
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
```

`src/routes.ts` 加 import 并注册：

```ts
  await app.register(appointmentRoutes(deps), { prefix: '/api/appointments' });
  await app.register(teacherAppointmentRoutes(deps), { prefix: '/api/teacher/appointments' });
```

**Step 4: 运行，确认通过**

Run: `pnpm vitest run src/modules/appointments`
Expected: PASS（9 tests）。

**Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: 可约时段、预约与取消"
```

---

### Task 6: 请假与代班邀请

**Files:**
- Create: `src/modules/leaves/service.ts`、`src/modules/leaves/routes.ts`
- Modify: `src/routes.ts`
- Test: `src/modules/leaves/leaves.test.ts`

**规则：**
- 校验顺序：日期合法（结束日 ≥ 开始日、开始日 ≥ 今天、≤ 60 天）→ 候选 1~3 位、不含自己 → 与自己已有请假不重叠（409）→ 自己没有已同意且时段重叠的代班（409）→ 每位候选是已认证老师、等级 ≥ 自己当前等级、该时段不在请假（400）。
- 生效（同一事务）：写请假与候选；**自动拒绝自己未处理且时段重叠的代班邀请**；取消自己在请假区间内的预约（退次数、通知学员）；对每条受影响服务关系执行 `pauseRange`，生成 48 小时期限的待选择项并通知学员。
- 受影响服务关系：原老师是自己、`active`、请假窗口内有正常分段；单次套餐只在还有剩余次数时才算（先取消预约退还次数，再筛选）。
- 候选老师接受或拒绝邀请（只能处理 `invited` 状态），通知原老师；接受时还要通知该请假下仍待选择的学员。

**并发：** 提交请假先锁自己的老师行（FOR UPDATE），与本人的预约、排班保存、接受代班互斥；同一老师并发提交重叠请假时，后到者在锁后复查到重叠返回 409，`leaves_no_overlap` 兜底。接受邀请锁的是**候选老师自己**的老师行，与该老师提交请假串行，从而保证「已答应代班 ↔ 自己请假」两个方向的检查不会同时漏掉。提交请假时只对候选做预检，不锁候选老师行（多把老师锁容易死锁）；候选是否真的能代班，以接受邀请时的锁内复查为准。

**Step 1: 写失败测试**

`src/modules/leaves/leaves.test.ts`：

```ts
import { and, eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { buyAndPay, call, insertPackage, loginTeacher, loginUser, noticesOf, setup } from '../../../tests/helpers.ts';
import { leaveChoices, leaves, serviceRelations, substituteCandidates } from '../../db/schema.ts';
import { availableSlots, book, getAppointment } from '../appointments/service.ts';
import { loadSegments } from '../relations/service.ts';
import { setSchedule } from '../schedule/service.ts';

async function world() {
  const ctx = await setup();
  const t = await loginTeacher(ctx, 't', { level: 2 });
  const s1 = await loginTeacher(ctx, 's1', { level: 2 });
  const s2 = await loginTeacher(ctx, 's2', { level: 3 });
  const low = await loginTeacher(ctx, 'low', { level: 1 });
  const u = await loginUser(ctx, 'u');
  const rel = await buyAndPay(ctx, u.userId, await insertPackage(ctx.db, t.userId));
  return { ctx, db: ctx.db, t, s1, s2, low, u, rel };
}
type World = Awaited<ReturnType<typeof world>>;
type Who = { token: string; userId: number };

const LEAVE = { startDate: '2026-11-10', endDate: '2026-11-14', reason: '出差' };
const apply = (w: World, who: Who, body: object) =>
  call(w.ctx, 'POST', '/api/teacher/leaves', { token: who.token, body });
const respond = (w: World, who: Who, leaveId: number, accept: boolean) =>
  call(w.ctx, 'POST', `/api/teacher/substitute-invites/${leaveId}/respond`, { token: who.token, body: { accept } });

describe('请假', () => {
  test('参数校验', async () => {
    const w = await world();
    const ok = [w.s1.userId];
    const status = async (who: Who, body: object) => (await apply(w, who, body)).statusCode;
    expect(await status(w.u, { ...LEAVE, candidateIds: ok })).toBe(403);
    expect(await status(w.t, { ...LEAVE, startDate: '2026-10-31', candidateIds: ok })).toBe(400);
    expect(await status(w.t, { ...LEAVE, endDate: '2026-11-09', candidateIds: ok })).toBe(400);
    expect(await status(w.t, { ...LEAVE, endDate: '2027-01-10', candidateIds: ok })).toBe(400);
    expect(await status(w.t, { ...LEAVE, candidateIds: [] })).toBe(400);
    expect(
      await status(w.t, { ...LEAVE, candidateIds: [w.s1.userId, w.s2.userId, w.low.userId, w.u.userId] }),
    ).toBe(400);
    expect(await status(w.t, { ...LEAVE, candidateIds: [w.t.userId] })).toBe(400);
    expect(await status(w.t, { ...LEAVE, candidateIds: [w.low.userId] })).toBe(400);
    expect(await status(w.t, { ...LEAVE, candidateIds: [w.u.userId] })).toBe(400);
  });

  test('生效：学员分段暂停顺延、生成待选择、通知学员与候选老师', async () => {
    const w = await world();
    const res = await apply(w, w.t, { ...LEAVE, candidateIds: [w.s1.userId, w.s2.userId] });
    expect(res.statusCode).toBe(201);
    expect(await loadSegments(w.db, w.rel.id)).toEqual([
      { kind: 'normal', teacherId: w.t.userId, startDate: '2026-11-01', endDate: '2026-11-09' },
      { kind: 'paused', teacherId: null, startDate: '2026-11-10', endDate: '2026-11-14' },
      { kind: 'normal', teacherId: w.t.userId, startDate: '2026-11-15', endDate: '2026-12-05' },
    ]);
    const [r] = await w.db.select().from(serviceRelations);
    expect(r.endDate).toBe('2026-12-05');

    const [choice] = await w.db.select().from(leaveChoices);
    expect(choice).toMatchObject({ status: 'pending', relationId: w.rel.id });
    expect(choice.deadlineAt.toISOString()).toBe('2026-11-03T04:00:00.000Z');
    expect(await noticesOf(w.db, w.u.userId, 'leave_notice')).toHaveLength(1);
    expect(await noticesOf(w.db, w.s1.userId, 'substitute_invite')).toHaveLength(1);
    expect(await noticesOf(w.db, w.s2.userId, 'substitute_invite')).toHaveLength(1);

    const mine = (await call(w.ctx, 'GET', '/api/teacher/leaves', { token: w.t.token })).json();
    expect(mine).toHaveLength(1);
    expect(mine[0].candidates.map((c: { status: string }) => c.status)).toEqual(['invited', 'invited']);
    expect(mine[0].choices).toHaveLength(1);
  });

  test('请假期间已有预约自动取消并退还次数，请假日不可约', async () => {
    const w = await world();
    const now = w.ctx.clock.now();
    await setSchedule(w.db, w.t.userId, [{ weekday: 2, start: '09:00', end: '12:00' }]);
    const a = await book(w.db, now, { userId: w.u.userId, relationId: w.rel.id, date: '2026-11-10', start: '10:00' });
    await apply(w, w.t, { ...LEAVE, candidateIds: [w.s1.userId] });
    expect(await getAppointment(w.db, a.id)).toMatchObject({ status: 'cancelled', cancelBy: 'leave' });
    const [r] = await w.db.select().from(serviceRelations);
    expect(r.callsLeft).toBe(4);
    expect(await availableSlots(w.db, now, w.t.userId, '2026-11-10')).toEqual([]);
  });

  test('与已有请假重叠 409；候选老师同时段在请假 400', async () => {
    const w = await world();
    expect((await apply(w, w.t, { ...LEAVE, candidateIds: [w.s1.userId] })).statusCode).toBe(201);
    const overlap = { startDate: '2026-11-14', endDate: '2026-11-16', candidateIds: [w.s1.userId] };
    expect((await apply(w, w.t, overlap)).statusCode).toBe(409);
    await w.db.insert(leaves).values({ teacherId: w.s2.userId, startDate: '2026-11-20', endDate: '2026-11-22' });
    const busy = { startDate: '2026-11-21', endDate: '2026-11-21', candidateIds: [w.s2.userId] };
    expect((await apply(w, w.t, busy)).statusCode).toBe(400);
  });

  test('并发提交重叠请假只成功一个', async () => {
    const w = await world();
    const rs = await Promise.all([
      apply(w, w.t, { ...LEAVE, candidateIds: [w.s1.userId] }),
      apply(w, w.t, { startDate: '2026-11-12', endDate: '2026-11-16', candidateIds: [w.s1.userId] }),
    ]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(await w.db.$count(leaveChoices)).toBe(1);
  });
});

describe('代班邀请', () => {
  test('接受/拒绝、重复处理 409、通知原老师与待选择学员', async () => {
    const w = await world();
    const leaveId = (await apply(w, w.t, { ...LEAVE, candidateIds: [w.s1.userId, w.s2.userId] })).json().id;
    const inv = (await call(w.ctx, 'GET', '/api/teacher/substitute-invites', { token: w.s1.token })).json();
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ leaveId, status: 'invited', ownerName: `老师${w.t.userId}` });

    expect((await respond(w, w.s1, leaveId, true)).json().status).toBe('accepted');
    expect((await respond(w, w.s1, leaveId, false)).statusCode).toBe(409);
    expect((await respond(w, w.s2, leaveId, false)).json().status).toBe('rejected');
    expect((await respond(w, w.low, leaveId, true)).statusCode).toBe(404);
    expect(await noticesOf(w.db, w.t.userId, 'substitute_response')).toHaveLength(2);
    expect(await noticesOf(w.db, w.u.userId, 'substitute_available')).toHaveLength(1);
  });

  test('已答应代班的老师不能提交重叠请假；不重叠可以', async () => {
    const w = await world();
    const leaveId = (await apply(w, w.t, { ...LEAVE, candidateIds: [w.s1.userId] })).json().id;
    await respond(w, w.s1, leaveId, true);
    const cand = [w.s2.userId];
    expect((await apply(w, w.s1, { startDate: '2026-11-12', endDate: '2026-11-20', candidateIds: cand })).statusCode).toBe(
      409,
    );
    expect((await apply(w, w.s1, { startDate: '2026-11-20', endDate: '2026-11-21', candidateIds: cand })).statusCode).toBe(
      201,
    );
  });

  test('老师请假时，自动拒绝其未处理且时段重叠的代班邀请', async () => {
    const w = await world();
    const leaveId = (await apply(w, w.t, { ...LEAVE, candidateIds: [w.s1.userId] })).json().id;
    await apply(w, w.s1, { startDate: '2026-11-13', endDate: '2026-11-15', candidateIds: [w.s2.userId] });
    const [c] = await w.db
      .select()
      .from(substituteCandidates)
      .where(and(eq(substituteCandidates.leaveId, leaveId), eq(substituteCandidates.teacherId, w.s1.userId)));
    expect(c.status).toBe('rejected');
  });
});
```

**Step 2: 运行，确认失败**

Run: `pnpm vitest run src/modules/leaves`
Expected: FAIL（模块不存在 / 404）。

**Step 3: 实现**

`src/modules/leaves/service.ts`：

```ts
import { and, asc, desc, eq, exists, gt, gte, inArray, lte, ne, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import {
  leaveChoices,
  leaves,
  serviceRelations,
  serviceSegments,
  substituteCandidates,
  teacherProfiles,
} from '../../db/schema.ts';
import { type DayPredicate, pauseRange } from '../../domain/segments.ts';
import { addMs, diffDays, HOUR_MS, todayCN } from '../../lib/dates.ts';
import { HttpError } from '../../lib/errors.ts';
import { type Notice, notify } from '../../lib/notify.ts';
import { pgConstraint } from '../../lib/pg-errors.ts';
import { cancelAppointments } from '../appointments/service.ts';
import { rewriteSegments } from '../relations/service.ts';
import { lockTeacher } from '../teachers/service.ts';

export const MAX_LEAVE_DAYS = 60;
export const MAX_CANDIDATES = 3;
export const CHOICE_HOURS = 48;

export type Leave = typeof leaves.$inferSelect;
export type Candidate = typeof substituteCandidates.$inferSelect;

export async function getLeave(db: DbOrTx, id: number): Promise<Leave | undefined> {
  const [l] = await db.select().from(leaves).where(eq(leaves.id, id));
  return l;
}

export async function getCandidate(db: DbOrTx, leaveId: number, teacherId: number): Promise<Candidate | undefined> {
  const [c] = await db
    .select()
    .from(substituteCandidates)
    .where(and(eq(substituteCandidates.leaveId, leaveId), eq(substituteCandidates.teacherId, teacherId)));
  return c;
}

const leaveOverlaps = (from: string, to: string) => and(lte(leaves.startDate, to), gte(leaves.endDate, from));

async function onLeave(db: DbOrTx, teacherId: number, from: string, to: string): Promise<boolean> {
  return (await db.$count(leaves, and(eq(leaves.teacherId, teacherId), leaveOverlaps(from, to)))) > 0;
}

async function substitutingDuring(db: DbOrTx, teacherId: number, from: string, to: string): Promise<boolean> {
  const rows = await db
    .select({ id: substituteCandidates.id })
    .from(substituteCandidates)
    .innerJoin(leaves, eq(leaves.id, substituteCandidates.leaveId))
    .where(
      and(
        eq(substituteCandidates.teacherId, teacherId),
        eq(substituteCandidates.status, 'accepted'),
        leaveOverlaps(from, to),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** 原老师的全部请假日：分段尾部补齐时跳过 */
export async function leaveBlocker(db: DbOrTx, teacherId: number): Promise<DayPredicate> {
  const ranges = await db
    .select({ from: leaves.startDate, to: leaves.endDate })
    .from(leaves)
    .where(eq(leaves.teacherId, teacherId));
  return (d) => ranges.some((r) => r.from <= d && d <= r.to);
}

async function affectedRelations(tx: DbOrTx, teacherId: number, from: string, to: string) {
  return tx
    .select({ id: serviceRelations.id, userId: serviceRelations.userId })
    .from(serviceRelations)
    .where(
      and(
        eq(serviceRelations.teacherId, teacherId),
        eq(serviceRelations.status, 'active'),
        or(ne(serviceRelations.packageType, 'single'), gt(serviceRelations.callsLeft, 0)),
        exists(
          tx
            .select({ one: sql`1` })
            .from(serviceSegments)
            .where(
              and(
                eq(serviceSegments.relationId, serviceRelations.id),
                eq(serviceSegments.kind, 'normal'),
                lte(serviceSegments.startDate, to),
                gte(serviceSegments.endDate, from),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(serviceRelations.id));
}

export interface LeaveInput {
  teacherId: number;
  startDate: string;
  endDate: string;
  reason?: string;
  candidateIds: number[];
}

export async function createLeave(db: DbOrTx, now: Date, input: LeaveInput): Promise<Leave> {
  const { teacherId, startDate, endDate } = input;
  if (startDate > endDate) throw new HttpError(400, '请假结束日期不能早于开始日期');
  if (startDate < todayCN(now)) throw new HttpError(400, '请假开始日期不能早于今天');
  if (diffDays(startDate, endDate) + 1 > MAX_LEAVE_DAYS) throw new HttpError(400, `单次请假最长 ${MAX_LEAVE_DAYS} 天`);
  const ids = [...new Set(input.candidateIds)];
  if (ids.length < 1 || ids.length > MAX_CANDIDATES) throw new HttpError(400, `请指定 1~${MAX_CANDIDATES} 位代班老师`);
  if (ids.includes(teacherId)) throw new HttpError(400, '不能指定自己代班');

  try {
    return await db.transaction(async (tx) => {
      const me = await lockTeacher(tx, teacherId);
      if (!me || me.status !== 'active') throw new HttpError(403, '仅已认证老师可操作');
      if (await onLeave(tx, teacherId, startDate, endDate)) throw new HttpError(409, '与已有请假时间重叠');
      if (await substitutingDuring(tx, teacherId, startDate, endDate)) {
        throw new HttpError(409, '你已答应该时段的代班，请先联系原老师撤销');
      }
      const cands = await tx
        .select({ userId: teacherProfiles.userId, level: teacherProfiles.level, status: teacherProfiles.status })
        .from(teacherProfiles)
        .where(inArray(teacherProfiles.userId, ids));
      for (const id of ids) {
        const c = cands.find((x) => x.userId === id);
        if (!c || c.status !== 'active') throw new HttpError(400, '代班老师不存在或未认证');
        if (c.level < me.level) throw new HttpError(400, '代班老师须为同级或更高级');
        // biome-ignore lint/performance/noAwaitInLoops: 事务内顺序执行
        if (await onLeave(tx, id, startDate, endDate)) throw new HttpError(400, '代班老师该时段也在请假');
      }

      const [leave] = await tx
        .insert(leaves)
        .values({ teacherId, startDate, endDate, reason: input.reason ?? '', createdAt: now })
        .returning();

      // 自己请假期间无法代班：自动拒绝未处理且时段重叠的邀请
      await tx
        .update(substituteCandidates)
        .set({ status: 'rejected', respondedAt: now })
        .where(
          and(
            eq(substituteCandidates.teacherId, teacherId),
            eq(substituteCandidates.status, 'invited'),
            inArray(
              substituteCandidates.leaveId,
              tx.select({ id: leaves.id }).from(leaves).where(leaveOverlaps(startDate, endDate)),
            ),
          ),
        );

      await tx.insert(substituteCandidates).values(ids.map((id) => ({ leaveId: leave.id, teacherId: id })));
      await cancelAppointments(tx, { teacherId, from: startDate, to: endDate }, 'leave');

      const blocked = await leaveBlocker(tx, teacherId);
      const deadlineAt = addMs(now, CHOICE_HOURS * HOUR_MS);
      const notices: Notice[] = ids.map((id) => ({
        userId: id,
        type: 'substitute_invite',
        payload: { leaveId: leave.id, fromTeacherId: teacherId, startDate, endDate },
      }));
      for (const r of await affectedRelations(tx, teacherId, startDate, endDate)) {
        // biome-ignore lint/performance/noAwaitInLoops: 事务内顺序执行
        await rewriteSegments(tx, r.id, (s) => pauseRange(s, { from: startDate, to: endDate, ownerId: teacherId, blocked }));
        await tx.insert(leaveChoices).values({ leaveId: leave.id, relationId: r.id, deadlineAt });
        notices.push({
          userId: r.userId,
          type: 'leave_notice',
          payload: { leaveId: leave.id, relationId: r.id, startDate, endDate, deadlineAt: deadlineAt.toISOString() },
        });
      }
      await notify(tx, ...notices);
      return leave;
    });
  } catch (e) {
    if (pgConstraint(e) === 'leaves_no_overlap') throw new HttpError(409, '与已有请假时间重叠');
    throw e;
  }
}

export async function listLeaves(db: DbOrTx, teacherId: number) {
  const rows = await db.select().from(leaves).where(eq(leaves.teacherId, teacherId)).orderBy(desc(leaves.startDate));
  if (rows.length === 0) return [];
  const ids = rows.map((l) => l.id);
  const cands = await db
    .select({
      leaveId: substituteCandidates.leaveId,
      teacherId: substituteCandidates.teacherId,
      status: substituteCandidates.status,
      displayName: teacherProfiles.displayName,
      level: teacherProfiles.level,
    })
    .from(substituteCandidates)
    .innerJoin(teacherProfiles, eq(teacherProfiles.userId, substituteCandidates.teacherId))
    .where(inArray(substituteCandidates.leaveId, ids))
    .orderBy(asc(substituteCandidates.id));
  const choices = await db
    .select({
      id: leaveChoices.id,
      leaveId: leaveChoices.leaveId,
      relationId: leaveChoices.relationId,
      userId: serviceRelations.userId,
      status: leaveChoices.status,
      substituteTeacherId: leaveChoices.substituteTeacherId,
      deadlineAt: leaveChoices.deadlineAt,
    })
    .from(leaveChoices)
    .innerJoin(serviceRelations, eq(serviceRelations.id, leaveChoices.relationId))
    .where(inArray(leaveChoices.leaveId, ids))
    .orderBy(asc(leaveChoices.id));
  return rows.map((l) => ({
    ...l,
    candidates: cands.filter((c) => c.leaveId === l.id),
    choices: choices.filter((c) => c.leaveId === l.id),
  }));
}

export async function listInvites(db: DbOrTx, teacherId: number) {
  return db
    .select({
      leaveId: substituteCandidates.leaveId,
      status: substituteCandidates.status,
      startDate: leaves.startDate,
      endDate: leaves.endDate,
      reason: leaves.reason,
      ownerId: leaves.teacherId,
      ownerName: teacherProfiles.displayName,
    })
    .from(substituteCandidates)
    .innerJoin(leaves, eq(leaves.id, substituteCandidates.leaveId))
    .innerJoin(teacherProfiles, eq(teacherProfiles.userId, leaves.teacherId))
    .where(eq(substituteCandidates.teacherId, teacherId))
    .orderBy(desc(leaves.startDate));
}

export async function respondInvite(
  db: DbOrTx,
  now: Date,
  q: { teacherId: number; leaveId: number; accept: boolean },
): Promise<Candidate> {
  return db.transaction(async (tx) => {
    // 与本人提交请假互斥（见「并发」）
    await lockTeacher(tx, q.teacherId);
    const [c] = await tx
      .select()
      .from(substituteCandidates)
      .where(and(eq(substituteCandidates.leaveId, q.leaveId), eq(substituteCandidates.teacherId, q.teacherId)))
      .for('update');
    if (!c) throw new HttpError(404, '邀请不存在');
    if (c.status !== 'invited') throw new HttpError(409, '该邀请已处理');
    const leave = await getLeave(tx, q.leaveId);
    if (!leave || leave.endDate < todayCN(now)) throw new HttpError(409, '请假已结束');
    if (q.accept && (await onLeave(tx, q.teacherId, leave.startDate, leave.endDate))) {
      throw new HttpError(409, '你在该时段有请假，不能代班');
    }

    const [row] = await tx
      .update(substituteCandidates)
      .set({ status: q.accept ? 'accepted' : 'rejected', respondedAt: now })
      .where(eq(substituteCandidates.id, c.id))
      .returning();
    const notices: Notice[] = [
      {
        userId: leave.teacherId,
        type: 'substitute_response',
        payload: { leaveId: leave.id, teacherId: q.teacherId, accept: q.accept },
      },
    ];
    if (q.accept) {
      const waiting = await tx
        .select({ userId: serviceRelations.userId })
        .from(leaveChoices)
        .innerJoin(serviceRelations, eq(serviceRelations.id, leaveChoices.relationId))
        .where(and(eq(leaveChoices.leaveId, leave.id), eq(leaveChoices.status, 'pending')));
      for (const u of waiting) {
        notices.push({ userId: u.userId, type: 'substitute_available', payload: { leaveId: leave.id, teacherId: q.teacherId } });
      }
    }
    await notify(tx, ...notices);
    return row;
  });
}

// 后续 Task 在此追加：学员选择、撤销代班、选择过期
```

`src/modules/leaves/routes.ts`：

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { DateStr, IdParam } from '../../lib/zod.ts';
import { teacherGuard } from '../teachers/guard.ts';
import { createLeave, listInvites, listLeaves, MAX_CANDIDATES, respondInvite } from './service.ts';

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

    // 后续 Task 在此追加：撤销代班
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
```

`src/routes.ts` 加 import 并注册：

```ts
  await app.register(teacherLeaveRoutes(deps), { prefix: '/api/teacher/leaves' });
  await app.register(substituteInviteRoutes(deps), { prefix: '/api/teacher/substitute-invites' });
```

**Step 4: 运行，确认通过**

Run: `pnpm vitest run src/modules/leaves src/modules/appointments`
Expected: PASS（请假 8 个，预约 9 个无回归）。

验证锁确实起作用：临时注释掉 `createLeave` 里的 `lockTeacher`，重跑 `并发提交重叠请假只成功一个`，应出现 409 由 `leaves_no_overlap` 兜底（仍通过）或两条请假都改写了分段导致 `leaveChoices` 计数不对；恢复后稳定通过。

**Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: 请假与代班邀请"
```

---

### Task 7: 学员选择代班、撤销代班、选择过期

**Files:**
- Modify: `src/modules/leaves/service.ts`、`src/modules/leaves/routes.ts`
- Modify: `src/routes.ts`
- Test: `src/modules/leaves/leave-choices.test.ts`

**规则：**
- 学员只能操作 `pending`、未到期限、请假未结束的选择项；`wait` 保持暂停；`substitute` 只能选已同意的候选。
- 选代班：从 `max(请假开始日, 今天)` 到请假结束日，把暂停日改为该老师的代班分段（`substituteFromPause`），收回等量顺延。
- 撤销代班（原老师操作，仅限 `accepted` 候选）：已选该老师的学员从 `max(请假开始日, 今天)` 起改回暂停（`pauseFromSubstitute`），取消该老师在区间内与这些学员的预约，选择项回到 `pending` 并重新计 48 小时。
- 过期任务：`pending` 且到期的选择项置为 `expired`（保持暂停），通知学员。

**并发：** 学员选择先无锁读出原老师，然后按锁顺序「原老师行 FOR SHARE → 选择项行 FOR UPDATE」；撤销代班持有原老师行 FOR UPDATE，两者互斥，避免「撤销刚扫完已选学员，学员紧接着又选中被撤销的老师」。过期任务只锁选择项行并用 `SKIP LOCKED`，不会与前两者互相等待。带 join 的加锁查询用 `.for('update', { of: leaveChoices })`，只锁选择项行，避免越过锁顺序锁住服务关系行。

**Step 1: 写失败测试**

`src/modules/leaves/leave-choices.test.ts`：

```ts
import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { buyAndPay, call, insertPackage, loginTeacher, loginUser, noticesOf, setup } from '../../../tests/helpers.ts';
import { accruals, leaveChoices, serviceRelations } from '../../db/schema.ts';
import { addMs, HOUR_MS } from '../../lib/dates.ts';
import { accrueUpTo } from '../accrual/service.ts';
import { book, getAppointment } from '../appointments/service.ts';
import { loadSegments } from '../relations/service.ts';
import { setSchedule } from '../schedule/service.ts';
import { createLeave, expireChoices, respondInvite } from './service.ts';

async function world(range = { startDate: '2026-11-10', endDate: '2026-11-14' }) {
  const ctx = await setup();
  const t = await loginTeacher(ctx, 't');
  const s1 = await loginTeacher(ctx, 's1');
  const s2 = await loginTeacher(ctx, 's2');
  const u = await loginUser(ctx, 'u');
  const rel = await buyAndPay(ctx, u.userId, await insertPackage(ctx.db, t.userId));
  const now = ctx.clock.now();
  const leave = await createLeave(ctx.db, now, { teacherId: t.userId, ...range, candidateIds: [s1.userId, s2.userId] });
  await respondInvite(ctx.db, now, { teacherId: s1.userId, leaveId: leave.id, accept: true });
  const [choice] = await ctx.db.select().from(leaveChoices).where(eq(leaveChoices.relationId, rel.id));
  return { ctx, db: ctx.db, t, s1, s2, u, rel, leave, choice, now };
}
type World = Awaited<ReturnType<typeof world>>;

const decide = (w: World, body: object, who = w.u) =>
  call(w.ctx, 'POST', `/api/leave-choices/${w.choice.id}`, { token: who.token, body });
const revoke = (w: World, who: { token: string }, candidateId: number) =>
  call(w.ctx, 'POST', `/api/teacher/leaves/${w.leave.id}/candidates/${candidateId}/revoke`, { token: who.token });
const currentChoice = async (w: World) => (await w.db.select().from(leaveChoices).where(eq(leaveChoices.id, w.choice.id)))[0];
async function sumBy(w: World, teacherId: number): Promise<number> {
  const rows = await w.db.select().from(accruals).where(eq(accruals.teacherId, teacherId));
  return rows.reduce((s, r) => s + r.amountCents, 0);
}

describe('学员选择代班', () => {
  test('学员看到待选择项，只列出已同意的代班老师', async () => {
    const w = await world();
    const res = (await call(w.ctx, 'GET', '/api/leave-choices', { token: w.u.token })).json();
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ status: 'pending', ownerName: `老师${w.t.userId}` });
    expect(res[0].candidates.map((c: { teacherId: number }) => c.teacherId)).toEqual([w.s1.userId]);
  });

  test('选择代班：暂停日改为代班分段，代班期间计提归代班老师', async () => {
    const w = await world();
    const res = await decide(w, { action: 'substitute', teacherId: w.s1.userId });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('substitute');
    expect(await loadSegments(w.db, w.rel.id)).toEqual([
      { kind: 'normal', teacherId: w.t.userId, startDate: '2026-11-01', endDate: '2026-11-09' },
      { kind: 'substitute', teacherId: w.s1.userId, startDate: '2026-11-10', endDate: '2026-11-14' },
      { kind: 'normal', teacherId: w.t.userId, startDate: '2026-11-15', endDate: '2026-11-30' },
    ]);
    expect(await noticesOf(w.db, w.s1.userId, 'substitute_assigned')).toHaveLength(1);
    expect(await noticesOf(w.db, w.t.userId, 'leave_choice')).toHaveLength(1);
    await accrueUpTo(w.db, '2026-11-30');
    expect(await sumBy(w, w.s1.userId)).toBe(500);
    expect(await sumBy(w, w.t.userId)).toBe(2500);
  });

  test('只能选已同意的老师；他人不可操作；不能重复选择', async () => {
    const w = await world();
    expect((await decide(w, { action: 'substitute', teacherId: w.s2.userId })).statusCode).toBe(400);
    expect((await decide(w, { action: 'other' })).statusCode).toBe(400);
    expect((await decide(w, { action: 'substitute' })).statusCode).toBe(400);
    const other = await loginUser(w.ctx, 'x');
    expect((await decide(w, { action: 'wait' }, other)).statusCode).toBe(404);
    expect((await decide(w, { action: 'wait' })).json().status).toBe('wait');
    expect((await decide(w, { action: 'substitute', teacherId: w.s1.userId })).statusCode).toBe(409);
    expect((await loadSegments(w.db, w.rel.id))[1].kind).toBe('paused');
  });

  test('请假已开始后才选择：自选定当日起改为代班', async () => {
    const w = await world({ startDate: '2026-11-01', endDate: '2026-11-05' });
    w.ctx.clock.set('2026-11-03T02:00:00Z');
    expect((await decide(w, { action: 'substitute', teacherId: w.s1.userId })).statusCode).toBe(200);
    expect(await loadSegments(w.db, w.rel.id)).toEqual([
      { kind: 'paused', teacherId: null, startDate: '2026-11-01', endDate: '2026-11-02' },
      { kind: 'substitute', teacherId: w.s1.userId, startDate: '2026-11-03', endDate: '2026-11-05' },
      { kind: 'normal', teacherId: w.t.userId, startDate: '2026-11-06', endDate: '2026-12-02' },
    ]);
  });
});

describe('选择过期', () => {
  test('超过 48 小时未选择：过期并保持暂停，之后不能再选', async () => {
    const w = await world();
    expect(await expireChoices(w.db, addMs(w.now, 47 * HOUR_MS))).toBe(0);
    expect(await expireChoices(w.db, addMs(w.now, 48 * HOUR_MS))).toBe(1);
    expect((await currentChoice(w)).status).toBe('expired');
    expect(await noticesOf(w.db, w.u.userId, 'leave_choice_expired')).toHaveLength(1);
    expect((await decide(w, { action: 'wait' })).statusCode).toBe(409);
    expect((await loadSegments(w.db, w.rel.id))[1].kind).toBe('paused');
  });

  test('期限已到但过期任务尚未执行：选择被拒绝', async () => {
    const w = await world();
    w.ctx.clock.set(addMs(w.now, 48 * HOUR_MS));
    expect((await decide(w, { action: 'wait' })).statusCode).toBe(409);
  });
});

describe('撤销代班', () => {
  test('分段改回暂停、代班预约取消、学员重新获得选择期', async () => {
    const w = await world();
    await setSchedule(w.db, w.s1.userId, [{ weekday: 2, start: '09:00', end: '12:00' }]);
    await decide(w, { action: 'substitute', teacherId: w.s1.userId });
    const a = await book(w.db, w.now, { userId: w.u.userId, relationId: w.rel.id, date: '2026-11-10', start: '09:00' });
    expect(a.teacherId).toBe(w.s1.userId);

    w.ctx.clock.set(addMs(w.now, HOUR_MS));
    const res = await revoke(w, w.t, w.s1.userId);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('revoked');
    expect((await loadSegments(w.db, w.rel.id))[1].kind).toBe('paused');
    const [r] = await w.db.select().from(serviceRelations);
    expect(r).toMatchObject({ endDate: '2026-12-05', callsLeft: 4 });
    expect((await getAppointment(w.db, a.id))?.status).toBe('cancelled');

    const ch = await currentChoice(w);
    expect(ch).toMatchObject({ status: 'pending', substituteTeacherId: null, decidedAt: null });
    expect(ch.deadlineAt.toISOString()).toBe(addMs(w.now, 49 * HOUR_MS).toISOString());
    expect(await noticesOf(w.db, w.u.userId, 'substitute_revoked')).toHaveLength(1);
    expect(await noticesOf(w.db, w.s1.userId, 'substitute_revoked')).toHaveLength(1);

    expect((await revoke(w, w.t, w.s1.userId)).statusCode).toBe(409);
    expect((await revoke(w, w.s1, w.s2.userId)).statusCode).toBe(404);
  });

  test('撤销与学员选择并发：最终不会留下被撤销老师的代班分段', async () => {
    const w = await world();
    const [d, r] = await Promise.all([decide(w, { action: 'substitute', teacherId: w.s1.userId }), revoke(w, w.t, w.s1.userId)]);
    expect(r.statusCode).toBe(200);
    expect([200, 400]).toContain(d.statusCode);
    expect((await currentChoice(w)).status).toBe('pending');
    expect((await loadSegments(w.db, w.rel.id)).some((s) => s.kind === 'substitute')).toBe(false);
  });
});
```

**Step 2: 运行，确认失败**

Run: `pnpm vitest run src/modules/leaves/leave-choices.test.ts`
Expected: FAIL（`expireChoices` 未导出 / 404）。

**Step 3: 实现**

`src/modules/leaves/service.ts`：
- `drizzle-orm` 的 import 补上 `getTableColumns`
- `../../domain/segments.ts` 的 import 改为 `import { type DayPredicate, pauseFromSubstitute, pauseRange, substituteFromPause } from '../../domain/segments.ts';`
- 把 `// 后续 Task 在此追加：学员选择、撤销代班、选择过期` 替换为：

```ts
const later = (a: string, b: string): string => (a > b ? a : b);

export type Choice = typeof leaveChoices.$inferSelect;
export type ChoiceDecision = { action: 'wait' } | { action: 'substitute'; teacherId: number };

export async function listChoices(db: DbOrTx, userId: number) {
  const rows = await db
    .select({
      ...getTableColumns(leaveChoices),
      startDate: leaves.startDate,
      endDate: leaves.endDate,
      ownerId: leaves.teacherId,
      ownerName: teacherProfiles.displayName,
    })
    .from(leaveChoices)
    .innerJoin(leaves, eq(leaves.id, leaveChoices.leaveId))
    .innerJoin(serviceRelations, eq(serviceRelations.id, leaveChoices.relationId))
    .innerJoin(teacherProfiles, eq(teacherProfiles.userId, leaves.teacherId))
    .where(eq(serviceRelations.userId, userId))
    .orderBy(desc(leaveChoices.id));
  if (rows.length === 0) return [];
  const cands = await db
    .select({
      leaveId: substituteCandidates.leaveId,
      teacherId: substituteCandidates.teacherId,
      displayName: teacherProfiles.displayName,
      level: teacherProfiles.level,
    })
    .from(substituteCandidates)
    .innerJoin(teacherProfiles, eq(teacherProfiles.userId, substituteCandidates.teacherId))
    .where(
      and(
        inArray(substituteCandidates.leaveId, [...new Set(rows.map((r) => r.leaveId))]),
        eq(substituteCandidates.status, 'accepted'),
      ),
    )
    .orderBy(asc(substituteCandidates.id));
  return rows.map((r) => ({ ...r, candidates: cands.filter((c) => c.leaveId === r.leaveId) }));
}

export async function decideChoice(
  db: DbOrTx,
  now: Date,
  q: { userId: number; choiceId: number } & ChoiceDecision,
): Promise<Choice> {
  const [head] = await db
    .select({ ownerId: leaves.teacherId })
    .from(leaveChoices)
    .innerJoin(leaves, eq(leaves.id, leaveChoices.leaveId))
    .where(eq(leaveChoices.id, q.choiceId));
  if (!head) throw new HttpError(404, '选择项不存在');
  const ownerId = head.ownerId;

  return db.transaction(async (tx) => {
    // 与撤销代班（原老师行 FOR UPDATE）互斥
    await lockTeacher(tx, ownerId, 'share');
    const [c] = await tx
      .select({
        ...getTableColumns(leaveChoices),
        userId: serviceRelations.userId,
        startDate: leaves.startDate,
        endDate: leaves.endDate,
      })
      .from(leaveChoices)
      .innerJoin(serviceRelations, eq(serviceRelations.id, leaveChoices.relationId))
      .innerJoin(leaves, eq(leaves.id, leaveChoices.leaveId))
      .where(eq(leaveChoices.id, q.choiceId))
      .for('update', { of: leaveChoices });
    if (!c || c.userId !== q.userId) throw new HttpError(404, '选择项不存在');
    if (c.status !== 'pending') throw new HttpError(409, '已处理过该选择');
    if (now.getTime() >= c.deadlineAt.getTime()) throw new HttpError(409, '已超过选择期限，服务已暂停顺延');
    const today = todayCN(now);
    if (c.endDate < today) throw new HttpError(409, '请假已结束');

    const notices: Notice[] = [
      { userId: ownerId, type: 'leave_choice', payload: { leaveId: c.leaveId, relationId: c.relationId, action: q.action } },
    ];
    let patch: Partial<typeof leaveChoices.$inferInsert>;
    if (q.action === 'wait') {
      patch = { status: 'wait', decidedAt: now };
    } else {
      const teacherId = q.teacherId;
      const cand = await getCandidate(tx, c.leaveId, teacherId);
      if (!cand || cand.status !== 'accepted') throw new HttpError(400, '该老师不是可选的代班老师');
      const from = later(c.startDate, today);
      const blocked = await leaveBlocker(tx, ownerId);
      await rewriteSegments(tx, c.relationId, (s) =>
        substituteFromPause(s, { from, to: c.endDate, teacherId, ownerId, blocked }),
      );
      patch = { status: 'substitute', substituteTeacherId: teacherId, decidedAt: now };
      notices.push({
        userId: teacherId,
        type: 'substitute_assigned',
        payload: { leaveId: c.leaveId, relationId: c.relationId, userId: q.userId, from, to: c.endDate },
      });
    }
    const [row] = await tx.update(leaveChoices).set(patch).where(eq(leaveChoices.id, c.id)).returning();
    await notify(tx, ...notices);
    return row;
  });
}

export async function revokeSubstitute(
  db: DbOrTx,
  now: Date,
  q: { teacherId: number; leaveId: number; candidateId: number },
): Promise<Candidate> {
  return db.transaction(async (tx) => {
    await lockTeacher(tx, q.teacherId);
    const leave = await getLeave(tx, q.leaveId);
    if (!leave || leave.teacherId !== q.teacherId) throw new HttpError(404, '请假不存在');
    const [cand] = await tx
      .select()
      .from(substituteCandidates)
      .where(and(eq(substituteCandidates.leaveId, q.leaveId), eq(substituteCandidates.teacherId, q.candidateId)))
      .for('update');
    if (!cand || cand.status !== 'accepted') throw new HttpError(409, '该老师不在已同意代班状态');
    const today = todayCN(now);
    if (leave.endDate < today) throw new HttpError(409, '请假已结束');

    const from = later(leave.startDate, today);
    const deadlineAt = addMs(now, CHOICE_HOURS * HOUR_MS);
    const [row] = await tx
      .update(substituteCandidates)
      .set({ status: 'revoked', respondedAt: now })
      .where(eq(substituteCandidates.id, cand.id))
      .returning();

    const choices = await tx
      .select({ id: leaveChoices.id, relationId: leaveChoices.relationId, userId: serviceRelations.userId })
      .from(leaveChoices)
      .innerJoin(serviceRelations, eq(serviceRelations.id, leaveChoices.relationId))
      .where(
        and(
          eq(leaveChoices.leaveId, leave.id),
          eq(leaveChoices.status, 'substitute'),
          eq(leaveChoices.substituteTeacherId, q.candidateId),
        ),
      )
      .orderBy(asc(leaveChoices.id))
      .for('update', { of: leaveChoices });
    const blocked = await leaveBlocker(tx, q.teacherId);
    const notices: Notice[] = [{ userId: q.candidateId, type: 'substitute_revoked', payload: { leaveId: leave.id } }];
    for (const ch of choices) {
      // biome-ignore lint/performance/noAwaitInLoops: 事务内顺序执行
      await rewriteSegments(tx, ch.relationId, (s) =>
        pauseFromSubstitute(s, { from, to: leave.endDate, teacherId: q.candidateId, ownerId: q.teacherId, blocked }),
      );
      await cancelAppointments(
        tx,
        { teacherId: q.candidateId, from, to: leave.endDate, relationId: ch.relationId },
        'leave',
      );
      await tx
        .update(leaveChoices)
        .set({ status: 'pending', substituteTeacherId: null, deadlineAt, decidedAt: null })
        .where(eq(leaveChoices.id, ch.id));
      notices.push({
        userId: ch.userId,
        type: 'substitute_revoked',
        payload: { leaveId: leave.id, relationId: ch.relationId, deadlineAt: deadlineAt.toISOString() },
      });
    }
    await notify(tx, ...notices);
    return row;
  });
}

/** 到期未选择的置为 expired（保持暂停）。分钟级任务调用，幂等 */
export async function expireChoices(db: DbOrTx, now: Date): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: leaveChoices.id,
        leaveId: leaveChoices.leaveId,
        relationId: leaveChoices.relationId,
        userId: serviceRelations.userId,
      })
      .from(leaveChoices)
      .innerJoin(serviceRelations, eq(serviceRelations.id, leaveChoices.relationId))
      .where(and(eq(leaveChoices.status, 'pending'), lte(leaveChoices.deadlineAt, now)))
      .orderBy(asc(leaveChoices.id))
      .for('update', { of: leaveChoices, skipLocked: true });
    if (rows.length === 0) return 0;
    await tx
      .update(leaveChoices)
      .set({ status: 'expired', decidedAt: now })
      .where(
        inArray(
          leaveChoices.id,
          rows.map((r) => r.id),
        ),
      );
    await notify(
      tx,
      ...rows.map(
        (r): Notice => ({
          userId: r.userId,
          type: 'leave_choice_expired',
          payload: { leaveId: r.leaveId, relationId: r.relationId },
        }),
      ),
    );
    return rows.length;
  });
}
```

`src/modules/leaves/routes.ts`：
- `../auth/guards.ts` 补 import：`import { userGuard } from '../auth/guards.ts';`
- `./service.ts` 的 import 补上 `decideChoice`、`listChoices`、`revokeSubstitute`
- `teacherLeaveRoutes` 中把 `// 后续 Task 在此追加：撤销代班` 替换为：

```ts
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
```

- 文件末尾追加：

```ts
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
```

`src/routes.ts` 注册：

```ts
  await app.register(leaveChoiceRoutes(deps), { prefix: '/api/leave-choices' });
```

**Step 4: 运行，确认通过**

Run: `pnpm vitest run src/modules/leaves`
Expected: PASS（8 + 8）。

Run（项目根）：`pnpm fix && pnpm check`

**Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: 学员选择代班、撤销代班与选择过期"
```

---

### Task 8: 腾讯云 UserSig 与 IM 登录凭证

**Files:**
- Create: `src/providers/tencent.ts`、`src/modules/im/routes.ts`
- Modify: `src/routes.ts`、`tests/helpers.ts`
- Test: `src/providers/tencent.test.ts`

**说明：** IM 与 TRTC 共用同一个 SDKAppID 和密钥。UserSig 算法与官方 TLSSigAPIv2 一致：对 `TLS.identifier/sdkappid/time/expire` 拼接串做 HMAC-SHA256，与字段一起 JSON 化后用 zlib 压缩，再转 base64，并把 `+ / =` 分别替换为 `* - _`。IM 账号统一为 `u{用户ID}`。未配置 `TENCENT_SDKAPPID/TENCENT_SECRETKEY` 时走 MOCK，`userSig` 返回 `'mock'`（生产环境由 Task 1 的配置校验禁止 MOCK）。

**Step 1: 写失败测试**

`src/providers/tencent.test.ts`：

```ts
import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { call, FIXED_NOW, loginUser, setup } from '../../tests/helpers.ts';
import { decodeUserSig, genUserSig, imIdOf, parseImId, SIG_EXPIRE_SEC } from './tencent.ts';

export const TENCENT = { sdkAppId: 1400000001, secretKey: 'sk-test', imCallbackToken: '', trtcCallbackKey: '' };

describe('腾讯云 UserSig', () => {
  test('IM 账号映射', () => {
    expect(imIdOf(12)).toBe('u12');
    expect(parseImId('u12')).toBe(12);
    expect(parseImId('u012')).toBeNull();
    expect(parseImId('administrator')).toBeNull();
    expect(parseImId(undefined)).toBeNull();
    expect(parseImId(12)).toBeNull();
  });

  test('UserSig 可解出字段，签名为 HMAC-SHA256', () => {
    const sig = genUserSig(TENCENT, 'u12', 600, 1_700_000_000);
    expect(sig).toMatch(/^[A-Za-z0-9*\-_]+$/);
    const doc = decodeUserSig(sig);
    expect(doc).toMatchObject({
      'TLS.ver': '2.0',
      'TLS.identifier': 'u12',
      'TLS.sdkappid': 1400000001,
      'TLS.time': 1_700_000_000,
      'TLS.expire': 600,
    });
    const content = 'TLS.identifier:u12\nTLS.sdkappid:1400000001\nTLS.time:1700000000\nTLS.expire:600\n';
    expect(doc['TLS.sig']).toBe(createHmac('sha256', 'sk-test').update(content).digest('base64'));
  });

  test('GET /api/im/usersig：MOCK 与真实模式', async () => {
    const mock = await setup();
    const u1 = await loginUser(mock, 'u');
    expect((await call(mock, 'GET', '/api/im/usersig', { token: u1.token })).json()).toEqual({
      mock: true,
      sdkAppId: 0,
      imId: `u${u1.userId}`,
      userSig: 'mock',
      expireSec: SIG_EXPIRE_SEC,
    });

    const real = await setup({ config: { tencent: TENCENT } });
    const u2 = await loginUser(real, 'u');
    const body = (await call(real, 'GET', '/api/im/usersig', { token: u2.token })).json();
    expect(body).toMatchObject({ mock: false, sdkAppId: 1400000001, imId: `u${u2.userId}` });
    expect(decodeUserSig(body.userSig)).toMatchObject({
      'TLS.identifier': `u${u2.userId}`,
      'TLS.time': Date.parse(FIXED_NOW) / 1000,
      'TLS.expire': SIG_EXPIRE_SEC,
    });
    expect((await call(real, 'GET', '/api/im/usersig')).statusCode).toBe(401);
  });
});
```

**Step 2: 运行，确认失败**

Run: `pnpm vitest run src/providers/tencent.test.ts`
Expected: FAIL（`./tencent.ts` 不存在）。

**Step 3: 实现**

`src/providers/tencent.ts`：

```ts
import { createHmac } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { Config } from '../config.ts';

export type TencentConfig = Config['tencent'];

export const SIG_EXPIRE_SEC = 7 * 86_400;

export const imIdOf = (userId: number): string => `u${userId}`;

/** `u{正整数}` → 用户 ID；系统账号（如 administrator）等其他格式返回 null */
export function parseImId(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = /^u([1-9]\d{0,9})$/.exec(s);
  return m ? Number(m[1]) : null;
}

export const isTencentMock = (tc: TencentConfig): boolean => !tc.sdkAppId || !tc.secretKey;

function hmacSig(key: string, identifier: string, sdkAppId: number, time: number, expire: number): string {
  const content = `TLS.identifier:${identifier}\nTLS.sdkappid:${sdkAppId}\nTLS.time:${time}\nTLS.expire:${expire}\n`;
  return createHmac('sha256', key).update(content).digest('base64');
}

const escapeSig = (b64: string): string => b64.replaceAll('+', '*').replaceAll('/', '-').replaceAll('=', '_');
const unescapeSig = (s: string): string => s.replaceAll('*', '+').replaceAll('-', '/').replaceAll('_', '=');

export function genUserSig(
  tc: Pick<TencentConfig, 'sdkAppId' | 'secretKey'>,
  identifier: string,
  expireSec: number,
  nowSec: number,
): string {
  const doc = {
    'TLS.ver': '2.0',
    'TLS.identifier': identifier,
    'TLS.sdkappid': tc.sdkAppId,
    'TLS.expire': expireSec,
    'TLS.time': nowSec,
    'TLS.sig': hmacSig(tc.secretKey, identifier, tc.sdkAppId, nowSec, expireSec),
  };
  return escapeSig(deflateSync(Buffer.from(JSON.stringify(doc))).toString('base64'));
}

export const decodeUserSig = (sig: string): Record<string, unknown> =>
  JSON.parse(inflateSync(Buffer.from(unescapeSig(sig), 'base64')).toString('utf8'));

export interface ImCredential {
  mock: boolean;
  sdkAppId: number;
  imId: string;
  userSig: string;
  expireSec: number;
}

export function imCredential(tc: TencentConfig, userId: number, now: Date): ImCredential {
  const imId = imIdOf(userId);
  const mock = isTencentMock(tc);
  return {
    mock,
    sdkAppId: tc.sdkAppId,
    imId,
    userSig: mock ? 'mock' : genUserSig(tc, imId, SIG_EXPIRE_SEC, Math.floor(now.getTime() / 1000)),
    expireSec: SIG_EXPIRE_SEC,
  };
}
```

`src/modules/im/routes.ts`（IM 回调由腾讯云调用、不走用户登录，所以登录钩子只挂在子作用域上）：

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Deps } from '../../deps.ts';
import { imCredential } from '../../providers/tencent.ts';
import { userGuard } from '../auth/guards.ts';

export const imRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    // 后续 Task 在此追加：IM 回调

    await app.register(async (authed) => {
      authed.addHook('preHandler', userGuard(deps));

      authed.get('/usersig', async (req) => imCredential(deps.config.tencent, req.userId, deps.clock.now()));

      // 后续 Task 在此追加：联系人
    });
  };
```

`src/routes.ts` 加 import 并注册：

```ts
  await app.register(imRoutes(deps), { prefix: '/api/im' });
```

**Step 4: 运行，确认通过**

Run: `pnpm vitest run src/providers`
Expected: PASS（3 tests）。

**Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: 腾讯云 UserSig 与 IM 登录凭证"
```

---

### Task 9: TRTC 进入通话、房间回调、爽约与自动完成

**Files:**
- Create: `src/providers/tencent-callback.ts`、`src/modules/trtc/routes.ts`
- Modify: `src/modules/appointments/service.ts`、`src/modules/appointments/routes.ts`
- Modify: `src/routes.ts`
- Test: `src/providers/tencent-callback.test.ts`、`src/modules/appointments/calls.test.ts`

**说明：**
- 房间号就是预约 ID。进入通话接口只在「开始前 10 分钟 ~ 结束时间」开放，返回 TRTC 进房参数。
- 真实模式以 TRTC 房间事件回调为准：`EventGroupId=1` 下，`103` 进房，记录最早一次进房时间（回调可能乱序）；`102` 解散房间，若老师和学员都进过房则通话完成。回调签名 `Sign = base64(HMAC-SHA256(回调密钥, 原始请求体))`，放在请求头。
- 验签需要原始字节：在 `trtcRoutes` 插件作用域内移除默认 JSON 解析器，改为 `parseAs: 'buffer'`，验签后再 `JSON.parse`。这只影响该插件，其他路由仍走默认 JSON 解析。
- MOCK 模式（未配置腾讯云）：调用进入通话接口即记为已进房，靠自动完成任务收尾，方便本地联调。
- IM 回调鉴权也在本 Task 实现（Task 11 使用）：`Sign = sha256(Token + RequestTime)`，`RequestTime` 与当前时间偏差超过 300 秒视为无效。未配置 Token / 密钥时跳过校验（只在开发环境可能出现）。签名比较一律用 `timingSafeEqual`。
- 爽约与进房存在竞争：爽约更新带 `teacher_joined_at IS NULL` 条件，进房更新带 `status = 'booked'` 条件，两者都是单行原子更新，先提交的一方生效。爽约、自动完成按预约逐条开事务，单条失败不影响其他。
- 自动完成的 `endedAt` 取预约的计划结束时间，单次套餐「48 小时内无异议自动确认」由此起算。

**Step 1: 写失败测试**

`src/providers/tencent-callback.test.ts`：

```ts
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { verifyImSign, verifyTrtcSign } from './tencent-callback.ts';

describe('腾讯云回调验签', () => {
  test('TRTC：HMAC-SHA256(原始请求体)；未配置密钥时放行', () => {
    const raw = Buffer.from('{"a":1}');
    const sign = createHmac('sha256', 'ck').update(raw).digest('base64');
    expect(verifyTrtcSign('ck', raw, sign)).toBe(true);
    expect(verifyTrtcSign('ck', raw, 'x')).toBe(false);
    expect(verifyTrtcSign('ck', raw, undefined)).toBe(false);
    expect(verifyTrtcSign('', raw, undefined)).toBe(true);
  });

  test('IM：sha256(Token + RequestTime)，偏差超过 300 秒无效', () => {
    const sec = 1_700_000_000;
    const at = (s: number) => new Date(s * 1000);
    const Sign = createHash('sha256').update(`tok${sec}`).digest('hex');
    const q = { RequestTime: String(sec), Sign };
    expect(verifyImSign('tok', q, at(sec))).toBe(true);
    expect(verifyImSign('tok', q, at(sec + 300))).toBe(true);
    expect(verifyImSign('tok', q, at(sec + 301))).toBe(false);
    expect(verifyImSign('tok', { ...q, Sign: 'x' }, at(sec))).toBe(false);
    expect(verifyImSign('tok', {}, at(sec))).toBe(false);
    expect(verifyImSign('', {}, at(0))).toBe(true);
  });
});
```

`src/modules/appointments/calls.test.ts`：

```ts
import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  buyAndPay,
  type Ctx,
  call,
  insertPackage,
  loginTeacher,
  loginUser,
  noticesOf,
  setup,
  TENCENT,
} from '../../../tests/helpers.ts';
import type { Config } from '../../config.ts';
import { serviceRelations } from '../../db/schema.ts';
import { addMs, MINUTE_MS } from '../../lib/dates.ts';
import { setSchedule } from '../schedule/service.ts';
import { autoComplete, book, getAppointment, markNoShows, onRoomDismissed, recordEnter } from './service.ts';

const REAL = { tencent: { ...TENCENT, trtcCallbackKey: 'ck' } };

async function world(config?: Partial<Config>) {
  const ctx = await setup({ config });
  const t = await loginTeacher(ctx, 't');
  const u = await loginUser(ctx, 'u');
  await setSchedule(ctx.db, t.userId, [{ weekday: 1, start: '09:00', end: '12:00' }]);
  const rel = await buyAndPay(ctx, u.userId, await insertPackage(ctx.db, t.userId));
  const a = await book(ctx.db, ctx.clock.now(), { userId: u.userId, relationId: rel.id, date: '2026-11-02', start: '10:00' });
  return { ctx, db: ctx.db, t, u, rel, a };
}
type World = Awaited<ReturnType<typeof world>>;

const mins = (w: World, base: 'startAt' | 'endAt', n: number) => addMs(w.a[base], n * MINUTE_MS);
const current = async (w: World) => {
  const a = await getAppointment(w.db, w.a.id);
  if (!a) throw new Error('预约丢失');
  return a;
};
const callsLeft = async (w: World) => (await w.db.select().from(serviceRelations))[0].callsLeft;

function trtc(ctx: Ctx, body: object, key = 'ck') {
  const raw = JSON.stringify(body);
  return ctx.app.inject({
    method: 'POST',
    url: '/api/trtc/callback',
    headers: { 'content-type': 'application/json', sign: createHmac('sha256', key).update(raw).digest('base64') },
    payload: raw,
  });
}
const enterEvent = (roomId: number, userId: number, at: Date) => ({
  EventGroupId: 1,
  EventType: 103,
  CallbackTs: at.getTime(),
  EventInfo: { RoomId: roomId, EventTs: Math.floor(at.getTime() / 1000), EventMsTs: at.getTime(), UserId: `u${userId}` },
});

describe('进入通话', () => {
  test('时间窗口、只能进自己的预约；MOCK 模式直接记为已进房', async () => {
    const w = await world();
    const join = (who: { token: string }, path: string) => call(w.ctx, 'POST', path, { token: who.token });
    const userPath = `/api/appointments/${w.a.id}/join`;
    expect((await join(w.u, userPath)).statusCode).toBe(409);

    const early = mins(w, 'startAt', -5);
    w.ctx.clock.set(early);
    const ru = await join(w.u, userPath);
    expect(ru.statusCode).toBe(200);
    expect(ru.json()).toEqual({ mock: true, sdkAppId: 0, roomId: w.a.id, imId: `u${w.u.userId}`, userSig: 'mock' });
    expect((await join(w.t, userPath)).statusCode).toBe(404);
    expect((await join(w.t, `/api/teacher/appointments/${w.a.id}/join`)).statusCode).toBe(200);
    expect(await current(w)).toMatchObject({ teacherJoinedAt: early, userJoinedAt: early });

    w.ctx.clock.set(addMs(w.a.endAt, 1));
    expect((await join(w.u, userPath)).statusCode).toBe(409);
  });
});

describe('TRTC 房间回调', () => {
  test('双方进房后解散房间 → 通话完成；签名错误 401；非法 JSON 400', async () => {
    const w = await world(REAL);
    const start = w.a.startAt;
    expect((await trtc(w.ctx, enterEvent(w.a.id, w.t.userId, start), 'wrong')).statusCode).toBe(401);
    expect((await current(w)).teacherJoinedAt).toBeNull();
    const bad = await w.ctx.app.inject({
      method: 'POST',
      url: '/api/trtc/callback',
      headers: { 'content-type': 'application/json', sign: createHmac('sha256', 'ck').update('{').digest('base64') },
      payload: '{',
    });
    expect(bad.statusCode).toBe(400);

    await trtc(w.ctx, enterEvent(w.a.id, w.u.userId, mins(w, 'startAt', 1)));
    await trtc(w.ctx, enterEvent(w.a.id, w.t.userId, mins(w, 'startAt', 2)));
    await trtc(w.ctx, enterEvent(w.a.id, w.t.userId, start));
    expect(await current(w)).toMatchObject({ teacherJoinedAt: start, userJoinedAt: mins(w, 'startAt', 1) });

    const end = mins(w, 'startAt', 50);
    const res = await trtc(w.ctx, {
      EventGroupId: 1,
      EventType: 102,
      EventInfo: { RoomId: String(w.a.id), EventTs: Math.floor(end.getTime() / 1000) },
    });
    expect(res.json()).toEqual({ code: 0 });
    expect(await current(w)).toMatchObject({ status: 'completed', endedAt: end, confirmStatus: null });
    expect(await callsLeft(w)).toBe(3);
  });

  test('只有老师进房就解散，不算完成', async () => {
    const w = await world(REAL);
    await recordEnter(w.db, w.a.id, w.t.userId, w.a.startAt);
    expect(await onRoomDismissed(w.db, w.a.id, mins(w, 'startAt', 1))).toBe(false);
    expect((await current(w)).status).toBe('booked');
  });
});

describe('爽约与自动完成', () => {
  test('开始 15 分钟后老师仍未进房 → 爽约，退还次数并通知双方', async () => {
    const w = await world();
    expect(await markNoShows(w.db, mins(w, 'startAt', 14))).toBe(0);
    expect(await markNoShows(w.db, mins(w, 'startAt', 15))).toBe(1);
    expect((await current(w)).status).toBe('teacher_no_show');
    expect(await callsLeft(w)).toBe(4);
    expect(await noticesOf(w.db, w.u.userId, 'teacher_no_show')).toHaveLength(1);
    expect(await noticesOf(w.db, w.t.userId, 'teacher_no_show')).toHaveLength(1);
    expect(await recordEnter(w.db, w.a.id, w.t.userId, mins(w, 'startAt', 16))).toBe(false);
  });

  test('老师进过房、结束 30 分钟后仍无解散回调 → 自动完成（学员未到也消耗次数）', async () => {
    const w = await world();
    await recordEnter(w.db, w.a.id, w.t.userId, w.a.startAt);
    expect(await markNoShows(w.db, mins(w, 'startAt', 20))).toBe(0);
    expect(await autoComplete(w.db, mins(w, 'endAt', 29))).toBe(0);
    expect(await autoComplete(w.db, mins(w, 'endAt', 30))).toBe(1);
    expect(await current(w)).toMatchObject({ status: 'completed', endedAt: w.a.endAt });
    expect(await callsLeft(w)).toBe(3);
  });
});
```

**Step 2: 运行，确认失败**

Run: `pnpm vitest run src/providers src/modules/appointments/calls.test.ts`
Expected: FAIL（`tencent-callback.ts` 不存在；`recordEnter` 等未导出）。

**Step 3: 实现**

`src/providers/tencent-callback.ts`：

```ts
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const IM_MAX_SKEW_SEC = 300;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** IM 回调：URL 查询参数 `RequestTime` + `Sign = sha256(Token + RequestTime)` */
export function verifyImSign(token: string, q: { RequestTime?: string; Sign?: string }, now: Date): boolean {
  if (!token) return true;
  if (!q.RequestTime || !/^\d+$/.test(q.RequestTime)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(q.RequestTime)) > IM_MAX_SKEW_SEC) return false;
  return safeEqual(createHash('sha256').update(`${token}${q.RequestTime}`).digest('hex'), q.Sign ?? '');
}

/** TRTC 回调：请求头 `Sign = base64(HMAC-SHA256(key, 原始请求体))` */
export function verifyTrtcSign(key: string, rawBody: Buffer, sign: string | undefined): boolean {
  if (!key) return true;
  return safeEqual(createHmac('sha256', key).update(rawBody).digest('base64'), sign ?? '');
}
```

`src/modules/appointments/service.ts`：
- `drizzle-orm` 的 import 补上 `isNotNull`、`isNull`
- `../../lib/dates.ts` 的 import 补上 `addMs`
- 新增 import：

```ts
import { imCredential, type TencentConfig } from '../../providers/tencent.ts';
```

- 把 `// 后续 Task 在此追加：进入通话、房间回调、爽约、自动完成、单次确认` 替换为：

```ts
export const JOIN_EARLY_MINUTES = 10;
export const NO_SHOW_MINUTES = 15;
export const AUTO_COMPLETE_MINUTES = 30;

export interface JoinTicket {
  mock: boolean;
  sdkAppId: number;
  roomId: number;
  imId: string;
  userSig: string;
}

/** 记录最早一次进房时间。PostgreSQL 的 LEAST 忽略 NULL，回调乱序时也保留最早值 */
export async function recordEnter(db: DbOrTx, appointmentId: number, userId: number, at: Date): Promise<boolean> {
  const a = await getAppointment(db, appointmentId);
  if (!a || a.status !== 'booked') return false;
  const set =
    userId === a.teacherId
      ? { teacherJoinedAt: sql`LEAST(${appointments.teacherJoinedAt}, ${at}::timestamptz)` }
      : userId === a.userId
        ? { userJoinedAt: sql`LEAST(${appointments.userJoinedAt}, ${at}::timestamptz)` }
        : null;
  if (!set) return false;
  const rows = await db
    .update(appointments)
    .set(set)
    .where(and(eq(appointments.id, a.id), eq(appointments.status, 'booked')))
    .returning({ id: appointments.id });
  return rows.length > 0;
}

export async function joinCall(
  db: DbOrTx,
  now: Date,
  tc: TencentConfig,
  q: { userId: number; id: number; asTeacher: boolean },
): Promise<JoinTicket> {
  const a = await getAppointment(db, q.id);
  if (!a || (q.asTeacher ? a.teacherId : a.userId) !== q.userId) throw new HttpError(404, '预约不存在');
  if (a.status !== 'booked') throw new HttpError(409, '该预约不可进入');
  const t = now.getTime();
  if (t < a.startAt.getTime() - JOIN_EARLY_MINUTES * MINUTE_MS || t > a.endAt.getTime()) {
    throw new HttpError(409, `请在开始前 ${JOIN_EARLY_MINUTES} 分钟至结束前进入`);
  }
  const cred = imCredential(tc, q.userId, now);
  if (cred.mock) await recordEnter(db, a.id, q.userId, now);
  return { mock: cred.mock, sdkAppId: cred.sdkAppId, roomId: a.id, imId: cred.imId, userSig: cred.userSig };
}

/** 置为完成（要求老师进过房，extra 为附加条件）。单次套餐进入待确认并通知学员 */
async function completeCall(db: DbOrTx, a: Appointment, endedAt: Date, extra?: SQL): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rel = await lockRelation(tx, a.relationId);
    const single = rel?.packageType === 'single';
    const rows = await tx
      .update(appointments)
      .set({ status: 'completed', endedAt, confirmStatus: single ? 'pending' : null })
      .where(
        and(
          eq(appointments.id, a.id),
          eq(appointments.status, 'booked'),
          isNotNull(appointments.teacherJoinedAt),
          extra,
        ),
      )
      .returning({ id: appointments.id });
    if (rows.length === 0) return false;
    if (single) {
      await notify(tx, { userId: a.userId, type: 'call_confirm_request', payload: { appointmentId: a.id } });
    }
    return true;
  });
}

export async function onRoomDismissed(db: DbOrTx, appointmentId: number, at: Date): Promise<boolean> {
  const a = await getAppointment(db, appointmentId);
  if (!a) return false;
  return completeCall(db, a, at, isNotNull(appointments.userJoinedAt));
}

export async function markNoShows(db: DbOrTx, now: Date): Promise<number> {
  const cutoff = addMs(now, -NO_SHOW_MINUTES * MINUTE_MS);
  const rows = await db
    .select()
    .from(appointments)
    .where(and(eq(appointments.status, 'booked'), isNull(appointments.teacherJoinedAt), lte(appointments.startAt, cutoff)))
    .orderBy(asc(appointments.id));
  let n = 0;
  for (const a of rows) {
    // biome-ignore lint/performance/noAwaitInLoops: 逐条独立事务
    const done = await db.transaction(async (tx) => {
      const row = await releaseCall(tx, a, { status: 'teacher_no_show' }, isNull(appointments.teacherJoinedAt));
      if (!row) return false;
      const payload = { appointmentId: a.id };
      await notify(
        tx,
        { userId: a.userId, type: 'teacher_no_show', payload },
        { userId: a.teacherId, type: 'teacher_no_show', payload },
      );
      return true;
    });
    if (done) n += 1;
  }
  return n;
}

export async function autoComplete(db: DbOrTx, now: Date): Promise<number> {
  const cutoff = addMs(now, -AUTO_COMPLETE_MINUTES * MINUTE_MS);
  const rows = await db
    .select()
    .from(appointments)
    .where(and(eq(appointments.status, 'booked'), isNotNull(appointments.teacherJoinedAt), lte(appointments.endAt, cutoff)))
    .orderBy(asc(appointments.id));
  let n = 0;
  for (const a of rows) {
    // biome-ignore lint/performance/noAwaitInLoops: 逐条独立事务
    if (await completeCall(db, a, a.endAt)) n += 1;
  }
  return n;
}

// 后续 Task 在此追加：单次确认
```

`src/modules/appointments/routes.ts`：
- `./service.ts` 的 import 补上 `joinCall`
- `appointmentRoutes` 中把 `// 后续 Task 在此追加：进入通话、确认通话` 替换为：

```ts
    app.post('/:id/join', { schema: ById }, async (req) =>
      joinCall(deps.db, deps.clock.now(), deps.config.tencent, { userId: req.userId, id: req.params.id, asTeacher: false }),
    );

    // 后续 Task 在此追加：确认通话
```

- `teacherAppointmentRoutes` 中把 `// 后续 Task 在此追加：老师进入通话` 替换为：

```ts
    app.post('/:id/join', { schema: ById }, async (req) =>
      joinCall(deps.db, deps.clock.now(), deps.config.tencent, { userId: req.userId, id: req.params.id, asTeacher: true }),
    );
```

`src/modules/trtc/routes.ts`：

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { verifyTrtcSign } from '../../providers/tencent-callback.ts';
import { parseImId } from '../../providers/tencent.ts';
import { onRoomDismissed, recordEnter } from '../appointments/service.ts';

const ROOM_EVENTS = 1;
const DISMISS_ROOM = 102;
const ENTER_ROOM = 103;

const TrtcEvent = z.object({
  EventGroupId: z.number(),
  EventType: z.number(),
  EventInfo: z.object({
    RoomId: z.coerce.number().int().positive(),
    EventTs: z.number().optional(),
    EventMsTs: z.number().optional(),
    UserId: z.string().optional(),
  }),
});

export const trtcRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    // 仅在本插件作用域内保留原始请求体用于验签
    app.removeContentTypeParser('application/json');
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

    app.post('/callback', async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const sign = typeof req.headers.sign === 'string' ? req.headers.sign : undefined;
      if (!verifyTrtcSign(deps.config.tencent.trtcCallbackKey, raw, sign)) return reply.status(401).send({ code: 1 });

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        return reply.status(400).send({ code: 1 });
      }
      const ev = TrtcEvent.safeParse(parsed);
      if (ev.success && ev.data.EventGroupId === ROOM_EVENTS) {
        const info = ev.data.EventInfo;
        const at = new Date(info.EventMsTs ?? (info.EventTs ? info.EventTs * 1000 : deps.clock.now().getTime()));
        if (ev.data.EventType === ENTER_ROOM) {
          const uid = parseImId(info.UserId);
          if (uid) await recordEnter(deps.db, info.RoomId, uid, at);
        } else if (ev.data.EventType === DISMISS_ROOM) {
          await onRoomDismissed(deps.db, info.RoomId, at);
        }
      }
      return { code: 0 };
    });
  };
```

`src/routes.ts` 加 import 并注册：

```ts
  await app.register(trtcRoutes(deps), { prefix: '/api/trtc' });
```

**Step 4: 运行，确认通过**

Run: `pnpm vitest run src/providers src/modules/appointments`
Expected: PASS（回调验签 2、通话 6；预约 9 个无回归）。

Run（项目根）：`pnpm fix && pnpm check`
Expected: 全部通过；第一阶段 `/api/pay/*` 等 JSON 接口不受 TRTC 作用域内解析器影响。

**Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: TRTC 进入通话、房间回调、爽约与自动完成"
```

---

### Task 10: 单次套餐通话确认与计提

**Files:**
- Modify: `src/modules/appointments/service.ts`、`src/modules/appointments/routes.ts`
- Test: `src/modules/appointments/single-accrual.test.ts`

**规则：** 单次套餐通话完成后 `confirmStatus = 'pending'`。用户确认，或完成后 48 小时内无异议自动确认 → 写一条计提（日期为通话日、老师为实际上课老师、金额为订单全额），并结束该服务关系。用户提出异议 → `disputed`，不计提，通知老师（第五阶段工单处理）。周期套餐的通话不需要确认。冻结的服务关系也照常写计提，第一阶段的结算已经排除冻结关系。

**并发：** 确认与自动确认都在事务内按「服务关系 → 预约」加锁，预约更新带 `confirm_status = 'pending'` 条件，计提用 `(relation_id, date)` 唯一键 + `ON CONFLICT DO NOTHING`，所以用户确认与自动确认同时发生也只计一次。

**Step 1: 写失败测试**

`src/modules/appointments/single-accrual.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import { buyAndPay, call, insertPackage, loginTeacher, loginUser, noticesOf, setup } from '../../../tests/helpers.ts';
import { accruals, type packages, serviceRelations } from '../../db/schema.ts';
import { addMs, HOUR_MS, MINUTE_MS } from '../../lib/dates.ts';
import { setSchedule } from '../schedule/service.ts';
import { generateSettlements } from '../settlement/service.ts';
import { autoConfirm, book, getAppointment, onRoomDismissed, recordEnter } from './service.ts';

const SINGLE = { type: 'single', title: '单次咨询', days: 0, callQuota: 1, priceCents: 500 } as const;

async function world(pkg: Partial<typeof packages.$inferInsert> = SINGLE) {
  const ctx = await setup();
  const t = await loginTeacher(ctx, 't');
  const u = await loginUser(ctx, 'u');
  await setSchedule(ctx.db, t.userId, [{ weekday: 1, start: '09:00', end: '12:00' }]);
  const rel = await buyAndPay(ctx, u.userId, await insertPackage(ctx.db, t.userId, pkg));
  const a = await book(ctx.db, ctx.clock.now(), { userId: u.userId, relationId: rel.id, date: '2026-11-02', start: '10:00' });
  await recordEnter(ctx.db, a.id, t.userId, a.startAt);
  await recordEnter(ctx.db, a.id, u.userId, a.startAt);
  const ended = addMs(a.startAt, 50 * MINUTE_MS);
  await onRoomDismissed(ctx.db, a.id, ended);
  return { ctx, db: ctx.db, t, u, rel, a, ended };
}
type World = Awaited<ReturnType<typeof world>>;

const confirm = (w: World, ok: boolean) =>
  call(w.ctx, 'POST', `/api/appointments/${w.a.id}/confirm`, { token: w.u.token, body: { ok } });
const accrualRows = (w: World) =>
  w.db
    .select({ date: accruals.date, teacherId: accruals.teacherId, amountCents: accruals.amountCents })
    .from(accruals);
const confirmStatus = async (w: World) => (await getAppointment(w.db, w.a.id))?.confirmStatus;

describe('单次套餐通话确认', () => {
  test('通话完成后待用户确认，并通知用户', async () => {
    const w = await world();
    expect(await confirmStatus(w)).toBe('pending');
    expect(await noticesOf(w.db, w.u.userId, 'call_confirm_request')).toHaveLength(1);
    expect(await accrualRows(w)).toEqual([]);
  });

  test('用户确认 → 全额计给上课老师、服务关系结束、进入周结算；重复确认 409', async () => {
    const w = await world();
    const res = await confirm(w, true);
    expect(res.statusCode).toBe(200);
    expect(res.json().confirmStatus).toBe('confirmed');
    expect(await accrualRows(w)).toEqual([{ date: '2026-11-02', teacherId: w.t.userId, amountCents: 500 }]);
    const [r] = await w.db.select().from(serviceRelations);
    expect(r.status).toBe('ended');
    const [s] = await generateSettlements(w.db, { periodStart: '2026-11-01', periodEnd: '2026-11-07' });
    expect(s.grossCents).toBe(500);
    expect((await confirm(w, true)).statusCode).toBe(409);
  });

  test('用户提出异议 → 不计提，通知老师', async () => {
    const w = await world();
    expect((await confirm(w, false)).json().confirmStatus).toBe('disputed');
    expect(await accrualRows(w)).toEqual([]);
    expect(await noticesOf(w.db, w.t.userId, 'call_disputed')).toHaveLength(1);
  });

  test('完成 48 小时内无异议自动确认；与用户确认并发只计一次', async () => {
    const w = await world();
    expect(await autoConfirm(w.db, addMs(w.ended, 47 * HOUR_MS))).toBe(0);
    const [auto, manual] = await Promise.all([autoConfirm(w.db, addMs(w.ended, 48 * HOUR_MS)), confirm(w, true)]);
    expect(auto + (manual.statusCode === 200 ? 1 : 0)).toBe(1);
    expect(['auto', 'confirmed']).toContain(await confirmStatus(w));
    expect(await accrualRows(w)).toHaveLength(1);
  });

  test('周期套餐的通话不需要确认', async () => {
    const w = await world({});
    expect(await confirmStatus(w)).toBeNull();
    expect((await confirm(w, true)).statusCode).toBe(409);
  });
});
```

**Step 2: 运行，确认失败**

Run: `pnpm vitest run src/modules/appointments/single-accrual.test.ts`
Expected: FAIL（`autoConfirm` 未导出 / 404）。

**Step 3: 实现**

`src/modules/appointments/service.ts`：
- schema 的 import 补上 `accruals`
- 把 `// 后续 Task 在此追加：单次确认` 替换为：

```ts
export const CONFIRM_HOURS = 48;

/** 单次套餐：全额计给上课老师并结束服务关系。调用方须在事务中且已锁服务关系行 */
async function accrueSingle(tx: DbOrTx, a: Appointment): Promise<void> {
  const [rel] = await tx.select().from(serviceRelations).where(eq(serviceRelations.id, a.relationId));
  if (!rel || rel.packageType !== 'single') return;
  await tx
    .insert(accruals)
    .values({ relationId: rel.id, date: a.date, teacherId: a.teacherId, amountCents: rel.amountCents })
    .onConflictDoNothing({ target: [accruals.relationId, accruals.date] });
  await tx
    .update(serviceRelations)
    .set({ status: 'ended' })
    .where(and(eq(serviceRelations.id, rel.id), eq(serviceRelations.status, 'active')));
}

/** 待确认 → confirmed/disputed/auto；已不是 pending 时返回 null。调用方须在事务中 */
async function settleConfirm(
  tx: DbOrTx,
  a: Appointment,
  to: 'confirmed' | 'disputed' | 'auto',
): Promise<Appointment | null> {
  await lockRelation(tx, a.relationId);
  const [row] = await tx
    .update(appointments)
    .set({ confirmStatus: to })
    .where(and(eq(appointments.id, a.id), eq(appointments.status, 'completed'), eq(appointments.confirmStatus, 'pending')))
    .returning();
  if (!row) return null;
  if (to === 'disputed') {
    await notify(tx, { userId: a.teacherId, type: 'call_disputed', payload: { appointmentId: a.id } });
  } else {
    await accrueSingle(tx, row);
  }
  return row;
}

export async function confirmCall(db: DbOrTx, q: { userId: number; id: number; ok: boolean }): Promise<Appointment> {
  const a = await getAppointment(db, q.id);
  if (!a || a.userId !== q.userId) throw new HttpError(404, '预约不存在');
  return db.transaction(async (tx) => {
    const row = await settleConfirm(tx, a, q.ok ? 'confirmed' : 'disputed');
    if (!row) throw new HttpError(409, '该通话无需确认');
    return row;
  });
}

export async function autoConfirm(db: DbOrTx, now: Date): Promise<number> {
  const cutoff = addMs(now, -CONFIRM_HOURS * HOUR_MS);
  const rows = await db
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.status, 'completed'),
        eq(appointments.confirmStatus, 'pending'),
        lte(appointments.endedAt, cutoff),
      ),
    )
    .orderBy(asc(appointments.id));
  let n = 0;
  for (const a of rows) {
    // biome-ignore lint/performance/noAwaitInLoops: 逐条独立事务
    if (await db.transaction((tx) => settleConfirm(tx, a, 'auto'))) n += 1;
  }
  return n;
}
```

`src/modules/appointments/routes.ts`：
- `./service.ts` 的 import 补上 `confirmCall`
- 把 `// 后续 Task 在此追加：确认通话` 替换为：

```ts
    app.post('/:id/confirm', { schema: { ...ById, body: z.object({ ok: z.boolean() }) } }, async (req) =>
      confirmCall(deps.db, { userId: req.userId, id: req.params.id, ok: req.body.ok }),
    );
```

**Step 4: 运行，确认通过**

Run: `pnpm vitest run src/modules/appointments src/modules/accrual`
Expected: 新增 5 个 PASS；第一阶段日计提 7 个仍 PASS（单次套餐不参与日计提）。

**Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: 单次套餐通话确认与计提"
```

---

### Task 11: 聊天权限、IM 发送前回调与联系人

**Files:**
- Create: `src/modules/chat/service.ts`
- Modify: `src/modules/im/routes.ts`
- Test: `src/modules/chat/chat.test.ts`

**规则：**
- 学员 ↔ 原老师：存在 `active` 的服务关系即可（包括原老师请假当天）。
- 学员 ↔ 代班老师：仅当天落在该老师代班分段的服务关系。
- `resolvePair(a, b)` 自动识别谁是学员；同一对有多条关系时，优先当天由该老师负责的那条。返回 `responsible`（当天负责老师，暂停日为 `null`），供回复时效统计使用。
- IM 回调 `C2C.CallbackBeforeSendMsg`：没有权限时返回 `ErrorCode 120001` 拦截；非 `u{id}` 账号（如系统管理员）放行。所有回调先校验 `Sign`，失败返回 403。
- IM 回调的查询参数和请求体只声明用到的字段，其余字段（`SdkAppid`、`ClientIP` 等）由 Zod 默认剥离，不会因为腾讯云多传字段而 400。

**Step 1: 写失败测试**

`src/modules/chat/chat.test.ts`：

```ts
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import {
  buyAndPay,
  call,
  FIXED_NOW,
  insertPackage,
  loginTeacher,
  loginUser,
  setup,
  TENCENT,
} from '../../../tests/helpers.ts';
import type { Config } from '../../config.ts';
import { serviceRelations } from '../../db/schema.ts';
import { applySubstitute } from '../../domain/segments.ts';
import { rewriteSegments } from '../relations/service.ts';
import { resolvePair } from './service.ts';

const TODAY = '2026-11-01';

async function world(config?: Partial<Config>) {
  const ctx = await setup({ config });
  const t = await loginTeacher(ctx, 't');
  const s = await loginTeacher(ctx, 's');
  const u = await loginUser(ctx, 'u');
  const x = await loginUser(ctx, 'x');
  const rel = await buyAndPay(ctx, u.userId, await insertPackage(ctx.db, t.userId));
  return { ctx, db: ctx.db, t, s, u, x, rel };
}
type World = Awaited<ReturnType<typeof world>>;

const substituteOn = (w: World, date: string) =>
  rewriteSegments(w.db, w.rel.id, (segs) => applySubstitute(segs, { from: date, to: date, teacherId: w.s.userId }));
const before = (w: World, from: string, to: string, query?: Record<string, string>) =>
  call(w.ctx, 'POST', '/api/im/callback', {
    query: { SdkAppid: '1400000001', CallbackCommand: 'C2C.CallbackBeforeSendMsg', ...query },
    body: {
      CallbackCommand: 'C2C.CallbackBeforeSendMsg',
      From_Account: from,
      To_Account: to,
      MsgBody: [{ MsgType: 'TIMTextElem', MsgContent: { Text: '你好' } }],
    },
  });

describe('聊天权限', () => {
  test('学员与原老师可聊天（双向识别），与陌生人不可', async () => {
    const w = await world();
    expect(await resolvePair(w.db, w.u.userId, w.t.userId, TODAY)).toMatchObject({
      studentId: w.u.userId,
      teacherId: w.t.userId,
      responsible: w.t.userId,
    });
    expect((await resolvePair(w.db, w.t.userId, w.u.userId, TODAY))?.studentId).toBe(w.u.userId);
    expect(await resolvePair(w.db, w.u.userId, w.x.userId, TODAY)).toBeNull();
    expect(await resolvePair(w.db, w.u.userId, w.s.userId, TODAY)).toBeNull();
  });

  test('代班老师仅在代班日可聊天；当天原老师仍可聊但不是负责人', async () => {
    const w = await world();
    await substituteOn(w, TODAY);
    expect((await resolvePair(w.db, w.u.userId, w.s.userId, TODAY))?.responsible).toBe(w.s.userId);
    expect(await resolvePair(w.db, w.u.userId, w.s.userId, '2026-11-02')).toBeNull();
    expect((await resolvePair(w.db, w.u.userId, w.t.userId, TODAY))?.responsible).toBe(w.s.userId);
  });

  test('服务关系结束后不可聊天', async () => {
    const w = await world();
    await w.db.update(serviceRelations).set({ status: 'ended' }).where(eq(serviceRelations.id, w.rel.id));
    expect(await resolvePair(w.db, w.u.userId, w.t.userId, TODAY)).toBeNull();
  });
});

describe('IM 回调与联系人', () => {
  test('发送前回调：有权限放行、无权限拦截、系统账号放行', async () => {
    const w = await world();
    expect((await before(w, `u${w.u.userId}`, `u${w.t.userId}`)).json()).toEqual({
      ActionStatus: 'OK',
      ErrorCode: 0,
      ErrorInfo: '',
    });
    expect((await before(w, `u${w.u.userId}`, `u${w.x.userId}`)).json().ErrorCode).toBe(120001);
    expect((await before(w, 'administrator', `u${w.x.userId}`)).json().ErrorCode).toBe(0);
  });

  test('回调鉴权：配置 Token 后签名错误返回 403', async () => {
    const w = await world({ tencent: { ...TENCENT, imCallbackToken: 'tok' } });
    const RequestTime = String(Date.parse(FIXED_NOW) / 1000);
    const Sign = createHash('sha256').update(`tok${RequestTime}`).digest('hex');
    const from = `u${w.u.userId}`;
    const to = `u${w.t.userId}`;
    expect((await before(w, from, to, { RequestTime, Sign })).statusCode).toBe(200);
    expect((await before(w, from, to, { RequestTime, Sign: 'bad' })).statusCode).toBe(403);
    expect((await before(w, from, to)).statusCode).toBe(403);
  });

  test('联系人：学员看到原老师与当日代班老师；老师各自看到学员', async () => {
    const w = await world();
    await substituteOn(w, TODAY);
    const list = async (who: { token: string }) => (await call(w.ctx, 'GET', '/api/im/contacts', { token: who.token })).json();
    const brief = (cs: { userId: number; role: string; substitute: boolean }[]) =>
      cs.map((c) => [c.userId, c.role, c.substitute]);

    const mine = await list(w.u);
    expect(brief(mine)).toEqual([
      [w.t.userId, 'teacher', false],
      [w.s.userId, 'teacher', true],
    ]);
    expect(mine[0]).toMatchObject({ imId: `u${w.t.userId}`, name: `老师${w.t.userId}` });
    expect(brief(await list(w.t))).toEqual([[w.u.userId, 'student', false]]);
    expect(brief(await list(w.s))).toEqual([[w.u.userId, 'student', true]]);
    expect(await list(w.x)).toEqual([]);
  });
});
```

**Step 2: 运行，确认失败**

Run: `pnpm vitest run src/modules/chat`
Expected: FAIL（`./service.ts` 不存在）。

**Step 3: 实现**

`src/modules/chat/service.ts`：

```ts
import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '../../db/client.ts';
import { serviceRelations, serviceSegments, teacherProfiles, users } from '../../db/schema.ts';
import { segmentOn } from '../../domain/segments.ts';
import { imIdOf } from '../../providers/tencent.ts';
import { loadSegments } from '../relations/service.ts';

type Relation = typeof serviceRelations.$inferSelect;

export interface ChatLink {
  relation: Relation;
  studentId: number;
  teacherId: number;
  /** 当天负责该关系的老师；暂停日为 null */
  responsible: number | null;
}

async function linkOf(db: DbOrTx, studentId: number, teacherId: number, today: string): Promise<ChatLink | null> {
  const rels = await db
    .select()
    .from(serviceRelations)
    .where(and(eq(serviceRelations.userId, studentId), eq(serviceRelations.status, 'active')))
    .orderBy(asc(serviceRelations.id));
  let found: ChatLink | null = null;
  for (const r of rels) {
    // biome-ignore lint/performance/noAwaitInLoops: 关系数很少，顺序读取即可
    const seg = segmentOn(await loadSegments(db, r.id), today);
    const responsible = seg && seg.kind !== 'paused' ? seg.teacherId : null;
    const isOwner = r.teacherId === teacherId;
    const isSubstitute = seg?.kind === 'substitute' && seg.teacherId === teacherId;
    if (!isOwner && !isSubstitute) continue;
    const link: ChatLink = { relation: r, studentId, teacherId, responsible };
    if (responsible === teacherId) return link;
    found ??= link;
  }
  return found;
}

export async function resolvePair(db: DbOrTx, a: number, b: number, today: string): Promise<ChatLink | null> {
  return (await linkOf(db, a, b, today)) ?? (await linkOf(db, b, a, today));
}

export interface Contact {
  userId: number;
  imId: string;
  role: 'teacher' | 'student';
  substitute: boolean;
  name: string;
}

export async function contactsOf(db: DbOrTx, userId: number, today: string): Promise<Contact[]> {
  const out = new Map<number, Omit<Contact, 'name'>>();
  const add = (id: number, role: Contact['role'], substitute: boolean) => {
    if (!out.has(id)) out.set(id, { userId: id, imId: imIdOf(id), role, substitute });
  };

  const asStudent = await db
    .select({ id: serviceRelations.id, teacherId: serviceRelations.teacherId })
    .from(serviceRelations)
    .where(and(eq(serviceRelations.userId, userId), eq(serviceRelations.status, 'active')))
    .orderBy(asc(serviceRelations.id));
  for (const r of asStudent) {
    add(r.teacherId, 'teacher', false);
    // biome-ignore lint/performance/noAwaitInLoops: 关系数很少，顺序读取即可
    const seg = segmentOn(await loadSegments(db, r.id), today);
    if (seg?.kind === 'substitute' && seg.teacherId !== null) add(seg.teacherId, 'teacher', true);
  }

  const asOwner = await db
    .select({ userId: serviceRelations.userId })
    .from(serviceRelations)
    .where(and(eq(serviceRelations.teacherId, userId), eq(serviceRelations.status, 'active')))
    .orderBy(asc(serviceRelations.id));
  for (const r of asOwner) add(r.userId, 'student', false);

  const asSubstitute = await db
    .select({ userId: serviceRelations.userId })
    .from(serviceRelations)
    .innerJoin(serviceSegments, eq(serviceSegments.relationId, serviceRelations.id))
    .where(
      and(
        eq(serviceRelations.status, 'active'),
        eq(serviceSegments.kind, 'substitute'),
        eq(serviceSegments.teacherId, userId),
        lte(serviceSegments.startDate, today),
        gte(serviceSegments.endDate, today),
      ),
    )
    .orderBy(asc(serviceRelations.id));
  for (const r of asSubstitute) add(r.userId, 'student', true);

  const list = [...out.values()];
  if (list.length === 0) return [];
  const names = await db
    .select({ id: users.id, nickname: users.nickname, displayName: teacherProfiles.displayName })
    .from(users)
    .leftJoin(teacherProfiles, eq(teacherProfiles.userId, users.id))
    .where(
      inArray(
        users.id,
        list.map((c) => c.userId),
      ),
    );
  const byId = new Map(names.map((n) => [n.id, n]));
  return list.map((c) => {
    const n = byId.get(c.userId);
    return { ...c, name: (c.role === 'teacher' ? n?.displayName : n?.nickname) ?? '' };
  });
}

const TextElem = z.object({ MsgType: z.literal('TIMTextElem'), MsgContent: z.object({ Text: z.string() }) });

/** 取出 IM 消息体中的全部文本元素 */
export function textOf(msgBody: unknown): string {
  if (!Array.isArray(msgBody)) return '';
  return msgBody
    .flatMap((e) => {
      const r = TextElem.safeParse(e);
      return r.success ? [r.data.MsgContent.Text] : [];
    })
    .join('\n');
}

// 后续 Task 在此追加：发送后处理（关键词、回复时效）
```

`src/modules/im/routes.ts` 整文件替换为：

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { todayCN } from '../../lib/dates.ts';
import { verifyImSign } from '../../providers/tencent-callback.ts';
import { imCredential, parseImId } from '../../providers/tencent.ts';
import { userGuard } from '../auth/guards.ts';
import { contactsOf, resolvePair } from '../chat/service.ts';

const IM_OK = { ActionStatus: 'OK', ErrorCode: 0, ErrorInfo: '' };
const IM_NO_SERVICE = { ActionStatus: 'OK', ErrorCode: 120001, ErrorInfo: '当前没有进行中的服务，无法发送消息' };
const IM_BAD_SIGN = { ActionStatus: 'FAIL', ErrorCode: 1, ErrorInfo: 'invalid sign' };

const CallbackQuery = z.object({ RequestTime: z.string().optional(), Sign: z.string().optional() });
const CallbackBody = z.object({
  CallbackCommand: z.string().optional(),
  From_Account: z.string().optional(),
  To_Account: z.string().optional(),
  MsgBody: z.unknown().optional(),
});

export const imRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.post(
      '/callback',
      { schema: { querystring: CallbackQuery, body: CallbackBody, hide: true } },
      async (req, reply) => {
        const now = deps.clock.now();
        if (!verifyImSign(deps.config.tencent.imCallbackToken, req.query, now)) {
          return reply.status(403).send(IM_BAD_SIGN);
        }
        const from = parseImId(req.body.From_Account);
        const to = parseImId(req.body.To_Account);
        if (from && to && req.body.CallbackCommand === 'C2C.CallbackBeforeSendMsg') {
          if (!(await resolvePair(deps.db, from, to, todayCN(now)))) return IM_NO_SERVICE;
        }
        // 后续 Task 在此追加：发送后处理
        return IM_OK;
      },
    );

    await app.register(async (authed) => {
      authed.addHook('preHandler', userGuard(deps));

      authed.get('/usersig', async (req) => imCredential(deps.config.tencent, req.userId, deps.clock.now()));

      authed.get('/contacts', async (req) => contactsOf(deps.db, req.userId, todayCN(deps.clock.now())));
    });
  };
```

**Step 4: 运行，确认通过**

Run: `pnpm vitest run src/modules/chat src/providers`
Expected: PASS（聊天 6 个；UserSig 3 个无回归）。

**Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: 聊天权限、IM 发送前回调与联系人"
```

---

### Task 12: 危机词与私下交易提示、回复时效统计

**Files:**
- Create: `src/domain/keywords.ts`、`src/modules/chat/replies.ts`、`src/modules/chat/routes.ts`
- Modify: `src/modules/chat/service.ts`、`src/modules/im/routes.ts`、`src/routes.ts`
- Test: `src/domain/keywords.test.ts`、`src/modules/chat/after-send.test.ts`

**规则：**
- 只处理有聊天权限的消息（`resolvePair` 非空）。
- 危机词：写 `crisis_events`（`userId` 为发送者），给发送者发热线提示（`config.crisisHotline`），并通知对方 `crisis_alert`。
- 私下交易（关键词或手机号）：写 `risk_events`，提示发送者。
- 回复时效：学员发给**当天负责老师**的消息开始计时（同一对已有未回复的计时则不重复）；老师给该学员发任意消息即结束计时。原老师请假暂停日不计时。
- 「不重复计时」由部分唯一索引 `reply_waits_open_uq` + `ON CONFLICT DO NOTHING` 保证，学员连发多条并发到达也只有一条计时。
- 统计：区间内发起的计时中，已回复且未超过 `replyHours` 算达标；未回复且已超时算未达标；未回复也未超时的不计入。
- 发送后回调的处理失败不影响消息本身：记错误日志后照常返回 OK。

**Step 1: 写失败测试**

`src/domain/keywords.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import { scanText } from './keywords.ts';

describe('关键词扫描', () => {
  test('危机词、私下交易词与手机号', () => {
    expect(scanText('我真的不想活了')).toEqual({ crisis: '不想活', privateTrade: null });
    expect(scanText('加我微信吧')).toEqual({ crisis: null, privateTrade: '微信' });
    expect(scanText('打我电话13812345678')).toEqual({ crisis: null, privateTrade: '13812345678' });
    expect(scanText('加个VX')).toEqual({ crisis: null, privateTrade: 'vx' });
    expect(scanText('今天心情不错')).toEqual({ crisis: null, privateTrade: null });
  });
});
```

`src/modules/chat/after-send.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import { buyAndPay, call, insertPackage, loginTeacher, loginUser, noticesOf, setup } from '../../../tests/helpers.ts';
import { crisisEvents, replyWaits, riskEvents } from '../../db/schema.ts';
import { applyPause } from '../../domain/segments.ts';
import { addMs, HOUR_MS, MINUTE_MS } from '../../lib/dates.ts';
import { rewriteSegments } from '../relations/service.ts';
import { replyStats } from './replies.ts';
import { handleAfterSend } from './service.ts';

async function world() {
  const ctx = await setup();
  const t = await loginTeacher(ctx, 't');
  const u = await loginUser(ctx, 'u');
  const x = await loginUser(ctx, 'x');
  const rel = await buyAndPay(ctx, u.userId, await insertPackage(ctx.db, t.userId, { replyHours: 12 }));
  return { ctx, db: ctx.db, t, u, x, rel, t0: ctx.clock.now() };
}
type World = Awaited<ReturnType<typeof world>>;
type Who = { userId: number };

const send = (w: World, from: Who, to: Who, text: string, now = w.t0) =>
  handleAfterSend(w.db, { from: from.userId, to: to.userId, text, now, hotline: '12356' });

describe('发送后处理', () => {
  test('危机词：记录事件，给发送者热线提示，通知对方', async () => {
    const w = await world();
    await send(w, w.u, w.t, '最近总想自杀');
    const [e] = await w.db.select().from(crisisEvents);
    expect(e).toMatchObject({ userId: w.u.userId, peerId: w.t.userId, keyword: '自杀', status: 'open' });
    const [hotline] = await noticesOf(w.db, w.u.userId, 'crisis_hotline');
    expect(hotline.payload).toEqual({ hotline: '12356' });
    expect(await noticesOf(w.db, w.t.userId, 'crisis_alert')).toHaveLength(1);
  });

  test('私下交易：记录风险事件并提示发送者', async () => {
    const w = await world();
    await send(w, w.t, w.u, '加我微信聊');
    const [r] = await w.db.select().from(riskEvents);
    expect(r).toMatchObject({ fromUserId: w.t.userId, toUserId: w.u.userId, keyword: '微信' });
    expect(await noticesOf(w.db, w.t.userId, 'private_trade_warning')).toHaveLength(1);
  });

  test('没有服务关系的消息不处理', async () => {
    const w = await world();
    await send(w, w.u, w.x, '想死');
    expect(await w.db.$count(crisisEvents)).toBe(0);
    expect(await w.db.$count(replyWaits)).toBe(0);
  });
});

describe('回复时效', () => {
  test('学员提问开始计时（并发也只计一条）、老师回复结束；按承诺小时数统计达标率', async () => {
    const w = await world();
    await Promise.all([send(w, w.u, w.t, '在吗'), send(w, w.u, w.t, '有个问题', addMs(w.t0, MINUTE_MS))]);
    expect(await w.db.$count(replyWaits)).toBe(1);
    await send(w, w.t, w.u, '在的', addMs(w.t0, 2 * HOUR_MS));
    const [wait] = await w.db.select().from(replyWaits);
    expect(wait.repliedAt).toEqual(addMs(w.t0, 2 * HOUR_MS));

    const t1 = addMs(w.t0, 3 * HOUR_MS);
    await send(w, w.u, w.t, '还有一个问题', t1);
    const range = { from: w.t0, to: addMs(w.t0, 24 * HOUR_MS) };
    expect(await replyStats(w.db, w.t.userId, { ...range, now: addMs(t1, 11 * HOUR_MS) })).toEqual({
      total: 1,
      onTime: 1,
      rate: 1,
    });
    expect(await replyStats(w.db, w.t.userId, { ...range, now: addMs(t1, 13 * HOUR_MS) })).toEqual({
      total: 2,
      onTime: 1,
      rate: 0.5,
    });
  });

  test('原老师当天暂停（请假）时，学员消息不计时', async () => {
    const w = await world();
    await rewriteSegments(w.db, w.rel.id, (s) => applyPause(s, { from: '2026-11-01', to: '2026-11-01' }));
    await send(w, w.u, w.t, '老师好');
    expect(await w.db.$count(replyWaits)).toBe(0);
  });

  test('HTTP：IM 发送后回调接入处理；老师查看回复时效统计', async () => {
    const w = await world();
    const res = await call(w.ctx, 'POST', '/api/im/callback', {
      body: {
        CallbackCommand: 'C2C.CallbackAfterSendMsg',
        From_Account: `u${w.u.userId}`,
        To_Account: `u${w.t.userId}`,
        MsgBody: [{ MsgType: 'TIMTextElem', MsgContent: { Text: '我不想活了' } }],
      },
    });
    expect(res.json().ErrorCode).toBe(0);
    expect(await w.db.$count(crisisEvents)).toBe(1);
    expect(await w.db.$count(replyWaits)).toBe(1);

    w.ctx.clock.set(addMs(w.t0, 13 * HOUR_MS));
    const stats = await call(w.ctx, 'GET', '/api/teacher/reply-stats', {
      token: w.t.token,
      query: { from: '2026-11-01', to: '2026-11-01' },
    });
    expect(stats.json()).toEqual({ from: '2026-11-01', to: '2026-11-01', total: 1, onTime: 0, rate: 0 });
    const bad = await call(w.ctx, 'GET', '/api/teacher/reply-stats', {
      token: w.t.token,
      query: { from: '2026-11-02', to: '2026-11-01' },
    });
    expect(bad.statusCode).toBe(400);
  });
});
```

**Step 2: 运行，确认失败**

Run: `pnpm vitest run src/domain/keywords.test.ts src/modules/chat/after-send.test.ts`
Expected: FAIL（模块不存在）。

**Step 3: 实现**

`src/domain/keywords.ts`：

```ts
const CRISIS_WORDS = ['自杀', '轻生', '不想活', '想死', '活不下去', '结束生命', '割腕', '跳楼', '自残'];
const PRIVATE_WORDS = ['微信', 'vx', 'v信', '加我', '私下', '转账', '支付宝', 'qq'];
const PHONE = /1[3-9]\d{9}/;

export interface ScanResult {
  crisis: string | null;
  privateTrade: string | null;
}

export function scanText(text: string): ScanResult {
  const t = text.toLowerCase();
  const crisis = CRISIS_WORDS.find((k) => t.includes(k)) ?? null;
  const privateTrade = PRIVATE_WORDS.find((k) => t.includes(k)) ?? PHONE.exec(t)?.[0] ?? null;
  return { crisis, privateTrade };
}
```

`src/modules/chat/replies.ts`：

```ts
import { and, eq, gte, isNull, lt } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { replyWaits } from '../../db/schema.ts';
import { HOUR_MS } from '../../lib/dates.ts';
import type { ChatLink } from './service.ts';

/** 学员发给当天负责老师 → 开始计时；老师发给学员 → 结束计时 */
export async function onMessage(tx: DbOrTx, pair: ChatLink, fromId: number, now: Date): Promise<void> {
  if (fromId === pair.studentId) {
    if (pair.responsible !== pair.teacherId) return;
    await tx
      .insert(replyWaits)
      .values({
        teacherId: pair.teacherId,
        userId: pair.studentId,
        relationId: pair.relation.id,
        replyHours: pair.relation.replyHours,
        askedAt: now,
      })
      // 命中部分唯一索引 reply_waits_open_uq：已有未回复的计时，不重复
      .onConflictDoNothing();
    return;
  }
  await tx
    .update(replyWaits)
    .set({ repliedAt: now })
    .where(and(eq(replyWaits.teacherId, pair.teacherId), eq(replyWaits.userId, pair.studentId), isNull(replyWaits.repliedAt)));
}

export interface ReplyStats {
  total: number;
  onTime: number;
  rate: number | null;
}

export async function replyStats(
  db: DbOrTx,
  teacherId: number,
  q: { from: Date; to: Date; now: Date },
): Promise<ReplyStats> {
  const rows = await db
    .select({ askedAt: replyWaits.askedAt, repliedAt: replyWaits.repliedAt, replyHours: replyWaits.replyHours })
    .from(replyWaits)
    .where(and(eq(replyWaits.teacherId, teacherId), gte(replyWaits.askedAt, q.from), lt(replyWaits.askedAt, q.to)));
  let total = 0;
  let onTime = 0;
  for (const r of rows) {
    const deadline = r.askedAt.getTime() + r.replyHours * HOUR_MS;
    if (r.repliedAt) {
      total += 1;
      if (r.repliedAt.getTime() <= deadline) onTime += 1;
    } else if (q.now.getTime() > deadline) {
      total += 1;
    }
  }
  return { total, onTime, rate: total ? onTime / total : null };
}
```

`src/modules/chat/service.ts`：
- schema 的 import 补上 `crisisEvents`、`riskEvents`
- 新增 import：

```ts
import { scanText } from '../../domain/keywords.ts';
import { todayCN } from '../../lib/dates.ts';
import { type Notice, notify } from '../../lib/notify.ts';
import { onMessage } from './replies.ts';
```

- 把 `// 后续 Task 在此追加：发送后处理（关键词、回复时效）` 替换为：

```ts
const EXCERPT_CHARS = 200;

export async function handleAfterSend(
  db: DbOrTx,
  m: { from: number; to: number; text: string; now: Date; hotline: string },
): Promise<void> {
  const pair = await resolvePair(db, m.from, m.to, todayCN(m.now));
  if (!pair) return;
  const excerpt = [...m.text].slice(0, EXCERPT_CHARS).join('');
  const { crisis, privateTrade } = scanText(m.text);
  await db.transaction(async (tx) => {
    const notices: Notice[] = [];
    if (crisis) {
      const [e] = await tx
        .insert(crisisEvents)
        .values({ userId: m.from, peerId: m.to, keyword: crisis, excerpt, createdAt: m.now })
        .returning({ id: crisisEvents.id });
      notices.push(
        { userId: m.from, type: 'crisis_hotline', payload: { hotline: m.hotline } },
        { userId: m.to, type: 'crisis_alert', payload: { eventId: e.id, fromUserId: m.from } },
      );
    }
    if (privateTrade) {
      await tx
        .insert(riskEvents)
        .values({ fromUserId: m.from, toUserId: m.to, keyword: privateTrade, excerpt, createdAt: m.now });
      notices.push({ userId: m.from, type: 'private_trade_warning', payload: { keyword: privateTrade } });
    }
    await onMessage(tx, pair, m.from, m.now);
    await notify(tx, ...notices);
  });
}
```

`src/modules/im/routes.ts`：
- `../chat/service.ts` 的 import 补上 `handleAfterSend`、`textOf`
- 把 `// 后续 Task 在此追加：发送后处理` 替换为：

```ts
        if (from && to && req.body.CallbackCommand === 'C2C.CallbackAfterSendMsg') {
          try {
            await handleAfterSend(deps.db, {
              from,
              to,
              text: textOf(req.body.MsgBody),
              now,
              hotline: deps.config.crisisHotline,
            });
          } catch (err) {
            req.log.error({ err, from, to }, 'IM 发送后处理失败');
          }
        }
```

`src/modules/chat/routes.ts`：

```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { addDays, dayStartCN, todayCN } from '../../lib/dates.ts';
import { HttpError } from '../../lib/errors.ts';
import { DateStr } from '../../lib/zod.ts';
import { teacherGuard } from '../teachers/guard.ts';
import { replyStats } from './replies.ts';

const DEFAULT_DAYS = 30;

export const teacherReplyStatsRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.addHook('preHandler', teacherGuard(deps));

    app.get(
      '/',
      { schema: { querystring: z.object({ from: DateStr.optional(), to: DateStr.optional() }) } },
      async (req) => {
        const now = deps.clock.now();
        const to = req.query.to ?? todayCN(now);
        const from = req.query.from ?? addDays(to, 1 - DEFAULT_DAYS);
        if (from > to) throw new HttpError(400, '统计区间非法');
        const stats = await replyStats(deps.db, req.userId, {
          from: dayStartCN(from),
          to: dayStartCN(addDays(to, 1)),
          now,
        });
        return { from, to, ...stats };
      },
    );
  };
```

`src/routes.ts` 加 import 并注册：

```ts
  await app.register(teacherReplyStatsRoutes(deps), { prefix: '/api/teacher/reply-stats' });
```

**Step 4: 运行，确认通过**

Run: `pnpm vitest run src/domain src/modules/chat`
Expected: PASS（关键词 1、发送后处理 6、聊天 6；分段用例无回归）。

验证约束确实起作用：临时把 `onMessage` 里的 `.onConflictDoNothing()` 去掉，重跑回复时效用例，应因 `reply_waits_open_uq` 冲突而 FAIL；恢复后 PASS。

**Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: 危机词与私下交易提示、回复时效统计"
```

---

### Task 13: 分钟级定时任务 + 第二阶段全链路测试

**Files:**
- Create: `src/jobs/frequent.ts`
- Modify: `src/jobs/index.ts`、`src/jobs/jobs.test.ts`、`/README.md`
- Test: `tests/phase2-flow.test.ts`

**说明：**
- 选择过期、爽约、自动完成、自动确认都需要分钟级执行：新增任务 `frequent`，cron `* * * * *`（北京时间），注册方式与第一阶段的 `daily` 相同。
- 四个子任务都幂等（条件更新 + 唯一键 + `SKIP LOCKED`），pg-boss 重试、多实例同时执行都安全。子任务按顺序执行；前一个抛错时整个任务失败，交给 pg-boss 重试，已提交的部分不会重复生效。

**Step 1: 写失败测试**

`src/jobs/jobs.test.ts`：
- `任务清单与调度时间` 中的期望改为：

```ts
    expect(JOBS.map((j) => [j.name, j.cron])).toEqual([
      ['daily', '10 0 * * *'],
      ['weekly-settlement', '0 2 * * 1'],
      ['frequent', '* * * * *'],
    ]);
```

- `注册：缺失的队列才创建…` 中 `f.created` 与 `f.schedules` 的期望改为，并在 `daily` 断言之后追加 `frequent` 断言：

```ts
    expect(f.created).toEqual(['weekly-settlement', 'frequent']);
    expect(f.schedules).toEqual([
      { name: 'daily', cron: '10 0 * * *', tz: TZ },
      { name: 'weekly-settlement', cron: '0 2 * * 1', tz: TZ },
      { name: 'frequent', cron: '* * * * *', tz: TZ },
    ]);
    expect(await f.handlers.get('daily')?.([])).toEqual({ accrued: 30, ended: 1 });
    expect(await f.handlers.get('frequent')?.([])).toEqual({
      expiredChoices: 0,
      noShows: 0,
      autoCompleted: 0,
      autoConfirmed: 0,
    });
```

`tests/phase2-flow.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import { buyAndPay, call, insertPackage, loginTeacher, loginUser, setup } from './helpers.ts';
import { accruals, serviceRelations } from '../src/db/schema.ts';
import { runDailyJobs } from '../src/jobs/daily.ts';
import { runFrequentJobs } from '../src/jobs/frequent.ts';
import { addMs, HOUR_MS, MINUTE_MS } from '../src/lib/dates.ts';
import { book, getAppointment } from '../src/modules/appointments/service.ts';
import { createLeave } from '../src/modules/leaves/service.ts';
import { setSchedule } from '../src/modules/schedule/service.ts';
import type { DbOrTx } from '../src/db/client.ts';

async function sumBy(db: DbOrTx, teacherId: number): Promise<number> {
  const rows = await db.select().from(accruals);
  return rows.filter((r) => r.teacherId === teacherId).reduce((s, r) => s + r.amountCents, 0);
}

describe('第二阶段', () => {
  test('runFrequentJobs 汇总各分钟级任务', async () => {
    const ctx = await setup();
    const now = ctx.clock.now();
    const t = await loginTeacher(ctx, 't');
    const s = await loginTeacher(ctx, 's');
    const u = await loginUser(ctx, 'u');
    await setSchedule(ctx.db, t.userId, [{ weekday: 1, start: '09:00', end: '12:00' }]);
    const rel = await buyAndPay(ctx, u.userId, await insertPackage(ctx.db, t.userId));
    const a = await book(ctx.db, now, { userId: u.userId, relationId: rel.id, date: '2026-11-02', start: '10:00' });
    await createLeave(ctx.db, now, {
      teacherId: t.userId,
      startDate: '2026-11-10',
      endDate: '2026-11-12',
      candidateIds: [s.userId],
    });

    expect(await runFrequentJobs(ctx.db, addMs(a.startAt, 15 * MINUTE_MS))).toEqual({
      expiredChoices: 0,
      noShows: 1,
      autoCompleted: 0,
      autoConfirmed: 0,
    });
    expect(await runFrequentJobs(ctx.db, addMs(now, 48 * HOUR_MS))).toEqual({
      expiredChoices: 1,
      noShows: 0,
      autoCompleted: 0,
      autoConfirmed: 0,
    });
  });

  test('全链路：排班 → 购买 → 预约 → 请假取消预约 → 选代班 → 与代班通话 → 计提归属', async () => {
    const ctx = await setup();
    const t = await loginTeacher(ctx, 't');
    const s = await loginTeacher(ctx, 's');
    const u = await loginUser(ctx, 'u');
    const as = (who: { token: string }) => ({ token: who.token });

    await call(ctx, 'PUT', '/api/teacher/schedule', { ...as(t), body: { items: [{ weekday: 2, start: '09:00', end: '12:00' }] } });
    await call(ctx, 'PUT', '/api/teacher/schedule', { ...as(s), body: { items: [{ weekday: 2, start: '14:00', end: '16:00' }] } });
    const pkg = (
      await call(ctx, 'POST', '/api/teacher/packages', {
        ...as(t),
        body: { type: 'month', title: '包月', priceCents: 3000, callQuota: 4, replyHours: 12 },
      })
    ).json();
    const order = (await call(ctx, 'POST', '/api/orders', { ...as(u), body: { packageId: pkg.id } })).json();
    await call(ctx, 'POST', '/api/pay/mock/confirm', { query: { out_trade_no: order.outTradeNo } });
    const [rel] = (await call(ctx, 'GET', '/api/relations', as(u))).json();

    const bookAt = (start: string) =>
      call(ctx, 'POST', '/api/appointments', { ...as(u), body: { relationId: rel.id, date: '2026-11-10', start } });
    const first = (await bookAt('10:00')).json();
    expect(first.teacherId).toBe(t.userId);

    const leave = (
      await call(ctx, 'POST', '/api/teacher/leaves', {
        ...as(t),
        body: { startDate: '2026-11-10', endDate: '2026-11-12', candidateIds: [s.userId] },
      })
    ).json();
    expect((await getAppointment(ctx.db, first.id))?.status).toBe('cancelled');
    await call(ctx, 'POST', `/api/teacher/substitute-invites/${leave.id}/respond`, { ...as(s), body: { accept: true } });

    const [choice] = (await call(ctx, 'GET', '/api/leave-choices', as(u))).json();
    await call(ctx, 'POST', `/api/leave-choices/${choice.id}`, {
      ...as(u),
      body: { action: 'substitute', teacherId: s.userId },
    });

    const slots = (
      await call(ctx, 'GET', '/api/appointments/slots', { ...as(u), query: { relationId: rel.id, date: '2026-11-10' } })
    ).json();
    expect(slots.teacherId).toBe(s.userId);
    const second = (await bookAt('14:00')).json();
    expect(second.teacherId).toBe(s.userId);

    const startAt = new Date(second.startAt);
    ctx.clock.set(addMs(startAt, -5 * MINUTE_MS));
    const contacts = (await call(ctx, 'GET', '/api/im/contacts', as(u))).json();
    expect(contacts.map((c: { userId: number }) => c.userId)).toEqual([t.userId, s.userId]);
    expect((await call(ctx, 'POST', `/api/teacher/appointments/${second.id}/join`, as(s))).statusCode).toBe(200);
    expect((await call(ctx, 'POST', `/api/appointments/${second.id}/join`, as(u))).statusCode).toBe(200);

    const done = await runFrequentJobs(ctx.db, addMs(new Date(second.endAt), 30 * MINUTE_MS));
    expect(done.autoCompleted).toBe(1);
    expect((await getAppointment(ctx.db, second.id))?.status).toBe('completed');

    await runDailyJobs(ctx.db, '2026-12-01');
    expect(await sumBy(ctx.db, s.userId)).toBe(300);
    expect(await sumBy(ctx.db, t.userId)).toBe(2700);
    const [r] = await ctx.db.select().from(serviceRelations);
    expect(r).toMatchObject({ callsLeft: 3, status: 'ended', endDate: '2026-11-30' });
  });
});
```

**Step 2: 运行，确认失败**

Run: `pnpm vitest run src/jobs tests/phase2-flow.test.ts`
Expected: FAIL（`../src/jobs/frequent.ts` 不存在；`JOBS` 只有两项）。

**Step 3: 实现**

`src/jobs/frequent.ts`：

```ts
import type { DbOrTx } from '../db/client.ts';
import { autoComplete, autoConfirm, markNoShows } from '../modules/appointments/service.ts';
import { expireChoices } from '../modules/leaves/service.ts';

export interface FrequentResult {
  expiredChoices: number;
  noShows: number;
  autoCompleted: number;
  autoConfirmed: number;
}

/** 分钟级任务：顺序执行，均幂等 */
export async function runFrequentJobs(db: DbOrTx, now: Date): Promise<FrequentResult> {
  const expiredChoices = await expireChoices(db, now);
  const noShows = await markNoShows(db, now);
  const autoCompleted = await autoComplete(db, now);
  const autoConfirmed = await autoConfirm(db, now);
  return { expiredChoices, noShows, autoCompleted, autoConfirmed };
}
```

`src/jobs/index.ts`：
- 加 import：`import { runFrequentJobs } from './frequent.ts';`
- `JOBS` 数组末尾追加：

```ts
  {
    name: 'frequent',
    cron: '* * * * *',
    run: ({ db, clock }) => runFrequentJobs(db, clock.now()),
  },
```

`/README.md` 的「本地开发」列表中，在微信 MOCK 那一条之后追加：

```markdown
- 未配置 `TENCENT_SDKAPPID/TENCENT_SECRETKEY` 时 IM / TRTC 走 MOCK：`userSig` 为 `mock`，调用进入通话接口即记为已进房，由分钟级任务自动完成通话。
```

**Step 4: 全量测试**

Run（项目根）：`pnpm fix && pnpm check`
Expected: 全部通过。第一阶段约 98 个 + 第二阶段 76 个（Task 1~13 依次为 8、2、8、3、9、8、8、3、7、5、6、7、2；Task 13 另修改了 `jobs.test.ts` 的 2 个既有用例）。

**Step 5: 冒烟**

```bash
cd /data/workspace/ngr/wx/LiaoYu/apps/server
PORT=8712 node src/index.ts > /tmp/liaoyu-smoke2.log 2>&1 &
sleep 3
TOKEN=$(curl -s -X POST http://localhost:8712/api/auth/wxlogin -H 'Content-Type: application/json' -d '{"code":"smoke2"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s http://localhost:8712/api/im/usersig -H "Authorization: Bearer $TOKEN"; echo
curl -s http://localhost:8712/api/notifications -H "Authorization: Bearer $TOKEN"; echo
curl -s -X POST http://localhost:8712/api/trtc/callback -H 'Content-Type: application/json' -d '{"EventGroupId":1,"EventType":103,"EventInfo":{"RoomId":999999,"UserId":"u1"}}'; echo
docker compose -f ../../deploy/docker-compose.dev.yml exec -T postgres \
  psql -U liaoyu -d liaoyu -Atc "SELECT name, cron, timezone FROM pgboss.schedule ORDER BY name"
kill %1; wait
grep -E '正在关闭|error' /tmp/liaoyu-smoke2.log
```

Expected:
- `usersig` 返回 `{"mock":true,"sdkAppId":0,...,"userSig":"mock",...}`；通知返回 `[]`；TRTC 回调（开发环境未配置密钥）返回 `{"code":0}`。
- 调度表多出 `frequent|* * * * *|Asia/Shanghai`。
- 日志里有 `正在关闭`，没有 `error`。

**Step 6: Commit**

```bash
cd /data/workspace/ngr/wx/LiaoYu
git add README.md apps/server
git commit -m "feat: 分钟级定时任务与第二阶段全链路测试"
```

---

## 第二阶段完成标准

- 项目根 `pnpm check` 全绿（Biome + tsc + Vitest）。
- MOCK 模式下能走通：老师排班 → 学员购买 → 预约通话 → 老师请假（预约自动取消、学员暂停顺延）→ 候选老师接受 → 学员选代班 → 与代班老师进入通话 → 自动完成 → 日计提中代班日归代班老师。
- 单次套餐：通话完成 → 用户确认或 48 小时自动确认 → 全额计提并进入周结算。
- 配置 `TENCENT_SDKAPPID / TENCENT_SECRETKEY / IM_CALLBACK_TOKEN / TRTC_CALLBACK_KEY` 后：小程序可以用 UserSig 登录 IM、进入 TRTC 房间；IM 发送前回调拦截没有服务关系的消息；TRTC 房间回调驱动通话完成。
- 并发相关用例（同时段并发预约、并发重叠请假、撤销与选择并发、确认与自动确认并发、学员并发提问）全部稳定通过。

## 腾讯云控制台配置（上线前）

- IM：开启「发单聊消息之前」「发单聊消息之后」回调，回调地址 `${PUBLIC_BASE_URL}/api/im/callback`，鉴权 Token = `IM_CALLBACK_TOKEN`。
- TRTC：开启房间事件回调，地址 `${PUBLIC_BASE_URL}/api/trtc/callback`，回调密钥 = `TRTC_CALLBACK_KEY`。
- 两个回调地址都不需要登录态，由签名鉴权；Caddy 不要对其改写请求体（TRTC 按原始字节验签）。

## 已知遗留（后续阶段处理）

- 危机事件 / 私下交易风险的管理端查看与处理记录（第五阶段，表已就绪）。
- 单次通话异议的工单处理（第五阶段）。
- 小程序订阅消息推送（第四阶段，站内通知已就绪）。
- IM 内容安全检测（不做）。
- 撤销请假、改期请假（MVP 不支持）。
- 请假当天或撤销代班当天，已到时间但仍为 `booked` 的通话也会被批量取消；后续可改为只取消尚未开始的预约。
- 聊天权限与联系人按关系逐条读取分段，学员关系很多时需改为一次查询当天分段。
- 爽约次数、通话准时率、回复时效达标率汇入月度等级建议（第五阶段，数据已采集）。
