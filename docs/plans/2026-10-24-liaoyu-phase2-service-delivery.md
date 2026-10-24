# LiaoYu 第二阶段：服务交付 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在第一阶段后端核心之上，实现「排班 → 预约通话（TRTC）→ 单次套餐按通话计提」「请假 → 代班邀请 → 学员选择 / 暂停顺延」「腾讯云 IM 聊天权限、危机词与私下交易提示、回复时效统计」以及站内通知。

**Architecture:** 沿用第一阶段的 Express 单进程 + SQLite 结构，路由工厂 `(db, config) => router`，业务逻辑放 `src/services/*` 并以 `nowMs` 参数注入时间，便于测试。请假与代班全部复用第一阶段的「服务分段」：请假生效时对受影响服务关系插入暂停分段（顺延），学员选定代班后把暂停日改写为代班分段并收回顺延天数，计提逻辑无需改动。腾讯云 IM / TRTC 只做服务端部分：签发 UserSig、接收回调；未配置密钥时进入 MOCK 模式。

**Tech Stack:** Node 20、Express 4、better-sqlite3；Node 内置 `crypto`、`zlib`（UserSig 签名）；测试用 `node:test` + supertest。

**前置：** 第一阶段计划 `docs/plans/2026-10-24-liaoyu-phase1-backend-core.md` 已全部完成且 `npm test` 全绿。

**设计文档：** `docs/plans/2026-10-24-liaoyu-platform-design.md`

---

## 本阶段采用的业务规则

设计文档已定的规则直接沿用（代班计提全归代班老师、请假未选择期间先暂停、请假期间预约自动取消退次数、代班冲突校验、不设代班人数上限）。以下为本计划补充的默认值，集中定义为常量，后续可调：

| 项 | 规则 |
|---|---|
| 排班 | 老师按「星期几 + 时段」设置每周可约时间，整体覆盖保存 |
| 通话时长 | 固定 60 分钟，起始时间按 30 分钟粒度 |
| 可预约窗口 | 开始时间距现在 ≥ 1 小时，最远 14 天内 |
| 预约归属 | 预约日所在分段的负责老师（代班日即代班老师）；暂停日不可约 |
| 用户取消 | 开始前 ≥ 12 小时可取消并退还次数；之后不可取消 |
| 老师取消 | 开始前均可取消，退还次数并通知用户 |
| 进入通话 | 开始前 10 分钟至结束时间之间 |
| 老师爽约 | 开始 15 分钟后老师仍未进房 → `teacher_no_show`，退还次数 |
| 自动完成 | 老师进过房，结束时间后 30 分钟仍未收到解散房间回调 → 自动完成 |
| 单次套餐计提 | 通话完成后用户确认或 48 小时无异议 → 全额计给上课老师，服务关系结束；有异议不计提（第五阶段工单处理） |
| 请假 | 起始日不早于今天，最长 60 天；同一老师请假不可重叠；MVP 不支持撤销请假 |
| 学员选择期限 | 每条受影响服务关系自通知起 48 小时 |
| 撤销代班 | 原老师可撤销已同意的代班老师；已选该老师的学员分段改回暂停、相关预约取消，并重新获得 48 小时选择期 |
| 顺延与续费 | 只顺延受影响的那条服务关系；若与已购的续费服务重叠，二者各自计提，互不调整 |
| 聊天权限 | 学员 ↔ 原老师（存在有效服务关系）；学员 ↔ 代班老师（仅当天处于其代班分段） |
| 危机词 / 私下交易 | 命中后放行消息并记录事件；向发送者发站内提示（危机给热线），危机另通知对方 |
| 回复时效 | 学员发消息后开始计时，老师回复即结束；超过套餐承诺小时数为未达标 |
| 通知 | 站内通知表 `notifications`；小程序订阅消息推送放第四阶段 |
| 内容安全检测 | 本阶段不做 |

---

## 约定

- 与第一阶段相同：后端目录 `/data/workspace/ngr/wx/LiaoYu/server`，下文路径均相对 `server/`。
- 运行单个测试：`cd /data/workspace/ngr/wx/LiaoYu/server && node --test tests/<file>.test.js`
- 测试固定时钟：`2026-11-01T04:00:00Z`（北京时间 2026-11-01 **周日** 12:00）。2026-11-02 为周一，2026-11-10 为周二。
- 需要推进时钟的 HTTP 测试直接改 `ctx.config.now = () => ms`（路由每次请求都读 `config.now()`）。
- 时间点一律存毫秒整数（`*_ms`），日期存 `YYYY-MM-DD`（北京时间）。
- 每个 Task 结束提交一次 git。

## 文件总览

| 文件 | 职责 |
|---|---|
| `src/lib/teacher.js` | `requireActiveTeacher(db, userId)` 公共校验 |
| `src/lib/notify.js` | 写站内通知 |
| `src/lib/keywords.js` | 危机词 / 私下交易关键词扫描 |
| `src/services/schedule.js` | 周排班解析与读写 |
| `src/services/appointments.js` | 可约时段、预约、取消、进房/完成、爽约与确认任务、单次计提 |
| `src/services/leaves.js` | 请假、代班邀请、学员选择、撤销代班、选择过期 |
| `src/services/chat.js` | 聊天权限判定、消息关键词处理 |
| `src/services/replies.js` | 回复时效记录与统计 |
| `src/tencent/usersig.js` | UserSig 签发、IM 账号映射 |
| `src/tencent/callback-auth.js` | IM / TRTC 回调鉴权 |
| `src/routes/notifications.js` | `/api/notifications` |
| `src/routes/appointments.js` | `/api/appointments` |
| `src/routes/leave-choices.js` | `/api/leave-choices` |
| `src/routes/im.js` | `/api/im` |
| `src/routes/trtc.js` | `/api/trtc` |

---

### Task 1: 第二阶段 schema、配置与公共工具

**Files:**
- Modify: `server/src/schema.sql`（末尾追加）
- Modify: `server/src/config.js`
- Modify: `server/src/lib/dates.js`
- Create: `server/src/lib/teacher.js`
- Create: `server/src/lib/notify.js`
- Modify: `server/src/routes/teacher.js`（改用公共 `requireActiveTeacher`）
- Modify: `server/tests/helpers.js`
- Test: `server/tests/phase2-base.test.js`

**Step 1: 写失败测试**

`server/tests/phase2-base.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { cnMs, weekdayOf, hhmmToMin, minToHhmm, isDate } = require('../src/lib/dates');
const { requireActiveTeacher } = require('../src/lib/teacher');
const { insertUser, insertTeacher } = require('./helpers');

test('第二阶段新表齐全', () => {
  const db = openDb(':memory:');
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of ['notifications', 'schedules', 'appointments', 'leaves', 'substitute_candidates',
    'leave_choices', 'crisis_events', 'risk_events', 'reply_waits']) {
    assert.ok(names.includes(t), `缺少表 ${t}`);
  }
});

test('第二阶段日期工具', () => {
  assert.strictEqual(cnMs('2026-11-01', 720), Date.parse('2026-11-01T04:00:00Z'));
  assert.strictEqual(weekdayOf('2026-11-01'), 0);
  assert.strictEqual(weekdayOf('2026-11-02'), 1);
  assert.strictEqual(hhmmToMin('09:30'), 570);
  assert.strictEqual(hhmmToMin('24:00'), 1440);
  assert.ok(Number.isNaN(hhmmToMin('9:30')));
  assert.ok(Number.isNaN(hhmmToMin('10:60')));
  assert.ok(Number.isNaN(hhmmToMin('24:30')));
  assert.strictEqual(minToHhmm(570), '09:30');
  assert.strictEqual(isDate('2026-11-01'), true);
  assert.strictEqual(isDate('2026-02-30'), false);
  assert.strictEqual(isDate('20261101'), false);
});

test('requireActiveTeacher 只放行已认证老师', () => {
  const db = openDb(':memory:');
  const u = insertUser(db, 'u');
  const t = insertTeacher(db, 't', { level: 3 });
  const p = insertTeacher(db, 'p', { status: 'pending' });
  assert.throws(() => requireActiveTeacher(db, u), /仅已认证老师/);
  assert.throws(() => requireActiveTeacher(db, p), /仅已认证老师/);
  assert.strictEqual(requireActiveTeacher(db, t).level, 3);
});
```

**Step 2: 运行，确认失败**

Run: `node --test tests/phase2-base.test.js`
Expected: FAIL（缺表 / 函数未导出 / 模块不存在）

**Step 3: 实现**

`server/src/schema.sql` 末尾追加：

```sql
-- ===== 第二阶段：服务交付 =====
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);

CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL,
  CHECK (start_min >= 0 AND end_min <= 1440 AND start_min < end_min)
);
CREATE INDEX IF NOT EXISTS idx_sched_teacher ON schedules(teacher_id, weekday);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  relation_id INTEGER NOT NULL REFERENCES service_relations(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','completed','cancelled','teacher_no_show')),
  cancel_by TEXT CHECK (cancel_by IN ('user','teacher','leave')),
  teacher_joined_ms INTEGER,
  user_joined_ms INTEGER,
  ended_ms INTEGER,
  confirm_status TEXT CHECK (confirm_status IN ('pending','confirmed','disputed','auto')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_appt_teacher ON appointments(teacher_id, date);
CREATE INDEX IF NOT EXISTS idx_appt_relation ON appointments(relation_id);

CREATE TABLE IF NOT EXISTS leaves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leaves_teacher ON leaves(teacher_id, start_date);

CREATE TABLE IF NOT EXISTS substitute_candidates (
  leave_id INTEGER NOT NULL REFERENCES leaves(id),
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','accepted','rejected','revoked')),
  responded_at TEXT,
  PRIMARY KEY (leave_id, teacher_id)
);

CREATE TABLE IF NOT EXISTS leave_choices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  leave_id INTEGER NOT NULL REFERENCES leaves(id),
  relation_id INTEGER NOT NULL REFERENCES service_relations(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','substitute','wait','expired')),
  substitute_teacher_id INTEGER REFERENCES users(id),
  deadline_ms INTEGER NOT NULL,
  decided_at TEXT,
  UNIQUE (leave_id, relation_id)
);

CREATE TABLE IF NOT EXISTS crisis_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  peer_id INTEGER NOT NULL REFERENCES users(id),
  keyword TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','handled')),
  handled_by INTEGER,
  handled_note TEXT,
  handled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS risk_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user_id INTEGER NOT NULL REFERENCES users(id),
  to_user_id INTEGER NOT NULL REFERENCES users(id),
  keyword TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reply_waits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  relation_id INTEGER NOT NULL REFERENCES service_relations(id),
  reply_hours INTEGER NOT NULL,
  asked_ms INTEGER NOT NULL,
  replied_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reply_teacher ON reply_waits(teacher_id, asked_ms);
```

`server/src/config.js` 在 `wx: {...},` 之后加入：

```js
    tencent: {
      sdkAppId: Number(env.TENCENT_SDKAPPID || 0),
      secretKey: env.TENCENT_SECRETKEY || '',
      imCallbackToken: env.IM_CALLBACK_TOKEN || '',
      trtcCallbackKey: env.TRTC_CALLBACK_KEY || '',
    },
    crisisHotline: env.CRISIS_HOTLINE || '12356',
```

`server/src/lib/dates.js` 在 `module.exports` 之前加入，并把导出改为
`module.exports = { addDays, diffDays, eachDay, todayCN, isDate, cnMs, weekdayOf, hhmmToMin, minToHhmm };`：

```js
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && fmt(parse(s)) === s;

// 北京时间某日 + 分钟数 → 毫秒时间戳
const cnMs = (date, minutes = 0) => parse(date) + minutes * 60000 - 8 * 3600 * 1000;

const weekdayOf = (date) => new Date(parse(date)).getUTCDay();

function hhmmToMin(s) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(s));
  if (!m) return NaN;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (mi > 59 || h > 24 || (h === 24 && mi > 0)) return NaN;
  return h * 60 + mi;
}

const minToHhmm = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
```

`server/src/lib/teacher.js`：

```js
const { HttpError } = require('./errors');

function requireActiveTeacher(db, userId) {
  const t = db.prepare('SELECT user_id, level, status FROM teacher_profiles WHERE user_id = ?').get(userId);
  if (!t || t.status !== 'active') throw new HttpError(403, '仅已认证老师可操作');
  return t;
}

module.exports = { requireActiveTeacher };
```

`server/src/lib/notify.js`：

```js
function notify(db, userId, type, payload = {}) {
  db.prepare('INSERT INTO notifications (user_id, type, payload) VALUES (?, ?, ?)')
    .run(userId, type, JSON.stringify(payload));
}

module.exports = { notify };
```

`server/src/routes/teacher.js`：顶部加入

```js
const { requireActiveTeacher: requireTeacher } = require('../lib/teacher');
```

并把第一阶段的内联函数

```js
  function requireActiveTeacher(req) {
    const t = db.prepare('SELECT level, status FROM teacher_profiles WHERE user_id = ?').get(req.userId);
    if (!t || t.status !== 'active') throw new HttpError(403, '仅已认证老师可操作');
    return t;
  }
```

替换为：

```js
  const requireActiveTeacher = (req) => requireTeacher(db, req.userId);
```

`server/tests/helpers.js`：在 `module.exports` 之前加入，并把 `bearer, loginTeacher, loginAs, HOUR` 加进导出：

```js
const HOUR = 3600 * 1000;
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

async function loginAs(ctx, code) {
  const u = await loginUser(ctx, code);
  return { ...u, auth: bearer(u.token) };
}

async function loginTeacher(ctx, code, opts) {
  const u = await loginAs(ctx, code);
  makeTeacherProfile(ctx.db, u.userId, opts);
  return u;
}
```

**Step 4: 运行，确认通过**

Run: `node --test tests/phase2-base.test.js && npm test`
Expected: 新测试 3 个 PASS；第一阶段全部用例仍 PASS（`teacher.js` 重构不改变行为）。

**Step 5: Commit**

```bash
git add server/src server/tests
git commit -m "feat: 第二阶段 schema、腾讯云配置与公共工具"
```

---

### Task 2: 站内通知接口

**Files:**
- Create: `server/src/routes/notifications.js`
- Modify: `server/src/app.js`（挂载 `/api/notifications`）
- Test: `server/tests/notifications.test.js`

**Step 1: 写失败测试**

```js
const test = require('node:test');
const assert = require('node:assert');
const { setup, loginAs } = require('./helpers');
const { notify } = require('../src/lib/notify');

test('通知列表、未读筛选与标记已读，只影响本人', async () => {
  const ctx = setup();
  const u = await loginAs(ctx, 'u');
  const other = await loginAs(ctx, 'o');
  notify(ctx.db, u.userId, 'a', { x: 1 });
  notify(ctx.db, u.userId, 'b');
  notify(ctx.db, other.userId, 'c');

  const all = await ctx.api.get('/api/notifications').set(u.auth);
  assert.deepStrictEqual(all.body.map((n) => n.type), ['b', 'a']);
  assert.deepStrictEqual(all.body[1].payload, { x: 1 });

  await ctx.api.post('/api/notifications/read').set(u.auth).send({ ids: [all.body[1].id] });
  const unread = await ctx.api.get('/api/notifications').query({ unread: 1 }).set(u.auth);
  assert.deepStrictEqual(unread.body.map((n) => n.type), ['b']);

  await ctx.api.post('/api/notifications/read').set(u.auth).send({});
  assert.deepStrictEqual((await ctx.api.get('/api/notifications').query({ unread: 1 }).set(u.auth)).body, []);
  assert.strictEqual(ctx.db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND is_read = 0').get(other.userId).c, 1);
});

test('未登录 401', async () => {
  const ctx = setup();
  assert.strictEqual((await ctx.api.get('/api/notifications')).status, 401);
});
```

**Step 2: 运行，确认失败**

Run: `node --test tests/notifications.test.js`
Expected: FAIL（404）

**Step 3: 实现**

`server/src/routes/notifications.js`：

```js
const express = require('express');
const { userAuth } = require('../middleware/auth');

module.exports = (db, config) => {
  const router = express.Router();
  router.use(userAuth(config));

  router.get('/', (req, res) => {
    const unreadOnly = String(req.query.unread || '') === '1';
    const rows = db.prepare(`SELECT * FROM notifications WHERE user_id = ? ${unreadOnly ? 'AND is_read = 0' : ''}
                             ORDER BY id DESC LIMIT 100`).all(req.userId);
    res.json(rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) })));
  });

  router.post('/read', (req, res) => {
    const ids = req.body && Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
    if (ids.length) {
      db.prepare(`UPDATE notifications SET is_read = 1 WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`)
        .run(req.userId, ...ids);
    } else {
      db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.userId);
    }
    res.json({ ok: true });
  });

  return router;
};
```

`server/src/app.js` 挂载：

```js
  app.use('/api/notifications', require('./routes/notifications')(db, config));
```

**Step 4: 运行，确认通过**

Run: `node --test tests/notifications.test.js`
Expected: PASS（2 tests）

**Step 5: Commit**

```bash
git add server/src server/tests/notifications.test.js
git commit -m "feat: 站内通知接口"
```

---

### Task 3: 分段改写纯函数（请假暂停、暂停↔代班）

**Files:**
- Modify: `server/src/services/segments.js`
- Test: `server/tests/segments-leave.test.js`

**思路：** 服务关系的「有效天数」（非暂停天数）是不变量。请假相关的改写只改动请假窗口内的日期类型，**不平移窗口外的分段**（否则同一关系上其他请假的代班分段会错位），然后用 `fitSpan` 在尾部裁掉或补齐原老师的正常日，使有效天数恢复原值。尾部补齐时遇到原老师的请假日（`blocked`）补暂停日而不是正常日。

第一阶段的 `applyPause`（整体后移）保留不动，请假业务改用本 Task 的 `pauseRange`。

**Step 1: 写失败测试**

```js
const test = require('node:test');
const assert = require('node:assert');
const {
  initialSegments, applyPause, applySubstitute, pauseRange, substituteFromPause, pauseFromSubstitute,
} = require('../src/services/segments');

const inRange = (from, to) => (d) => d >= from && d <= to;
const LEAVE = { from: '2026-11-10', to: '2026-11-14', ownerId: 1, blocked: inRange('2026-11-10', '2026-11-14') };
const paused = () => pauseRange(initialSegments(1, '2026-11-01', '2026-11-30'), LEAVE);

test('pauseRange：窗口内正常日改暂停并顺延，结果与 applyPause 一致', () => {
  assert.deepStrictEqual(paused(), [
    { kind: 'normal', teacher_id: 1, start_date: '2026-11-01', end_date: '2026-11-09' },
    { kind: 'paused', teacher_id: null, start_date: '2026-11-10', end_date: '2026-11-14' },
    { kind: 'normal', teacher_id: 1, start_date: '2026-11-15', end_date: '2026-12-05' },
  ]);
  assert.deepStrictEqual(paused(), applyPause(initialSegments(1, '2026-11-01', '2026-11-30'), { from: '2026-11-10', to: '2026-11-14' }));
});

test('pauseRange：服务在请假期间到期，顺延日跳过请假日', () => {
  assert.deepStrictEqual(pauseRange(initialSegments(1, '2026-11-01', '2026-11-12'), LEAVE), [
    { kind: 'normal', teacher_id: 1, start_date: '2026-11-01', end_date: '2026-11-09' },
    { kind: 'paused', teacher_id: null, start_date: '2026-11-10', end_date: '2026-11-14' },
    { kind: 'normal', teacher_id: 1, start_date: '2026-11-15', end_date: '2026-11-17' },
  ]);
});

test('pauseRange：不移动窗口外已有的代班分段', () => {
  const base = applySubstitute(initialSegments(1, '2026-11-01', '2026-11-30'), { from: '2026-11-20', to: '2026-11-21', teacherId: 3 });
  assert.deepStrictEqual(pauseRange(base, { from: '2026-11-10', to: '2026-11-12', ownerId: 1 }), [
    { kind: 'normal', teacher_id: 1, start_date: '2026-11-01', end_date: '2026-11-09' },
    { kind: 'paused', teacher_id: null, start_date: '2026-11-10', end_date: '2026-11-12' },
    { kind: 'normal', teacher_id: 1, start_date: '2026-11-13', end_date: '2026-11-19' },
    { kind: 'substitute', teacher_id: 3, start_date: '2026-11-20', end_date: '2026-11-21' },
    { kind: 'normal', teacher_id: 1, start_date: '2026-11-22', end_date: '2026-12-03' },
  ]);
});

test('暂停日部分改为代班，收回等量顺延天数', () => {
  const segs = substituteFromPause(paused(), { ...LEAVE, from: '2026-11-12', teacherId: 2 });
  assert.deepStrictEqual(segs, [
    { kind: 'normal', teacher_id: 1, start_date: '2026-11-01', end_date: '2026-11-09' },
    { kind: 'paused', teacher_id: null, start_date: '2026-11-10', end_date: '2026-11-11' },
    { kind: 'substitute', teacher_id: 2, start_date: '2026-11-12', end_date: '2026-11-14' },
    { kind: 'normal', teacher_id: 1, start_date: '2026-11-15', end_date: '2026-12-02' },
  ]);
});

test('服务在请假期间到期：改为代班后结束日恢复原值', () => {
  const segs0 = pauseRange(initialSegments(1, '2026-11-01', '2026-11-12'), LEAVE);
  assert.deepStrictEqual(substituteFromPause(segs0, { ...LEAVE, teacherId: 2 }), [
    { kind: 'normal', teacher_id: 1, start_date: '2026-11-01', end_date: '2026-11-09' },
    { kind: 'substitute', teacher_id: 2, start_date: '2026-11-10', end_date: '2026-11-12' },
  ]);
});

test('代班改回暂停：与直接暂停结果一致', () => {
  const sub = substituteFromPause(paused(), { ...LEAVE, teacherId: 2 });
  assert.deepStrictEqual(pauseFromSubstitute(sub, { ...LEAVE, teacherId: 2 }), paused());

  const short0 = pauseRange(initialSegments(1, '2026-11-01', '2026-11-12'), LEAVE);
  const short = substituteFromPause(short0, { ...LEAVE, teacherId: 2 });
  assert.deepStrictEqual(pauseFromSubstitute(short, { ...LEAVE, teacherId: 2 }), short0);
});

test('只改写指定代班老师的分段', () => {
  const base = applySubstitute(initialSegments(1, '2026-11-01', '2026-11-30'), { from: '2026-11-10', to: '2026-11-10', teacherId: 3 });
  assert.deepStrictEqual(pauseFromSubstitute(base, { from: '2026-11-01', to: '2026-11-30', teacherId: 2, ownerId: 1 }), base);
});
```

**Step 2: 运行，确认失败**

Run: `node --test tests/segments-leave.test.js`
Expected: FAIL（函数未导出）

**Step 3: 实现**

`server/src/services/segments.js` 在 `module.exports` 之前加入：

```js
const NEVER = () => false;
const inRange = (from, to) => (d) => d >= from && d <= to;

// 调整尾部，使非暂停天数恢复为 span：多了从尾部裁掉；少了在尾部补原老师正常日（遇 blocked 日补暂停日）
function fitSpan(days, span, ownerId, blocked) {
  const out = days.slice();
  let active = out.filter((d) => d.kind !== 'paused').length;
  while (active > span) {
    if (out.pop().kind !== 'paused') active -= 1;
  }
  while (active < span) {
    const date = addDays(out[out.length - 1].date, 1);
    if (blocked(date)) {
      out.push({ date, kind: 'paused', teacher_id: null });
    } else {
      out.push({ date, kind: 'normal', teacher_id: ownerId });
      active += 1;
    }
  }
  while (out.length && out[out.length - 1].kind === 'paused') out.pop();
  return out;
}

function remap(segments, { from, to, match, into, ownerId, blocked = NEVER }) {
  const days = expand(segments);
  const span = days.filter((d) => d.kind !== 'paused').length;
  const mapped = days.map((d) => (d.date >= from && d.date <= to && match(d) ? { ...d, ...into } : d));
  return compress(fitSpan(mapped, span, ownerId, blocked));
}

const pauseRange = (segments, { from, to, ownerId, blocked }) => remap(segments, {
  from, to, ownerId,
  blocked: blocked || inRange(from, to),
  match: (d) => d.kind === 'normal' && d.teacher_id === ownerId,
  into: { kind: 'paused', teacher_id: null },
});

const substituteFromPause = (segments, { from, to, teacherId, ownerId, blocked }) => remap(segments, {
  from, to, ownerId, blocked,
  match: (d) => d.kind === 'paused',
  into: { kind: 'substitute', teacher_id: teacherId },
});

const pauseFromSubstitute = (segments, { from, to, teacherId, ownerId, blocked }) => remap(segments, {
  from, to, ownerId, blocked,
  match: (d) => d.kind === 'substitute' && d.teacher_id === teacherId,
  into: { kind: 'paused', teacher_id: null },
});
```

导出改为：

```js
module.exports = {
  initialSegments, applySubstitute, applyPause, segmentOn, activeDayIndex,
  pauseRange, substituteFromPause, pauseFromSubstitute,
};
```

**Step 4: 运行，确认通过**

Run: `node --test tests/segments-leave.test.js tests/segments.test.js`
Expected: PASS（新 7 + 旧 4）

**Step 5: Commit**

```bash
git add server/src/services/segments.js server/tests/segments-leave.test.js
git commit -m "feat: 请假分段改写纯函数（窗口暂停、暂停↔代班）"
```

---

### Task 4: 老师周排班

**Files:**
- Create: `server/src/services/schedule.js`
- Modify: `server/src/routes/teacher.js`
- Test: `server/tests/schedule.test.js`

**Step 1: 写失败测试**

```js
const test = require('node:test');
const assert = require('node:assert');
const { setup, loginTeacher, loginAs } = require('./helpers');

const put = (ctx, auth, items) => ctx.api.put('/api/teacher/schedule').set(auth).send({ items });

test('设置并读取周排班；重新设置会整体覆盖', async () => {
  const ctx = setup();
  const t = await loginTeacher(ctx, 't1');
  const items = [{ weekday: 1, start: '09:00', end: '12:00' }, { weekday: 1, start: '14:00', end: '16:30' }];
  assert.strictEqual((await put(ctx, t.auth, items)).status, 200);
  assert.deepStrictEqual((await ctx.api.get('/api/teacher/schedule').set(t.auth)).body, items);

  await put(ctx, t.auth, [{ weekday: 3, start: '19:00', end: '21:00' }]);
  assert.deepStrictEqual((await ctx.api.get('/api/teacher/schedule').set(t.auth)).body,
    [{ weekday: 3, start: '19:00', end: '21:00' }]);
});

test('时段非法或重叠返回 400', async () => {
  const ctx = setup();
  const t = await loginTeacher(ctx, 't1');
  assert.strictEqual((await put(ctx, t.auth, [{ weekday: 7, start: '09:00', end: '10:00' }])).status, 400);
  assert.strictEqual((await put(ctx, t.auth, [{ weekday: 1, start: '10:00', end: '09:00' }])).status, 400);
  assert.strictEqual((await put(ctx, t.auth, [{ weekday: 1, start: '9:00', end: '10:00' }])).status, 400);
  assert.strictEqual((await put(ctx, t.auth, [
    { weekday: 1, start: '09:00', end: '11:00' }, { weekday: 1, start: '10:00', end: '12:00' },
  ])).status, 400);
  assert.strictEqual((await ctx.api.put('/api/teacher/schedule').set(t.auth).send({})).status, 400);
});

test('非老师 403', async () => {
  const ctx = setup();
  const u = await loginAs(ctx, 'u1');
  assert.strictEqual((await put(ctx, u.auth, [])).status, 403);
});
```

**Step 2: 运行，确认失败**

Run: `node --test tests/schedule.test.js`
Expected: FAIL

**Step 3: 实现**

`server/src/services/schedule.js`：

```js
const { HttpError } = require('../lib/errors');
const { hhmmToMin, minToHhmm } = require('../lib/dates');

function parseSchedule(items) {
  if (!Array.isArray(items)) throw new HttpError(400, '排班格式错误');
  const rows = items.map((it) => {
    const weekday = it && it.weekday;
    const s = hhmmToMin(it && it.start);
    const e = hhmmToMin(it && it.end);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 || !(s < e)) throw new HttpError(400, '排班时段非法');
    return { weekday, start_min: s, end_min: e };
  });
  rows.sort((a, b) => a.weekday - b.weekday || a.start_min - b.start_min);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].weekday === rows[i - 1].weekday && rows[i].start_min < rows[i - 1].end_min) {
      throw new HttpError(400, '排班时段重叠');
    }
  }
  return rows;
}

function setSchedule(db, teacherId, items) {
  const rows = parseSchedule(items);
  db.transaction(() => {
    db.prepare('DELETE FROM schedules WHERE teacher_id = ?').run(teacherId);
    const ins = db.prepare('INSERT INTO schedules (teacher_id, weekday, start_min, end_min) VALUES (?, ?, ?, ?)');
    for (const r of rows) ins.run(teacherId, r.weekday, r.start_min, r.end_min);
  })();
}

function getSchedule(db, teacherId) {
  return db.prepare('SELECT weekday, start_min, end_min FROM schedules WHERE teacher_id = ? ORDER BY weekday, start_min')
    .all(teacherId)
    .map((r) => ({ weekday: r.weekday, start: minToHhmm(r.start_min), end: minToHhmm(r.end_min) }));
}

module.exports = { parseSchedule, setSchedule, getSchedule };
```

`server/src/routes/teacher.js` 顶部加：

```js
const { setSchedule, getSchedule } = require('../services/schedule');
```

在老师工作台接口区追加：

```js
  router.get('/schedule', (req, res) => {
    requireActiveTeacher(req);
    res.json(getSchedule(db, req.userId));
  });

  router.put('/schedule', (req, res) => {
    requireActiveTeacher(req);
    setSchedule(db, req.userId, req.body && req.body.items);
    res.json(getSchedule(db, req.userId));
  });
```

**Step 4: 运行，确认通过**

Run: `node --test tests/schedule.test.js`
Expected: PASS（3 tests）

**Step 5: Commit**

```bash
git add server/src server/tests/schedule.test.js
git commit -m "feat: 老师周排班"
```

---

### Task 5: 可约时段、预约与取消

**Files:**
- Create: `server/src/services/appointments.js`
- Create: `server/src/routes/appointments.js`
- Modify: `server/src/routes/teacher.js`（老师预约列表、取消）
- Modify: `server/src/app.js`（挂载 `/api/appointments`）
- Test: `server/tests/appointments.test.js`

**规则：** 见文首规则表「通话时长 / 可预约窗口 / 预约归属 / 用户取消 / 老师取消」。老师请假日没有可约时段（`leaves` 表在 Task 1 已建，请假业务在 Task 6）。

**Step 1: 写失败测试**

```js
const test = require('node:test');
const assert = require('node:assert');
const { setup, loginTeacher, loginAs, insertPackage, buyAndPay, FIXED_NOW, HOUR } = require('./helpers');
const { setSchedule } = require('../src/services/schedule');
const { cancelByUser } = require('../src/services/appointments');
const { loadSegments, saveSegments } = require('../src/services/relations');
const { applyPause, applySubstitute } = require('../src/services/segments');

const MON = '2026-11-02';

async function world() {
  const ctx = setup();
  const t = await loginTeacher(ctx, 't1');
  const sub = await loginTeacher(ctx, 't2');
  const u = await loginAs(ctx, 'u1');
  setSchedule(ctx.db, t.userId, [{ weekday: 1, start: '09:00', end: '12:00' }]);
  setSchedule(ctx.db, sub.userId, [{ weekday: 1, start: '14:00', end: '16:00' }]);
  const rel = buyAndPay(ctx, u.userId, insertPackage(ctx.db, t.userId));
  return { ctx, db: ctx.db, t, sub, u, rel };
}
const slots = (w) => w.ctx.api.get('/api/appointments/slots').query({ relationId: w.rel.id, date: MON }).set(w.u.auth);
const book = (w, start, date = MON) => w.ctx.api.post('/api/appointments').set(w.u.auth)
  .send({ relationId: w.rel.id, date, start });
const callsLeft = (w) => w.db.prepare('SELECT calls_left FROM service_relations WHERE id = ?').get(w.rel.id).calls_left;

test('按负责老师排班返回可约时段', async () => {
  const w = await world();
  const res = await slots(w);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.teacherId, w.t.userId);
  assert.deepStrictEqual(res.body.slots, ['09:00', '09:30', '10:00', '10:30', '11:00']);
});

test('预约成功：扣次数、占用时段、通知老师', async () => {
  const w = await world();
  const r = await book(w, '10:00');
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.teacher_id, w.t.userId);
  assert.strictEqual(r.body.start_ms, Date.parse('2026-11-02T02:00:00Z'));
  assert.strictEqual(r.body.end_ms, Date.parse('2026-11-02T03:00:00Z'));
  assert.strictEqual(callsLeft(w), 3);
  assert.deepStrictEqual((await slots(w)).body.slots, ['09:00', '11:00']);
  const n = w.db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND type = 'appointment_booked'").get(w.t.userId);
  assert.strictEqual(n.c, 1);
});

test('不可约时段 409、服务期外 400、次数用完 409', async () => {
  const w = await world();
  assert.strictEqual((await book(w, '08:00')).status, 409);
  assert.strictEqual((await book(w, '09:00', '2026-12-07')).status, 400);
  w.db.prepare('UPDATE service_relations SET calls_left = 0').run();
  assert.strictEqual((await book(w, '09:00')).status, 409);
});

test('暂停日不可约', async () => {
  const w = await world();
  saveSegments(w.db, w.rel.id, applyPause(loadSegments(w.db, w.rel.id), { from: MON, to: MON }));
  assert.deepStrictEqual((await slots(w)).body, { teacherId: null, slots: [] });
  assert.strictEqual((await book(w, '09:00')).status, 409);
});

test('代班日按代班老师排班，预约归代班老师', async () => {
  const w = await world();
  saveSegments(w.db, w.rel.id, applySubstitute(loadSegments(w.db, w.rel.id), { from: MON, to: MON, teacherId: w.sub.userId }));
  const s = await slots(w);
  assert.strictEqual(s.body.teacherId, w.sub.userId);
  assert.deepStrictEqual(s.body.slots, ['14:00', '14:30', '15:00']);
  assert.strictEqual((await book(w, '14:00')).body.teacher_id, w.sub.userId);
});

test('用户取消：开始前 12 小时以上可取消并退次数，之后不可', async () => {
  const w = await world();
  const a = (await book(w, '10:00')).body;
  assert.throws(() => cancelByUser(w.db, { userId: w.u.userId, id: a.id, nowMs: a.start_ms - 11 * HOUR }), /12 小时/);
  const ok = await w.ctx.api.post(`/api/appointments/${a.id}/cancel`).set(w.u.auth);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.status, 'cancelled');
  assert.strictEqual(ok.body.cancel_by, 'user');
  assert.strictEqual(callsLeft(w), 4);
});

test('老师取消：退次数并通知用户；不能取消别人的预约', async () => {
  const w = await world();
  const a = (await book(w, '10:00')).body;
  assert.strictEqual((await w.ctx.api.post(`/api/teacher/appointments/${a.id}/cancel`).set(w.sub.auth)).status, 404);
  const r = await w.ctx.api.post(`/api/teacher/appointments/${a.id}/cancel`).set(w.t.auth);
  assert.strictEqual(r.body.cancel_by, 'teacher');
  assert.strictEqual(callsLeft(w), 4);
  const n = w.db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND type = 'appointment_cancelled'").get(w.u.userId);
  assert.strictEqual(n.c, 1);
});

test('老师请假日无可约时段；用户与老师都能看到预约列表', async () => {
  const w = await world();
  await book(w, '10:00');
  assert.strictEqual((await w.ctx.api.get('/api/appointments').set(w.u.auth)).body.length, 1);
  const tl = await w.ctx.api.get('/api/teacher/appointments').set(w.t.auth);
  assert.strictEqual(tl.body.length, 1);
  w.db.prepare('INSERT INTO leaves (teacher_id, start_date, end_date, created_ms) VALUES (?, ?, ?, ?)')
    .run(w.t.userId, MON, MON, FIXED_NOW);
  assert.deepStrictEqual((await slots(w)).body.slots, []);
});
```

**Step 2: 运行，确认失败**

Run: `node --test tests/appointments.test.js`
Expected: FAIL

**Step 3: 实现**

`server/src/services/appointments.js`：

```js
const { HttpError } = require('../lib/errors');
const { addDays, todayCN, isDate, cnMs, weekdayOf, hhmmToMin, minToHhmm } = require('../lib/dates');
const { notify } = require('../lib/notify');
const { loadSegments } = require('./relations');
const { segmentOn } = require('./segments');

const MIN = 60000;
const CALL_MINUTES = 60;
const SLOT_STEP = 30;
const LEAD_MINUTES = 60;
const WINDOW_DAYS = 14;
const USER_CANCEL_HOURS = 12;

const getAppointment = (db, id) => db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);

function teacherOnLeave(db, teacherId, date) {
  return !!db.prepare('SELECT 1 FROM leaves WHERE teacher_id = ? AND start_date <= ? AND end_date >= ?')
    .get(teacherId, date, date);
}

function availableSlots(db, teacherId, date, nowMs) {
  const today = todayCN(nowMs);
  if (date < today || date > addDays(today, WINDOW_DAYS) || teacherOnLeave(db, teacherId, date)) return [];
  const windows = db.prepare('SELECT start_min, end_min FROM schedules WHERE teacher_id = ? AND weekday = ? ORDER BY start_min')
    .all(teacherId, weekdayOf(date));
  const busy = db.prepare("SELECT start_ms, end_ms FROM appointments WHERE teacher_id = ? AND date = ? AND status = 'booked'")
    .all(teacherId, date);
  const out = [];
  for (const w of windows) {
    for (let m = Math.ceil(w.start_min / SLOT_STEP) * SLOT_STEP; m + CALL_MINUTES <= w.end_min; m += SLOT_STEP) {
      const s = cnMs(date, m);
      const e = s + CALL_MINUTES * MIN;
      if (s < nowMs + LEAD_MINUTES * MIN) continue;
      if (busy.some((b) => b.start_ms < e && s < b.end_ms)) continue;
      out.push(minToHhmm(m));
    }
  }
  return out;
}

function responsibleTeacher(db, relationId, date) {
  const seg = segmentOn(loadSegments(db, relationId), date);
  return seg && seg.kind !== 'paused' ? seg.teacher_id : null;
}

function getUserRelation(db, relationId, userId) {
  const rel = db.prepare('SELECT * FROM service_relations WHERE id = ? AND user_id = ?').get(relationId, userId);
  if (!rel) throw new HttpError(404, '服务不存在');
  return rel;
}

function slotsForRelation(db, { userId, relationId, date, nowMs }) {
  const rel = getUserRelation(db, relationId, userId);
  if (!isDate(date)) throw new HttpError(400, '日期格式错误');
  if (rel.status !== 'active' || rel.frozen || date < rel.start_date || date > rel.end_date) {
    return { teacherId: null, slots: [] };
  }
  const teacherId = responsibleTeacher(db, rel.id, date);
  return { teacherId, slots: teacherId ? availableSlots(db, teacherId, date, nowMs) : [] };
}

function book(db, { userId, relationId, date, start, nowMs }) {
  return db.transaction(() => {
    const rel = getUserRelation(db, relationId, userId);
    if (!isDate(date)) throw new HttpError(400, '日期格式错误');
    if (rel.status !== 'active' || rel.frozen) throw new HttpError(409, '该服务当前不可预约');
    if (date < rel.start_date || date > rel.end_date) throw new HttpError(400, '预约日期不在服务期内');
    if (rel.calls_left <= 0) throw new HttpError(409, '通话次数已用完');
    const teacherId = responsibleTeacher(db, rel.id, date);
    if (!teacherId) throw new HttpError(409, '该日期服务暂停，不可预约');
    if (!availableSlots(db, teacherId, date, nowMs).includes(start)) throw new HttpError(409, '该时段不可预约');

    const startMs = cnMs(date, hhmmToMin(start));
    const id = db.prepare(`INSERT INTO appointments (relation_id, user_id, teacher_id, date, start_ms, end_ms)
                           VALUES (?, ?, ?, ?, ?, ?)`)
      .run(rel.id, userId, teacherId, date, startMs, startMs + CALL_MINUTES * MIN).lastInsertRowid;
    db.prepare('UPDATE service_relations SET calls_left = calls_left - 1 WHERE id = ?').run(rel.id);
    notify(db, teacherId, 'appointment_booked', { appointmentId: id, date, start });
    return getAppointment(db, id);
  })();
}

function cancelOne(db, appt, by) {
  const r = db.prepare("UPDATE appointments SET status = 'cancelled', cancel_by = ? WHERE id = ? AND status = 'booked'")
    .run(by, appt.id);
  if (r.changes) db.prepare('UPDATE service_relations SET calls_left = calls_left + 1 WHERE id = ?').run(appt.relation_id);
  return r.changes > 0;
}

function cancelByUser(db, { userId, id, nowMs }) {
  const a = getAppointment(db, id);
  if (!a || a.user_id !== userId) throw new HttpError(404, '预约不存在');
  if (a.status !== 'booked') throw new HttpError(409, '该预约不可取消');
  if (a.start_ms - nowMs < USER_CANCEL_HOURS * 3600 * 1000) {
    throw new HttpError(409, `开始前 ${USER_CANCEL_HOURS} 小时内不可取消，请联系老师`);
  }
  db.transaction(() => {
    cancelOne(db, a, 'user');
    notify(db, a.teacher_id, 'appointment_cancelled', { appointmentId: a.id, by: 'user' });
  })();
  return getAppointment(db, id);
}

function cancelByTeacher(db, { teacherId, id, nowMs }) {
  const a = getAppointment(db, id);
  if (!a || a.teacher_id !== teacherId) throw new HttpError(404, '预约不存在');
  if (a.status !== 'booked') throw new HttpError(409, '该预约不可取消');
  if (a.start_ms <= nowMs) throw new HttpError(409, '已开始的预约不可取消');
  db.transaction(() => {
    cancelOne(db, a, 'teacher');
    notify(db, a.user_id, 'appointment_cancelled', { appointmentId: a.id, by: 'teacher' });
  })();
  return getAppointment(db, id);
}

// 批量取消某老师在日期区间内的预约（请假 / 撤销代班使用），调用方负责事务
function cancelAppointments(db, { teacherId, from, to, relationId = null }, by) {
  const args = [teacherId, from, to];
  if (relationId) args.push(relationId);
  const rows = db.prepare(`SELECT * FROM appointments WHERE status = 'booked' AND teacher_id = ? AND date BETWEEN ? AND ?
                           ${relationId ? 'AND relation_id = ?' : ''}`).all(...args);
  for (const a of rows) {
    cancelOne(db, a, by);
    notify(db, a.user_id, 'appointment_cancelled', { appointmentId: a.id, by });
  }
  return rows.length;
}

function listForUser(db, userId) {
  return db.prepare(`SELECT a.*, t.display_name AS teacher_name FROM appointments a
                     JOIN teacher_profiles t ON t.user_id = a.teacher_id
                     WHERE a.user_id = ? ORDER BY a.start_ms DESC`).all(userId);
}

function listForTeacher(db, teacherId) {
  return db.prepare(`SELECT a.*, u.nickname AS user_nickname FROM appointments a
                     JOIN users u ON u.id = a.user_id
                     WHERE a.teacher_id = ? ORDER BY a.start_ms DESC`).all(teacherId);
}

module.exports = {
  MIN, CALL_MINUTES, getAppointment, availableSlots, responsibleTeacher, slotsForRelation, book,
  cancelByUser, cancelByTeacher, cancelAppointments, listForUser, listForTeacher,
};
```

`server/src/routes/appointments.js`：

```js
const express = require('express');
const { userAuth } = require('../middleware/auth');
const appts = require('../services/appointments');

module.exports = (db, config) => {
  const router = express.Router();
  router.use(userAuth(config));

  router.get('/slots', (req, res) => {
    res.json(appts.slotsForRelation(db, {
      userId: req.userId, relationId: Number(req.query.relationId), date: String(req.query.date || ''), nowMs: config.now(),
    }));
  });

  router.post('/', (req, res) => {
    const { relationId, date, start } = req.body || {};
    res.status(201).json(appts.book(db, {
      userId: req.userId, relationId: Number(relationId), date: String(date || ''), start: String(start || ''), nowMs: config.now(),
    }));
  });

  router.get('/', (req, res) => res.json(appts.listForUser(db, req.userId)));

  router.post('/:id/cancel', (req, res) => {
    res.json(appts.cancelByUser(db, { userId: req.userId, id: Number(req.params.id), nowMs: config.now() }));
  });

  // 后续 Task 在此追加预约接口

  return router;
};
```

`server/src/routes/teacher.js` 顶部加：

```js
const appts = require('../services/appointments');
```

追加：

```js
  router.get('/appointments', (req, res) => {
    requireActiveTeacher(req);
    res.json(appts.listForTeacher(db, req.userId));
  });

  router.post('/appointments/:id/cancel', (req, res) => {
    requireActiveTeacher(req);
    res.json(appts.cancelByTeacher(db, { teacherId: req.userId, id: Number(req.params.id), nowMs: config.now() }));
  });
```

`server/src/app.js` 挂载：

```js
  app.use('/api/appointments', require('./routes/appointments')(db, config));
```

**Step 4: 运行，确认通过**

Run: `node --test tests/appointments.test.js`
Expected: PASS（8 tests）

**Step 5: Commit**

```bash
git add server/src server/tests/appointments.test.js
git commit -m "feat: 可约时段、预约与取消"
```

---

### Task 6: 请假与代班邀请

**Files:**
- Create: `server/src/services/leaves.js`
- Modify: `server/src/routes/teacher.js`
- Test: `server/tests/leaves.test.js`

**规则：**
- 校验顺序：已认证老师 → 日期合法、起始日 ≥ 今天、≤ 60 天 → 候选 1~3 位、不含自己 → 与自己已有请假不重叠（409）→ 自己没有已同意且时段重叠的代班（409）→ 每位候选为已认证老师、等级 ≥ 自己当前等级、该时段不在请假（400）。
- 生效（同一事务）：写请假与候选；**自动拒绝自己未处理且时段重叠的代班邀请**；取消自己在请假区间内的预约（退次数、通知学员）；对每条受影响服务关系执行 `pauseRange`，生成 48 小时期限的待选择项，并通知学员。
- 受影响服务关系：原老师为自己、`active`、在请假窗口内有正常分段；单次套餐仅当还有剩余次数。
- 候选老师接受或拒绝邀请（仅 `invited` 可处理），通知原老师；接受时通知该请假下仍待选择的学员。

**Step 1: 写失败测试**

`server/tests/leaves.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert');
const { setup, loginTeacher, loginAs, insertPackage, buyAndPay, FIXED_NOW } = require('./helpers');
const { setSchedule } = require('../src/services/schedule');
const appts = require('../src/services/appointments');
const { loadSegments } = require('../src/services/relations');

async function world() {
  const ctx = setup();
  const t = await loginTeacher(ctx, 't', { level: 2 });
  const s1 = await loginTeacher(ctx, 's1', { level: 2 });
  const s2 = await loginTeacher(ctx, 's2', { level: 3 });
  const low = await loginTeacher(ctx, 'low', { level: 1 });
  const u = await loginAs(ctx, 'u');
  const rel = buyAndPay(ctx, u.userId, insertPackage(ctx.db, t.userId));
  return { ctx, db: ctx.db, t, s1, s2, low, u, rel };
}
const LEAVE = { startDate: '2026-11-10', endDate: '2026-11-14', reason: '出差' };
const apply = (w, who, body) => w.ctx.api.post('/api/teacher/leaves').set(who.auth).send(body);
const respond = (w, who, leaveId, accept) =>
  w.ctx.api.post(`/api/teacher/substitute-invites/${leaveId}/respond`).set(who.auth).send({ accept });
const notifs = (w, userId, type) => w.db.prepare('SELECT * FROM notifications WHERE user_id = ? AND type = ?').all(userId, type);

test('请假参数校验', async () => {
  const w = await world();
  const ok = [w.s1.userId];
  assert.strictEqual((await apply(w, w.u, { ...LEAVE, candidateIds: ok })).status, 403);
  assert.strictEqual((await apply(w, w.t, { ...LEAVE, startDate: '2026-10-31', candidateIds: ok })).status, 400);
  assert.strictEqual((await apply(w, w.t, { ...LEAVE, endDate: '2027-01-10', candidateIds: ok })).status, 400);
  assert.strictEqual((await apply(w, w.t, { ...LEAVE, candidateIds: [] })).status, 400);
  assert.strictEqual((await apply(w, w.t, {
    ...LEAVE, candidateIds: [w.s1.userId, w.s2.userId, w.low.userId, w.u.userId],
  })).status, 400);
  assert.strictEqual((await apply(w, w.t, { ...LEAVE, candidateIds: [w.t.userId] })).status, 400);
  assert.strictEqual((await apply(w, w.t, { ...LEAVE, candidateIds: [w.low.userId] })).status, 400);
  assert.strictEqual((await apply(w, w.t, { ...LEAVE, candidateIds: [w.u.userId] })).status, 400);
});

test('请假生效：学员分段暂停顺延、生成待选择、通知学员与候选老师', async () => {
  const w = await world();
  const res = await apply(w, w.t, { ...LEAVE, candidateIds: [w.s1.userId, w.s2.userId] });
  assert.strictEqual(res.status, 201);
  assert.deepStrictEqual(loadSegments(w.db, w.rel.id), [
    { kind: 'normal', teacher_id: w.t.userId, start_date: '2026-11-01', end_date: '2026-11-09' },
    { kind: 'paused', teacher_id: null, start_date: '2026-11-10', end_date: '2026-11-14' },
    { kind: 'normal', teacher_id: w.t.userId, start_date: '2026-11-15', end_date: '2026-12-05' },
  ]);
  assert.strictEqual(w.db.prepare('SELECT end_date FROM service_relations').get().end_date, '2026-12-05');

  const choice = w.db.prepare('SELECT * FROM leave_choices').get();
  assert.strictEqual(choice.status, 'pending');
  assert.strictEqual(choice.relation_id, w.rel.id);
  assert.strictEqual(choice.deadline_ms, FIXED_NOW + 48 * 3600 * 1000);
  assert.strictEqual(notifs(w, w.u.userId, 'leave_notice').length, 1);
  assert.strictEqual(notifs(w, w.s1.userId, 'substitute_invite').length, 1);
  assert.strictEqual(notifs(w, w.s2.userId, 'substitute_invite').length, 1);

  const mine = await w.ctx.api.get('/api/teacher/leaves').set(w.t.auth);
  assert.strictEqual(mine.body.length, 1);
  assert.deepStrictEqual(mine.body[0].candidates.map((c) => c.status), ['invited', 'invited']);
  assert.strictEqual(mine.body[0].choices.length, 1);
});

test('请假期间已有预约自动取消并退还次数，请假日不可约', async () => {
  const w = await world();
  setSchedule(w.db, w.t.userId, [{ weekday: 2, start: '09:00', end: '12:00' }]);
  const a = appts.book(w.db, { userId: w.u.userId, relationId: w.rel.id, date: '2026-11-10', start: '10:00', nowMs: FIXED_NOW });
  await apply(w, w.t, { ...LEAVE, candidateIds: [w.s1.userId] });
  const after = appts.getAppointment(w.db, a.id);
  assert.strictEqual(after.status, 'cancelled');
  assert.strictEqual(after.cancel_by, 'leave');
  assert.strictEqual(w.db.prepare('SELECT calls_left FROM service_relations').get().calls_left, 4);
  assert.deepStrictEqual(appts.availableSlots(w.db, w.t.userId, '2026-11-10', FIXED_NOW), []);
});

test('与已有请假重叠 409；候选老师同时段在请假 400', async () => {
  const w = await world();
  assert.strictEqual((await apply(w, w.t, { ...LEAVE, candidateIds: [w.s1.userId] })).status, 201);
  assert.strictEqual((await apply(w, w.t, { startDate: '2026-11-14', endDate: '2026-11-16', candidateIds: [w.s1.userId] })).status, 409);
  w.db.prepare('INSERT INTO leaves (teacher_id, start_date, end_date, created_ms) VALUES (?, ?, ?, ?)')
    .run(w.s2.userId, '2026-11-20', '2026-11-22', FIXED_NOW);
  assert.strictEqual((await apply(w, w.t, { startDate: '2026-11-21', endDate: '2026-11-21', candidateIds: [w.s2.userId] })).status, 400);
});

test('代班邀请：接受/拒绝、重复处理 409、通知原老师与待选择学员', async () => {
  const w = await world();
  const leaveId = (await apply(w, w.t, { ...LEAVE, candidateIds: [w.s1.userId, w.s2.userId] })).body.id;
  const inv = await w.ctx.api.get('/api/teacher/substitute-invites').set(w.s1.auth);
  assert.strictEqual(inv.body.length, 1);
  assert.strictEqual(inv.body[0].leave_id, leaveId);
  assert.strictEqual(inv.body[0].owner_name, `老师${w.t.userId}`);

  assert.strictEqual((await respond(w, w.s1, leaveId, true)).body.status, 'accepted');
  assert.strictEqual((await respond(w, w.s1, leaveId, false)).status, 409);
  assert.strictEqual((await respond(w, w.s2, leaveId, false)).body.status, 'rejected');
  assert.strictEqual((await respond(w, w.low, leaveId, true)).status, 404);
  assert.strictEqual(notifs(w, w.t.userId, 'substitute_response').length, 2);
  assert.strictEqual(notifs(w, w.u.userId, 'substitute_available').length, 1);
});

test('已答应代班的老师不能提交重叠请假；不重叠可以', async () => {
  const w = await world();
  const leaveId = (await apply(w, w.t, { ...LEAVE, candidateIds: [w.s1.userId] })).body.id;
  await respond(w, w.s1, leaveId, true);
  assert.strictEqual((await apply(w, w.s1, { startDate: '2026-11-12', endDate: '2026-11-20', candidateIds: [w.s2.userId] })).status, 409);
  assert.strictEqual((await apply(w, w.s1, { startDate: '2026-11-20', endDate: '2026-11-21', candidateIds: [w.s2.userId] })).status, 201);
});

test('老师请假时，自动拒绝其未处理且时段重叠的代班邀请', async () => {
  const w = await world();
  const leaveId = (await apply(w, w.t, { ...LEAVE, candidateIds: [w.s1.userId] })).body.id;
  await apply(w, w.s1, { startDate: '2026-11-13', endDate: '2026-11-15', candidateIds: [w.s2.userId] });
  const c = w.db.prepare('SELECT status FROM substitute_candidates WHERE leave_id = ? AND teacher_id = ?').get(leaveId, w.s1.userId);
  assert.strictEqual(c.status, 'rejected');
});
```

**Step 2: 运行，确认失败**

Run: `node --test tests/leaves.test.js`
Expected: FAIL

**Step 3: 实现**

`server/src/services/leaves.js`：

```js
const { HttpError } = require('../lib/errors');
const { diffDays, todayCN, isDate } = require('../lib/dates');
const { notify } = require('../lib/notify');
const { requireActiveTeacher } = require('../lib/teacher');
const { loadSegments, saveSegments } = require('./relations');
const { pauseRange } = require('./segments');
const { cancelAppointments } = require('./appointments');

const MAX_LEAVE_DAYS = 60;
const MAX_CANDIDATES = 3;
const CHOICE_HOURS = 48;
const HOUR = 3600 * 1000;

const getLeave = (db, id) => db.prepare('SELECT * FROM leaves WHERE id = ?').get(id);
const getCandidate = (db, leaveId, teacherId) =>
  db.prepare('SELECT * FROM substitute_candidates WHERE leave_id = ? AND teacher_id = ?').get(leaveId, teacherId);

// 原老师所有请假日：顺延补齐时跳过
function leaveBlocker(db, teacherId) {
  const ranges = db.prepare('SELECT start_date, end_date FROM leaves WHERE teacher_id = ?').all(teacherId);
  return (date) => ranges.some((r) => r.start_date <= date && date <= r.end_date);
}

const overlapsLeave = (db, teacherId, from, to) => !!db.prepare(
  'SELECT 1 FROM leaves WHERE teacher_id = ? AND start_date <= ? AND end_date >= ?',
).get(teacherId, to, from);

const hasAcceptedSubstitute = (db, teacherId, from, to) => !!db.prepare(`
  SELECT 1 FROM substitute_candidates c JOIN leaves l ON l.id = c.leave_id
  WHERE c.teacher_id = ? AND c.status = 'accepted' AND l.start_date <= ? AND l.end_date >= ?`,
).get(teacherId, to, from);

function affectedRelations(db, teacherId, from, to) {
  return db.prepare(`
    SELECT r.* FROM service_relations r
    WHERE r.teacher_id = ? AND r.status = 'active' AND (r.package_type != 'single' OR r.calls_left > 0)
      AND EXISTS (SELECT 1 FROM service_segments s WHERE s.relation_id = r.id AND s.kind = 'normal'
                  AND s.start_date <= ? AND s.end_date >= ?)
    ORDER BY r.id`).all(teacherId, to, from);
}

function createLeave(db, { teacherId, startDate, endDate, reason = '', candidateIds, nowMs }) {
  const me = requireActiveTeacher(db, teacherId);
  const today = todayCN(nowMs);
  if (!isDate(startDate) || !isDate(endDate) || startDate > endDate) throw new HttpError(400, '请假日期非法');
  if (startDate < today) throw new HttpError(400, '请假开始日期不能早于今天');
  if (diffDays(startDate, endDate) + 1 > MAX_LEAVE_DAYS) throw new HttpError(400, `单次请假最长 ${MAX_LEAVE_DAYS} 天`);
  const ids = Array.isArray(candidateIds) ? [...new Set(candidateIds.map(Number))] : [];
  if (ids.length < 1 || ids.length > MAX_CANDIDATES) throw new HttpError(400, `请指定 1~${MAX_CANDIDATES} 位代班老师`);
  if (ids.includes(teacherId)) throw new HttpError(400, '不能指定自己代班');
  if (overlapsLeave(db, teacherId, startDate, endDate)) throw new HttpError(409, '与已有请假时间重叠');
  if (hasAcceptedSubstitute(db, teacherId, startDate, endDate)) {
    throw new HttpError(409, '你已答应该时段的代班，请先联系原老师撤销');
  }
  for (const cid of ids) {
    const c = db.prepare('SELECT level, status FROM teacher_profiles WHERE user_id = ?').get(cid);
    if (!c || c.status !== 'active') throw new HttpError(400, '代班老师不存在或未认证');
    if (c.level < me.level) throw new HttpError(400, '代班老师须为同级或更高级');
    if (overlapsLeave(db, cid, startDate, endDate)) throw new HttpError(400, '代班老师该时段也在请假');
  }

  return db.transaction(() => {
    const leaveId = db.prepare('INSERT INTO leaves (teacher_id, start_date, end_date, reason, created_ms) VALUES (?, ?, ?, ?, ?)')
      .run(teacherId, startDate, endDate, String(reason || '').slice(0, 200), nowMs).lastInsertRowid;

    db.prepare(`UPDATE substitute_candidates SET status = 'rejected', responded_at = datetime('now')
                WHERE teacher_id = ? AND status = 'invited'
                  AND leave_id IN (SELECT id FROM leaves WHERE start_date <= ? AND end_date >= ?)`)
      .run(teacherId, endDate, startDate);

    const insCand = db.prepare('INSERT INTO substitute_candidates (leave_id, teacher_id) VALUES (?, ?)');
    for (const cid of ids) {
      insCand.run(leaveId, cid);
      notify(db, cid, 'substitute_invite', { leaveId, fromTeacherId: teacherId, startDate, endDate });
    }

    cancelAppointments(db, { teacherId, from: startDate, to: endDate }, 'leave');

    const blocked = leaveBlocker(db, teacherId);
    const deadline = nowMs + CHOICE_HOURS * HOUR;
    const insChoice = db.prepare('INSERT INTO leave_choices (leave_id, relation_id, deadline_ms) VALUES (?, ?, ?)');
    for (const r of affectedRelations(db, teacherId, startDate, endDate)) {
      saveSegments(db, r.id, pauseRange(loadSegments(db, r.id), { from: startDate, to: endDate, ownerId: teacherId, blocked }));
      insChoice.run(leaveId, r.id, deadline);
      notify(db, r.user_id, 'leave_notice', { leaveId, relationId: r.id, startDate, endDate, deadlineMs: deadline });
    }
    return getLeave(db, leaveId);
  })();
}

function listLeaves(db, teacherId) {
  const cands = db.prepare(`SELECT c.teacher_id, c.status, t.display_name, t.level FROM substitute_candidates c
                            JOIN teacher_profiles t ON t.user_id = c.teacher_id WHERE c.leave_id = ? ORDER BY c.rowid`);
  const choices = db.prepare(`SELECT c.id, c.relation_id, c.status, c.substitute_teacher_id, r.user_id FROM leave_choices c
                              JOIN service_relations r ON r.id = c.relation_id WHERE c.leave_id = ? ORDER BY c.id`);
  return db.prepare('SELECT * FROM leaves WHERE teacher_id = ? ORDER BY start_date DESC').all(teacherId)
    .map((l) => ({ ...l, candidates: cands.all(l.id), choices: choices.all(l.id) }));
}

function listInvites(db, teacherId) {
  return db.prepare(`SELECT c.leave_id, c.status, l.start_date, l.end_date, l.reason,
                            l.teacher_id AS owner_id, t.display_name AS owner_name
                     FROM substitute_candidates c
                     JOIN leaves l ON l.id = c.leave_id
                     JOIN teacher_profiles t ON t.user_id = l.teacher_id
                     WHERE c.teacher_id = ? ORDER BY l.start_date DESC`).all(teacherId);
}

function respondInvite(db, { teacherId, leaveId, accept, nowMs }) {
  requireActiveTeacher(db, teacherId);
  const c = getCandidate(db, leaveId, teacherId);
  if (!c) throw new HttpError(404, '邀请不存在');
  if (c.status !== 'invited') throw new HttpError(409, '该邀请已处理');
  const leave = getLeave(db, leaveId);
  if (leave.end_date < todayCN(nowMs)) throw new HttpError(409, '请假已结束');
  if (accept && overlapsLeave(db, teacherId, leave.start_date, leave.end_date)) {
    throw new HttpError(409, '你在该时段有请假，不能代班');
  }
  db.transaction(() => {
    db.prepare("UPDATE substitute_candidates SET status = ?, responded_at = datetime('now') WHERE leave_id = ? AND teacher_id = ?")
      .run(accept ? 'accepted' : 'rejected', leaveId, teacherId);
    notify(db, leave.teacher_id, 'substitute_response', { leaveId, teacherId, accept: !!accept });
    if (accept) {
      const users = db.prepare(`SELECT r.user_id FROM leave_choices c JOIN service_relations r ON r.id = c.relation_id
                                WHERE c.leave_id = ? AND c.status = 'pending'`).all(leaveId);
      for (const u of users) notify(db, u.user_id, 'substitute_available', { leaveId, teacherId });
    }
  })();
  return getCandidate(db, leaveId, teacherId);
}

// 后续 Task 在此追加：学员选择、撤销代班、选择过期

module.exports = {
  CHOICE_HOURS, getLeave, leaveBlocker, createLeave, listLeaves, listInvites, respondInvite,
};
```

`server/src/routes/teacher.js` 顶部加：

```js
const leaves = require('../services/leaves');
```

追加：

```js
  router.post('/leaves', (req, res) => {
    const { startDate, endDate, reason, candidateIds } = req.body || {};
    res.status(201).json(leaves.createLeave(db, {
      teacherId: req.userId, startDate, endDate, reason, candidateIds, nowMs: config.now(),
    }));
  });

  router.get('/leaves', (req, res) => {
    requireActiveTeacher(req);
    res.json(leaves.listLeaves(db, req.userId));
  });

  router.get('/substitute-invites', (req, res) => {
    requireActiveTeacher(req);
    res.json(leaves.listInvites(db, req.userId));
  });

  router.post('/substitute-invites/:leaveId/respond', (req, res) => {
    res.json(leaves.respondInvite(db, {
      teacherId: req.userId, leaveId: Number(req.params.leaveId), accept: !!(req.body && req.body.accept), nowMs: config.now(),
    }));
  });
```

**Step 4: 运行，确认通过**

Run: `node --test tests/leaves.test.js`
Expected: PASS（7 tests）

**Step 5: Commit**

```bash
git add server/src server/tests/leaves.test.js
git commit -m "feat: 请假与代班邀请"
```

---

### Task 7: 学员选择代班、撤销代班、选择过期

**Files:**
- Modify: `server/src/services/leaves.js`
- Create: `server/src/routes/leave-choices.js`
- Modify: `server/src/routes/teacher.js`（撤销代班）
- Modify: `server/src/app.js`（挂载 `/api/leave-choices`）
- Test: `server/tests/leave-choices.test.js`

**规则：**
- 学员只能对 `pending` 且未过期限、请假未结束的选择项操作；`wait` 保持暂停；`substitute` 只能选已同意的候选。
- 选代班：从 `max(请假开始日, 今天)` 到请假结束日，把暂停日改为该老师的代班分段（`substituteFromPause`），收回等量顺延。
- 撤销代班（原老师操作，仅 `accepted` 候选）：已选该老师的学员从 `max(请假开始日, 今天)` 起改回暂停（`pauseFromSubstitute`），取消该老师在区间内与这些学员的预约，选择项回到 `pending` 并重新计 48 小时。
- 过期任务：`pending` 且到期的选择项置为 `expired`（保持暂停），通知学员。

**Step 1: 写失败测试**

`server/tests/leave-choices.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert');
const { setup, loginTeacher, loginAs, insertPackage, buyAndPay, FIXED_NOW, HOUR } = require('./helpers');
const { setSchedule } = require('../src/services/schedule');
const appts = require('../src/services/appointments');
const leaves = require('../src/services/leaves');
const { loadSegments } = require('../src/services/relations');
const { accrueUpTo } = require('../src/services/accrual');

async function world(range = { startDate: '2026-11-10', endDate: '2026-11-14' }) {
  const ctx = setup();
  const t = await loginTeacher(ctx, 't');
  const s1 = await loginTeacher(ctx, 's1');
  const s2 = await loginTeacher(ctx, 's2');
  const u = await loginAs(ctx, 'u');
  const rel = buyAndPay(ctx, u.userId, insertPackage(ctx.db, t.userId));
  const leave = leaves.createLeave(ctx.db, { teacherId: t.userId, ...range, candidateIds: [s1.userId, s2.userId], nowMs: FIXED_NOW });
  leaves.respondInvite(ctx.db, { teacherId: s1.userId, leaveId: leave.id, accept: true, nowMs: FIXED_NOW });
  const choice = ctx.db.prepare('SELECT * FROM leave_choices WHERE relation_id = ?').get(rel.id);
  return { ctx, db: ctx.db, t, s1, s2, u, rel, leave, choice };
}
const decide = (w, body, who = w.u) => w.ctx.api.post(`/api/leave-choices/${w.choice.id}`).set(who.auth).send(body);
const sumBy = (db, id) => db.prepare('SELECT COALESCE(SUM(amount_cents),0) s FROM accruals WHERE teacher_id = ?').get(id).s;

test('学员看到待选择项，只列出已同意的代班老师', async () => {
  const w = await world();
  const res = await w.ctx.api.get('/api/leave-choices').set(w.u.auth);
  assert.strictEqual(res.body.length, 1);
  assert.strictEqual(res.body[0].status, 'pending');
  assert.strictEqual(res.body[0].owner_name, `老师${w.t.userId}`);
  assert.deepStrictEqual(res.body[0].candidates.map((c) => c.teacher_id), [w.s1.userId]);
});

test('选择代班：暂停日改为代班分段，代班期间计提归代班老师', async () => {
  const w = await world();
  const res = await decide(w, { action: 'substitute', teacherId: w.s1.userId });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'substitute');
  assert.deepStrictEqual(loadSegments(w.db, w.rel.id), [
    { kind: 'normal', teacher_id: w.t.userId, start_date: '2026-11-01', end_date: '2026-11-09' },
    { kind: 'substitute', teacher_id: w.s1.userId, start_date: '2026-11-10', end_date: '2026-11-14' },
    { kind: 'normal', teacher_id: w.t.userId, start_date: '2026-11-15', end_date: '2026-11-30' },
  ]);
  assert.strictEqual(w.db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND type = 'substitute_assigned'")
    .get(w.s1.userId).c, 1);
  accrueUpTo(w.db, '2026-11-30');
  assert.strictEqual(sumBy(w.db, w.s1.userId), 500);
  assert.strictEqual(sumBy(w.db, w.t.userId), 2500);
});

test('只能选已同意的老师；他人不可操作；不能重复选择', async () => {
  const w = await world();
  assert.strictEqual((await decide(w, { action: 'substitute', teacherId: w.s2.userId })).status, 400);
  assert.strictEqual((await decide(w, { action: 'other' })).status, 400);
  const other = await loginAs(w.ctx, 'x');
  assert.strictEqual((await decide(w, { action: 'wait' }, other)).status, 404);
  assert.strictEqual((await decide(w, { action: 'wait' })).body.status, 'wait');
  assert.strictEqual((await decide(w, { action: 'substitute', teacherId: w.s1.userId })).status, 409);
  assert.strictEqual(loadSegments(w.db, w.rel.id)[1].kind, 'paused');
});

test('请假已开始后才选择：自选定当日起改为代班', async () => {
  const w = await world({ startDate: '2026-11-01', endDate: '2026-11-05' });
  w.ctx.config.now = () => Date.parse('2026-11-03T02:00:00Z');
  assert.strictEqual((await decide(w, { action: 'substitute', teacherId: w.s1.userId })).status, 200);
  assert.deepStrictEqual(loadSegments(w.db, w.rel.id), [
    { kind: 'paused', teacher_id: null, start_date: '2026-11-01', end_date: '2026-11-02' },
    { kind: 'substitute', teacher_id: w.s1.userId, start_date: '2026-11-03', end_date: '2026-11-05' },
    { kind: 'normal', teacher_id: w.t.userId, start_date: '2026-11-06', end_date: '2026-12-02' },
  ]);
});

test('超过 48 小时未选择：过期并保持暂停，之后不能再选', async () => {
  const w = await world();
  assert.strictEqual(leaves.expireChoices(w.db, FIXED_NOW + 47 * HOUR), 0);
  assert.strictEqual(leaves.expireChoices(w.db, FIXED_NOW + 48 * HOUR), 1);
  assert.strictEqual(w.db.prepare('SELECT status FROM leave_choices').get().status, 'expired');
  assert.strictEqual(w.db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND type = 'leave_choice_expired'")
    .get(w.u.userId).c, 1);
  assert.strictEqual((await decide(w, { action: 'wait' })).status, 409);
  assert.strictEqual(loadSegments(w.db, w.rel.id)[1].kind, 'paused');
});

test('期限已到但过期任务尚未执行：选择被拒绝', async () => {
  const w = await world();
  w.ctx.config.now = () => FIXED_NOW + 48 * HOUR;
  assert.strictEqual((await decide(w, { action: 'wait' })).status, 409);
});

test('原老师撤销代班：分段改回暂停、代班预约取消、学员重新获得选择期', async () => {
  const w = await world();
  setSchedule(w.db, w.s1.userId, [{ weekday: 2, start: '09:00', end: '12:00' }]);
  await decide(w, { action: 'substitute', teacherId: w.s1.userId });
  const a = appts.book(w.db, { userId: w.u.userId, relationId: w.rel.id, date: '2026-11-10', start: '09:00', nowMs: FIXED_NOW });
  assert.strictEqual(a.teacher_id, w.s1.userId);

  w.ctx.config.now = () => FIXED_NOW + HOUR;
  const revoke = (who, cid) => w.ctx.api.post(`/api/teacher/leaves/${w.leave.id}/candidates/${cid}/revoke`).set(who.auth);
  const res = await revoke(w.t, w.s1.userId);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'revoked');
  assert.strictEqual(loadSegments(w.db, w.rel.id)[1].kind, 'paused');
  assert.strictEqual(w.db.prepare('SELECT end_date FROM service_relations').get().end_date, '2026-12-05');
  assert.strictEqual(appts.getAppointment(w.db, a.id).status, 'cancelled');
  assert.strictEqual(w.db.prepare('SELECT calls_left FROM service_relations').get().calls_left, 4);

  const ch = w.db.prepare('SELECT * FROM leave_choices').get();
  assert.strictEqual(ch.status, 'pending');
  assert.strictEqual(ch.substitute_teacher_id, null);
  assert.strictEqual(ch.deadline_ms, FIXED_NOW + 49 * HOUR);

  assert.strictEqual((await revoke(w.t, w.s1.userId)).status, 409);
  assert.strictEqual((await revoke(w.s1, w.s2.userId)).status, 404);
});
```

**Step 2: 运行，确认失败**

Run: `node --test tests/leave-choices.test.js`
Expected: FAIL

**Step 3: 实现**

`server/src/services/leaves.js`：
- 第 6 行 `const { pauseRange } = require('./segments');` 改为
  `const { pauseRange, substituteFromPause, pauseFromSubstitute } = require('./segments');`
- 在 `// 后续 Task 在此追加：学员选择、撤销代班、选择过期` 下方加入：

```js
const later = (a, b) => (a > b ? a : b);

function listChoices(db, userId) {
  const cands = db.prepare(`SELECT c.teacher_id, t.display_name, t.level FROM substitute_candidates c
                            JOIN teacher_profiles t ON t.user_id = c.teacher_id
                            WHERE c.leave_id = ? AND c.status = 'accepted' ORDER BY c.rowid`);
  return db.prepare(`SELECT c.*, l.start_date, l.end_date, l.teacher_id AS owner_id, t.display_name AS owner_name
                     FROM leave_choices c
                     JOIN leaves l ON l.id = c.leave_id
                     JOIN service_relations r ON r.id = c.relation_id
                     JOIN teacher_profiles t ON t.user_id = l.teacher_id
                     WHERE r.user_id = ? ORDER BY c.id DESC`).all(userId)
    .map((c) => ({ ...c, candidates: cands.all(c.leave_id) }));
}

function decideChoice(db, { userId, choiceId, action, teacherId, nowMs }) {
  return db.transaction(() => {
    const c = db.prepare(`SELECT c.id, c.status, c.relation_id, c.deadline_ms, c.leave_id, r.user_id,
                                 l.teacher_id AS owner_id, l.start_date, l.end_date
                          FROM leave_choices c
                          JOIN service_relations r ON r.id = c.relation_id
                          JOIN leaves l ON l.id = c.leave_id
                          WHERE c.id = ?`).get(choiceId);
    if (!c || c.user_id !== userId) throw new HttpError(404, '选择项不存在');
    if (c.status !== 'pending') throw new HttpError(409, '已处理过该选择');
    if (nowMs >= c.deadline_ms) throw new HttpError(409, '已超过选择期限，服务已暂停顺延');
    const today = todayCN(nowMs);
    if (c.end_date < today) throw new HttpError(409, '请假已结束');

    if (action === 'wait') {
      db.prepare("UPDATE leave_choices SET status = 'wait', decided_at = datetime('now') WHERE id = ?").run(c.id);
    } else if (action === 'substitute') {
      const cand = getCandidate(db, c.leave_id, teacherId);
      if (!cand || cand.status !== 'accepted') throw new HttpError(400, '该老师不是可选的代班老师');
      const from = later(c.start_date, today);
      saveSegments(db, c.relation_id, substituteFromPause(loadSegments(db, c.relation_id), {
        from, to: c.end_date, teacherId, ownerId: c.owner_id, blocked: leaveBlocker(db, c.owner_id),
      }));
      db.prepare(`UPDATE leave_choices SET status = 'substitute', substitute_teacher_id = ?, decided_at = datetime('now')
                  WHERE id = ?`).run(teacherId, c.id);
      notify(db, teacherId, 'substitute_assigned', { leaveId: c.leave_id, relationId: c.relation_id, userId, from, to: c.end_date });
    } else {
      throw new HttpError(400, '无效的选择');
    }
    notify(db, c.owner_id, 'leave_choice', { leaveId: c.leave_id, relationId: c.relation_id, action });
    return db.prepare('SELECT * FROM leave_choices WHERE id = ?').get(c.id);
  })();
}

function revokeSubstitute(db, { teacherId, leaveId, candidateId, nowMs }) {
  requireActiveTeacher(db, teacherId);
  const leave = getLeave(db, leaveId);
  if (!leave || leave.teacher_id !== teacherId) throw new HttpError(404, '请假不存在');
  const cand = getCandidate(db, leaveId, candidateId);
  if (!cand || cand.status !== 'accepted') throw new HttpError(409, '该老师不在已同意代班状态');
  const today = todayCN(nowMs);
  if (leave.end_date < today) throw new HttpError(409, '请假已结束');

  const from = later(leave.start_date, today);
  const deadline = nowMs + CHOICE_HOURS * HOUR;
  db.transaction(() => {
    db.prepare("UPDATE substitute_candidates SET status = 'revoked', responded_at = datetime('now') WHERE leave_id = ? AND teacher_id = ?")
      .run(leaveId, candidateId);
    const blocked = leaveBlocker(db, teacherId);
    const choices = db.prepare(`SELECT c.*, r.user_id FROM leave_choices c JOIN service_relations r ON r.id = c.relation_id
                                WHERE c.leave_id = ? AND c.status = 'substitute' AND c.substitute_teacher_id = ?`)
      .all(leaveId, candidateId);
    for (const ch of choices) {
      saveSegments(db, ch.relation_id, pauseFromSubstitute(loadSegments(db, ch.relation_id), {
        from, to: leave.end_date, teacherId: candidateId, ownerId: teacherId, blocked,
      }));
      cancelAppointments(db, { teacherId: candidateId, from, to: leave.end_date, relationId: ch.relation_id }, 'leave');
      db.prepare(`UPDATE leave_choices SET status = 'pending', substitute_teacher_id = NULL, deadline_ms = ?, decided_at = NULL
                  WHERE id = ?`).run(deadline, ch.id);
      notify(db, ch.user_id, 'substitute_revoked', { leaveId, relationId: ch.relation_id, deadlineMs: deadline });
    }
    notify(db, candidateId, 'substitute_revoked', { leaveId });
  })();
  return getCandidate(db, leaveId, candidateId);
}

function expireChoices(db, nowMs) {
  const rows = db.prepare(`SELECT c.id, c.leave_id, c.relation_id, r.user_id FROM leave_choices c
                           JOIN service_relations r ON r.id = c.relation_id
                           WHERE c.status = 'pending' AND c.deadline_ms <= ?`).all(nowMs);
  db.transaction(() => {
    for (const c of rows) {
      db.prepare("UPDATE leave_choices SET status = 'expired', decided_at = datetime('now') WHERE id = ?").run(c.id);
      notify(db, c.user_id, 'leave_choice_expired', { leaveId: c.leave_id, relationId: c.relation_id });
    }
  })();
  return rows.length;
}
```

导出改为：

```js
module.exports = {
  CHOICE_HOURS, getLeave, leaveBlocker, createLeave, listLeaves, listInvites, respondInvite,
  listChoices, decideChoice, revokeSubstitute, expireChoices,
};
```

`server/src/routes/leave-choices.js`：

```js
const express = require('express');
const { userAuth } = require('../middleware/auth');
const leaves = require('../services/leaves');

module.exports = (db, config) => {
  const router = express.Router();
  router.use(userAuth(config));

  router.get('/', (req, res) => res.json(leaves.listChoices(db, req.userId)));

  router.post('/:id', (req, res) => {
    const { action, teacherId } = req.body || {};
    res.json(leaves.decideChoice(db, {
      userId: req.userId, choiceId: Number(req.params.id), action, teacherId: Number(teacherId), nowMs: config.now(),
    }));
  });

  return router;
};
```

`server/src/routes/teacher.js` 追加：

```js
  router.post('/leaves/:id/candidates/:teacherId/revoke', (req, res) => {
    res.json(leaves.revokeSubstitute(db, {
      teacherId: req.userId, leaveId: Number(req.params.id), candidateId: Number(req.params.teacherId), nowMs: config.now(),
    }));
  });
```

`server/src/app.js` 挂载：

```js
  app.use('/api/leave-choices', require('./routes/leave-choices')(db, config));
```

**Step 4: 运行，确认通过**

Run: `node --test tests/leave-choices.test.js tests/leaves.test.js`
Expected: PASS（7 + 7）

**Step 5: Commit**

```bash
git add server/src server/tests/leave-choices.test.js
git commit -m "feat: 学员选择代班、撤销代班与选择过期"
```

---

### Task 8: 腾讯云 UserSig 与 IM 登录凭证

**Files:**
- Create: `server/src/tencent/usersig.js`
- Create: `server/src/routes/im.js`
- Modify: `server/src/app.js`（挂载 `/api/im`）
- Test: `server/tests/usersig.test.js`

**说明：** IM 与 TRTC 共用同一个 SDKAppID 与密钥。UserSig 算法与官方 TLSSigAPIv2 一致：对 `TLS.identifier/sdkappid/time/expire` 拼接串做 HMAC-SHA256，与字段一起 JSON 化后 zlib 压缩，再做 base64 并把 `+ / =` 替换为 `* - _`。IM 账号统一为 `u{用户ID}`。未配置 `TENCENT_SDKAPPID/TENCENT_SECRETKEY` 时为 MOCK，`userSig` 返回 `'mock'`。

**Step 1: 写失败测试**

`server/tests/usersig.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { setup, loginAs } = require('./helpers');
const { genUserSig, decodeUserSig, imIdOf, parseImId } = require('../src/tencent/usersig');

const TENCENT = { sdkAppId: 1400000001, secretKey: 'sk-test', imCallbackToken: '', trtcCallbackKey: '' };

test('IM 账号映射', () => {
  assert.strictEqual(imIdOf(12), 'u12');
  assert.strictEqual(parseImId('u12'), 12);
  assert.strictEqual(parseImId('administrator'), null);
  assert.strictEqual(parseImId(undefined), null);
});

test('UserSig 可解出字段，签名为 HMAC-SHA256', () => {
  const sig = genUserSig(TENCENT, 'u12', 600, 1700000000);
  assert.match(sig, /^[A-Za-z0-9*\-_]+$/);
  const doc = decodeUserSig(sig);
  assert.strictEqual(doc['TLS.ver'], '2.0');
  assert.strictEqual(doc['TLS.identifier'], 'u12');
  assert.strictEqual(doc['TLS.sdkappid'], 1400000001);
  assert.strictEqual(doc['TLS.time'], 1700000000);
  assert.strictEqual(doc['TLS.expire'], 600);
  const content = 'TLS.identifier:u12\nTLS.sdkappid:1400000001\nTLS.time:1700000000\nTLS.expire:600\n';
  assert.strictEqual(doc['TLS.sig'], crypto.createHmac('sha256', 'sk-test').update(content).digest('base64'));
});

test('GET /api/im/usersig：MOCK 与真实模式', async () => {
  const mock = setup();
  const u1 = await loginAs(mock, 'u');
  const r1 = await mock.api.get('/api/im/usersig').set(u1.auth);
  assert.deepStrictEqual(r1.body, { mock: true, sdkAppId: 0, imId: `u${u1.userId}`, userSig: 'mock', expireSec: 604800 });

  const real = setup({ config: { tencent: TENCENT } });
  const u2 = await loginAs(real, 'u');
  const r2 = await real.api.get('/api/im/usersig').set(u2.auth);
  assert.strictEqual(r2.body.mock, false);
  assert.strictEqual(r2.body.sdkAppId, 1400000001);
  assert.strictEqual(decodeUserSig(r2.body.userSig)['TLS.identifier'], `u${u2.userId}`);
  assert.strictEqual((await real.api.get('/api/im/usersig')).status, 401);
});
```

**Step 2: 运行，确认失败**

Run: `node --test tests/usersig.test.js`
Expected: FAIL

**Step 3: 实现**

`server/src/tencent/usersig.js`：

```js
const crypto = require('crypto');
const zlib = require('zlib');

const SIG_EXPIRE = 7 * 86400;

const imIdOf = (userId) => `u${userId}`;
const parseImId = (s) => {
  const m = /^u(\d+)$/.exec(String(s || ''));
  return m ? Number(m[1]) : null;
};

const tencentMock = (tc) => !tc.sdkAppId || !tc.secretKey;

function hmacSig(key, identifier, sdkAppId, time, expire) {
  const content = `TLS.identifier:${identifier}\nTLS.sdkappid:${sdkAppId}\nTLS.time:${time}\nTLS.expire:${expire}\n`;
  return crypto.createHmac('sha256', key).update(content).digest('base64');
}

const escape = (b64) => b64.replace(/\+/g, '*').replace(/\//g, '-').replace(/=/g, '_');
const unescape = (s) => s.replace(/\*/g, '+').replace(/-/g, '/').replace(/_/g, '=');

function genUserSig({ sdkAppId, secretKey }, identifier, expire, nowSec) {
  const doc = {
    'TLS.ver': '2.0',
    'TLS.identifier': identifier,
    'TLS.sdkappid': sdkAppId,
    'TLS.expire': expire,
    'TLS.time': nowSec,
    'TLS.sig': hmacSig(secretKey, identifier, sdkAppId, nowSec, expire),
  };
  return escape(zlib.deflateSync(Buffer.from(JSON.stringify(doc))).toString('base64'));
}

const decodeUserSig = (sig) => JSON.parse(zlib.inflateSync(Buffer.from(unescape(sig), 'base64')).toString());

function userSigFor(config, imId) {
  if (tencentMock(config.tencent)) return 'mock';
  return genUserSig(config.tencent, imId, SIG_EXPIRE, Math.floor(config.now() / 1000));
}

module.exports = { SIG_EXPIRE, imIdOf, parseImId, tencentMock, genUserSig, decodeUserSig, userSigFor };
```

`server/src/routes/im.js`：

```js
const express = require('express');
const { userAuth } = require('../middleware/auth');
const { SIG_EXPIRE, imIdOf, tencentMock, userSigFor } = require('../tencent/usersig');

module.exports = (db, config) => {
  const router = express.Router();

  // 后续 Task 在此追加 IM 回调（腾讯云调用，不走用户登录）

  router.use(userAuth(config));

  router.get('/usersig', (req, res) => {
    const imId = imIdOf(req.userId);
    res.json({
      mock: tencentMock(config.tencent),
      sdkAppId: config.tencent.sdkAppId,
      imId,
      userSig: userSigFor(config, imId),
      expireSec: SIG_EXPIRE,
    });
  });

  // 后续 Task 在此追加需登录的 IM 接口

  return router;
};
```

`server/src/app.js` 挂载：

```js
  app.use('/api/im', require('./routes/im')(db, config));
```

**Step 4: 运行，确认通过**

Run: `node --test tests/usersig.test.js`
Expected: PASS（3 tests）

**Step 5: Commit**

```bash
git add server/src server/tests/usersig.test.js
git commit -m "feat: 腾讯云 UserSig 与 IM 登录凭证"
```

---

### Task 9: TRTC 进入通话、房间回调、爽约与自动完成

**Files:**
- Create: `server/src/tencent/callback-auth.js`
- Create: `server/src/routes/trtc.js`
- Modify: `server/src/services/appointments.js`
- Modify: `server/src/routes/appointments.js`（用户进入通话）
- Modify: `server/src/routes/teacher.js`（老师进入通话）
- Modify: `server/src/app.js`（保留原始请求体、挂载 `/api/trtc`）
- Test: `server/tests/calls.test.js`

**说明：**
- 房间号 = 预约 ID。进入通话接口只在「开始前 10 分钟 ~ 结束时间」开放，返回 TRTC 进房参数。
- 真实模式以 TRTC 房间事件回调为准：`EventGroupId=1` 下 `103` 进房记录首次进房时间；`102` 解散房间时，若老师与学员都进过房则通话完成。回调签名 `Sign = base64(HMAC-SHA256(回调密钥, 原始请求体))`，放在请求头。
- MOCK 模式（未配置腾讯云）：调用进入通话接口即记为已进房，靠自动完成任务收尾，便于本地联调。
- IM 回调鉴权一并在此实现（Task 11 使用）：`Sign = sha256(Token + RequestTime)`，`RequestTime` 偏差超过 300 秒视为无效。未配置 Token / 密钥时跳过校验。

**Step 1: 写失败测试**

`server/tests/calls.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { setup, loginTeacher, loginAs, insertPackage, buyAndPay } = require('./helpers');
const { setSchedule } = require('../src/services/schedule');
const appts = require('../src/services/appointments');
const { verifyImSign, verifyTrtcSign } = require('../src/tencent/callback-auth');

const MIN = 60000;
const TENCENT = { sdkAppId: 1400000001, secretKey: 'sk', imCallbackToken: '', trtcCallbackKey: 'ck' };

async function world(opts) {
  const ctx = setup(opts);
  const t = await loginTeacher(ctx, 't');
  const u = await loginAs(ctx, 'u');
  setSchedule(ctx.db, t.userId, [{ weekday: 1, start: '09:00', end: '12:00' }]);
  const rel = buyAndPay(ctx, u.userId, insertPackage(ctx.db, t.userId));
  const a = appts.book(ctx.db, { userId: u.userId, relationId: rel.id, date: '2026-11-02', start: '10:00', nowMs: ctx.config.now() });
  return { ctx, db: ctx.db, t, u, rel, a };
}
const get = (w) => appts.getAppointment(w.db, w.a.id);
const callsLeft = (w) => w.db.prepare('SELECT calls_left FROM service_relations').get().calls_left;
function trtc(w, body, key = 'ck') {
  const raw = JSON.stringify(body);
  return w.ctx.api.post('/api/trtc/callback').set('Content-Type', 'application/json')
    .set('Sign', crypto.createHmac('sha256', key).update(raw).digest('base64')).send(raw);
}

test('回调签名校验', () => {
  const raw = Buffer.from('{"a":1}');
  const sign = crypto.createHmac('sha256', 'ck').update(raw).digest('base64');
  assert.strictEqual(verifyTrtcSign('ck', raw, sign), true);
  assert.strictEqual(verifyTrtcSign('ck', raw, 'x'), false);
  assert.strictEqual(verifyTrtcSign('', raw, ''), true);

  const sec = 1700000000;
  const imSign = crypto.createHash('sha256').update(`tok${sec}`).digest('hex');
  assert.strictEqual(verifyImSign('tok', { RequestTime: String(sec), Sign: imSign }, sec * 1000), true);
  assert.strictEqual(verifyImSign('tok', { RequestTime: String(sec), Sign: imSign }, (sec + 301) * 1000), false);
  assert.strictEqual(verifyImSign('tok', { RequestTime: String(sec), Sign: 'x' }, sec * 1000), false);
  assert.strictEqual(verifyImSign('', {}, 0), true);
});

test('进入通话：时间窗口、只能进自己的预约；MOCK 模式直接记为已进房', async () => {
  const w = await world();
  const join = (who, path) => w.ctx.api.post(path).set(who.auth);
  assert.strictEqual((await join(w.u, `/api/appointments/${w.a.id}/join`)).status, 409);

  w.ctx.config.now = () => w.a.start_ms - 5 * MIN;
  const ru = await join(w.u, `/api/appointments/${w.a.id}/join`);
  assert.strictEqual(ru.status, 200);
  assert.deepStrictEqual(ru.body, { mock: true, sdkAppId: 0, roomId: w.a.id, imId: `u${w.u.userId}`, userSig: 'mock' });
  assert.strictEqual((await join(w.t, `/api/appointments/${w.a.id}/join`)).status, 404);
  assert.strictEqual((await join(w.t, `/api/teacher/appointments/${w.a.id}/join`)).status, 200);
  assert.strictEqual(get(w).teacher_joined_ms, w.a.start_ms - 5 * MIN);
  assert.strictEqual(get(w).user_joined_ms, w.a.start_ms - 5 * MIN);

  w.ctx.config.now = () => w.a.end_ms + 1;
  assert.strictEqual((await join(w.u, `/api/appointments/${w.a.id}/join`)).status, 409);
});

test('TRTC 回调：双方进房后解散房间 → 通话完成；签名错误 401', async () => {
  const w = await world({ config: { tencent: TENCENT } });
  const enter = (uid, ts) => ({
    EventGroupId: 1, EventType: 103, CallbackTs: ts,
    EventInfo: { RoomId: w.a.id, EventTs: Math.floor(ts / 1000), UserId: `u${uid}` },
  });
  assert.strictEqual((await trtc(w, enter(w.t.userId, w.a.start_ms), 'wrong')).status, 401);
  assert.strictEqual(get(w).teacher_joined_ms, null);

  await trtc(w, enter(w.t.userId, w.a.start_ms));
  await trtc(w, enter(w.u.userId, w.a.start_ms + MIN));
  await trtc(w, enter(w.t.userId, w.a.start_ms + 2 * MIN));
  assert.strictEqual(get(w).teacher_joined_ms, w.a.start_ms);
  assert.strictEqual(get(w).user_joined_ms, w.a.start_ms + MIN);

  const end = w.a.start_ms + 50 * MIN;
  const res = await trtc(w, { EventGroupId: 1, EventType: 102, EventInfo: { RoomId: w.a.id, EventTs: Math.floor(end / 1000) } });
  assert.deepStrictEqual(res.body, { code: 0 });
  assert.strictEqual(get(w).status, 'completed');
  assert.strictEqual(get(w).ended_ms, end);
  assert.strictEqual(get(w).confirm_status, null);
  assert.strictEqual(callsLeft(w), 3);
});

test('只有老师进房就解散，不算完成', async () => {
  const w = await world({ config: { tencent: TENCENT } });
  appts.recordEnter(w.db, w.a.id, w.t.userId, w.a.start_ms);
  assert.strictEqual(appts.onRoomDismissed(w.db, w.a.id, w.a.start_ms + MIN), false);
  assert.strictEqual(get(w).status, 'booked');
});

test('开始 15 分钟后老师仍未进房 → 爽约，退还次数并通知双方', async () => {
  const w = await world();
  assert.strictEqual(appts.markNoShows(w.db, w.a.start_ms + 14 * MIN), 0);
  assert.strictEqual(appts.markNoShows(w.db, w.a.start_ms + 15 * MIN), 1);
  assert.strictEqual(get(w).status, 'teacher_no_show');
  assert.strictEqual(callsLeft(w), 4);
  const ids = w.db.prepare("SELECT user_id FROM notifications WHERE type = 'teacher_no_show'").all().map((r) => r.user_id);
  assert.strictEqual(ids.length, 2);
  assert.ok(ids.includes(w.t.userId) && ids.includes(w.u.userId));
});

test('老师进过房、结束 30 分钟后仍无解散回调 → 自动完成（学员未到也消耗次数）', async () => {
  const w = await world();
  appts.recordEnter(w.db, w.a.id, w.t.userId, w.a.start_ms);
  assert.strictEqual(appts.markNoShows(w.db, w.a.start_ms + 20 * MIN), 0);
  assert.strictEqual(appts.autoComplete(w.db, w.a.end_ms + 29 * MIN), 0);
  assert.strictEqual(appts.autoComplete(w.db, w.a.end_ms + 30 * MIN), 1);
  assert.strictEqual(get(w).status, 'completed');
  assert.strictEqual(callsLeft(w), 3);
});
```

**Step 2: 运行，确认失败**

Run: `node --test tests/calls.test.js`
Expected: FAIL

**Step 3: 实现**

`server/src/tencent/callback-auth.js`：

```js
const crypto = require('crypto');

const IM_MAX_SKEW_SEC = 300;

function verifyImSign(token, query, nowMs) {
  if (!token) return true;
  const t = Number(query && query.RequestTime);
  if (!Number.isFinite(t) || Math.abs(nowMs / 1000 - t) > IM_MAX_SKEW_SEC) return false;
  const expect = crypto.createHash('sha256').update(`${token}${query.RequestTime}`).digest('hex');
  return expect === String(query.Sign || '');
}

function verifyTrtcSign(key, rawBody, sign) {
  if (!key) return true;
  const expect = crypto.createHmac('sha256', key).update(rawBody || Buffer.alloc(0)).digest('base64');
  return expect === String(sign || '');
}

module.exports = { verifyImSign, verifyTrtcSign };
```

`server/src/services/appointments.js`：
- 顶部加 `const { imIdOf, tencentMock, userSigFor } = require('../tencent/usersig');`
- 在 `module.exports` 之前加入：

```js
const JOIN_EARLY_MIN = 10;
const NO_SHOW_MIN = 15;
const AUTO_COMPLETE_MIN = 30;

function joinable(db, { appointmentId, userId, asTeacher, nowMs }) {
  const a = getAppointment(db, appointmentId);
  if (!a || (asTeacher ? a.teacher_id : a.user_id) !== userId) throw new HttpError(404, '预约不存在');
  if (a.status !== 'booked') throw new HttpError(409, '该预约不可进入');
  if (nowMs < a.start_ms - JOIN_EARLY_MIN * MIN || nowMs > a.end_ms) {
    throw new HttpError(409, `请在开始前 ${JOIN_EARLY_MIN} 分钟至结束前进入`);
  }
  return a;
}

function recordEnter(db, appointmentId, userId, tsMs) {
  const a = getAppointment(db, appointmentId);
  if (!a || a.status !== 'booked') return false;
  const col = userId === a.teacher_id ? 'teacher_joined_ms' : userId === a.user_id ? 'user_joined_ms' : null;
  if (!col) return false;
  return db.prepare(`UPDATE appointments SET ${col} = COALESCE(${col}, ?) WHERE id = ?`).run(tsMs, a.id).changes > 0;
}

function joinCall(db, config, { appointmentId, userId, asTeacher }) {
  const nowMs = config.now();
  const a = joinable(db, { appointmentId, userId, asTeacher, nowMs });
  const mock = tencentMock(config.tencent);
  if (mock) recordEnter(db, a.id, userId, nowMs);
  const imId = imIdOf(userId);
  return { mock, sdkAppId: config.tencent.sdkAppId, roomId: a.id, imId, userSig: userSigFor(config, imId) };
}

function completeAppointment(db, a, endedMs) {
  const rel = db.prepare('SELECT package_type FROM service_relations WHERE id = ?').get(a.relation_id);
  const single = rel.package_type === 'single';
  const r = db.prepare(`UPDATE appointments SET status = 'completed', ended_ms = ?, confirm_status = ?
                        WHERE id = ? AND status = 'booked'`).run(endedMs, single ? 'pending' : null, a.id);
  if (r.changes && single) notify(db, a.user_id, 'call_confirm_request', { appointmentId: a.id });
  return r.changes > 0;
}

function onRoomDismissed(db, appointmentId, tsMs) {
  const a = getAppointment(db, appointmentId);
  if (!a || a.status !== 'booked' || !a.teacher_joined_ms || !a.user_joined_ms) return false;
  return completeAppointment(db, a, tsMs);
}

function markNoShows(db, nowMs) {
  const rows = db.prepare(`SELECT * FROM appointments
                           WHERE status = 'booked' AND teacher_joined_ms IS NULL AND start_ms + ? <= ?`)
    .all(NO_SHOW_MIN * MIN, nowMs);
  db.transaction(() => {
    for (const a of rows) {
      db.prepare("UPDATE appointments SET status = 'teacher_no_show' WHERE id = ?").run(a.id);
      db.prepare('UPDATE service_relations SET calls_left = calls_left + 1 WHERE id = ?').run(a.relation_id);
      notify(db, a.user_id, 'teacher_no_show', { appointmentId: a.id });
      notify(db, a.teacher_id, 'teacher_no_show', { appointmentId: a.id });
    }
  })();
  return rows.length;
}

function autoComplete(db, nowMs) {
  const rows = db.prepare(`SELECT * FROM appointments
                           WHERE status = 'booked' AND teacher_joined_ms IS NOT NULL AND end_ms + ? <= ?`)
    .all(AUTO_COMPLETE_MIN * MIN, nowMs);
  let n = 0;
  db.transaction(() => {
    for (const a of rows) if (completeAppointment(db, a, nowMs)) n += 1;
  })();
  return n;
}
```

- 导出追加 `joinCall, recordEnter, onRoomDismissed, markNoShows, autoComplete`。

`server/src/routes/appointments.js` 在 `// 后续 Task 在此追加预约接口` 下方加入：

```js
  router.post('/:id/join', (req, res) => {
    res.json(appts.joinCall(db, config, { appointmentId: Number(req.params.id), userId: req.userId, asTeacher: false }));
  });
```

`server/src/routes/teacher.js` 追加：

```js
  router.post('/appointments/:id/join', (req, res) => {
    requireActiveTeacher(req);
    res.json(appts.joinCall(db, config, { appointmentId: Number(req.params.id), userId: req.userId, asTeacher: true }));
  });
```

`server/src/routes/trtc.js`：

```js
const express = require('express');
const { verifyTrtcSign } = require('../tencent/callback-auth');
const { parseImId } = require('../tencent/usersig');
const appts = require('../services/appointments');

const ROOM_EVENTS = 1;
const DISMISS_ROOM = 102;
const ENTER_ROOM = 103;

module.exports = (db, config) => {
  const router = express.Router();

  router.post('/callback', (req, res) => {
    if (!verifyTrtcSign(config.tencent.trtcCallbackKey, req.rawBody, req.get('Sign'))) {
      return res.status(401).json({ code: 1 });
    }
    const { EventGroupId, EventType, EventInfo = {} } = req.body || {};
    if (EventGroupId === ROOM_EVENTS) {
      const roomId = Number(EventInfo.RoomId);
      const ts = Number(EventInfo.EventMsTs) || Number(EventInfo.EventTs) * 1000 || config.now();
      if (EventType === ENTER_ROOM) {
        const uid = parseImId(EventInfo.UserId);
        if (uid) appts.recordEnter(db, roomId, uid, ts);
      } else if (EventType === DISMISS_ROOM) {
        appts.onRoomDismissed(db, roomId, ts);
      }
    }
    res.json({ code: 0 });
  });

  return router;
};
```

`server/src/app.js`：把 `app.use(express.json());` 改为

```js
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
```

并挂载：

```js
  app.use('/api/trtc', require('./routes/trtc')(db, config));
```

**Step 4: 运行，确认通过**

Run: `node --test tests/calls.test.js && npm test`
Expected: 新增 6 个 PASS；全量无回归。

**Step 5: Commit**

```bash
git add server/src server/tests/calls.test.js
git commit -m "feat: TRTC 进入通话、房间回调、爽约与自动完成"
```

---

### Task 10: 单次套餐通话确认与计提

**Files:**
- Modify: `server/src/services/appointments.js`
- Modify: `server/src/routes/appointments.js`
- Test: `server/tests/single-accrual.test.js`

**规则：** 单次套餐通话完成后 `confirm_status = 'pending'`。用户确认（或完成后 48 小时无异议自动确认）→ 写一条计提：日期为通话日、老师为实际上课老师、金额为订单全额，并结束该服务关系。用户提出异议 → `disputed`，不计提，通知老师（第五阶段工单处理）。周期套餐的通话不需要确认。冻结的服务关系也照常写计提，第一阶段的结算已经排除冻结关系。

**Step 1: 写失败测试**

`server/tests/single-accrual.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert');
const { setup, loginTeacher, loginAs, insertPackage, buyAndPay, HOUR } = require('./helpers');
const { setSchedule } = require('../src/services/schedule');
const appts = require('../src/services/appointments');
const { generateSettlements } = require('../src/services/settlement');

const MIN = 60000;
const SINGLE = { type: 'single', title: '单次咨询', days: 0, call_quota: 1, price_cents: 500 };

async function world(pkg = SINGLE) {
  const ctx = setup();
  const t = await loginTeacher(ctx, 't');
  const u = await loginAs(ctx, 'u');
  setSchedule(ctx.db, t.userId, [{ weekday: 1, start: '09:00', end: '12:00' }]);
  const rel = buyAndPay(ctx, u.userId, insertPackage(ctx.db, t.userId, pkg));
  const a = appts.book(ctx.db, { userId: u.userId, relationId: rel.id, date: '2026-11-02', start: '10:00', nowMs: ctx.config.now() });
  appts.recordEnter(ctx.db, a.id, t.userId, a.start_ms);
  appts.recordEnter(ctx.db, a.id, u.userId, a.start_ms);
  const ended = a.start_ms + 50 * MIN;
  appts.onRoomDismissed(ctx.db, a.id, ended);
  return { ctx, db: ctx.db, t, u, rel, a, ended };
}
const confirm = (w, ok) => w.ctx.api.post(`/api/appointments/${w.a.id}/confirm`).set(w.u.auth).send({ ok });
const accruals = (w) => w.db.prepare('SELECT date, teacher_id, amount_cents FROM accruals').all();

test('单次通话完成后待用户确认，并通知用户', async () => {
  const w = await world();
  assert.strictEqual(appts.getAppointment(w.db, w.a.id).confirm_status, 'pending');
  assert.strictEqual(w.db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND type = 'call_confirm_request'")
    .get(w.u.userId).c, 1);
  assert.deepStrictEqual(accruals(w), []);
});

test('用户确认 → 全额计给上课老师、服务关系结束、进入周结算；重复确认 409', async () => {
  const w = await world();
  const res = await confirm(w, true);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.confirm_status, 'confirmed');
  assert.deepStrictEqual(accruals(w), [{ date: '2026-11-02', teacher_id: w.t.userId, amount_cents: 500 }]);
  assert.strictEqual(w.db.prepare('SELECT status FROM service_relations').get().status, 'ended');
  const [s] = generateSettlements(w.db, { periodStart: '2026-11-01', periodEnd: '2026-11-07' });
  assert.strictEqual(s.gross_cents, 500);
  assert.strictEqual((await confirm(w, true)).status, 409);
});

test('用户提出异议 → 不计提，通知老师', async () => {
  const w = await world();
  const res = await confirm(w, false);
  assert.strictEqual(res.body.confirm_status, 'disputed');
  assert.deepStrictEqual(accruals(w), []);
  assert.strictEqual(w.db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND type = 'call_disputed'")
    .get(w.t.userId).c, 1);
});

test('完成 48 小时内无异议自动确认', async () => {
  const w = await world();
  assert.strictEqual(appts.autoConfirm(w.db, w.ended + 47 * HOUR), 0);
  assert.strictEqual(appts.autoConfirm(w.db, w.ended + 48 * HOUR), 1);
  assert.strictEqual(appts.getAppointment(w.db, w.a.id).confirm_status, 'auto');
  assert.strictEqual(accruals(w).length, 1);
});

test('周期套餐的通话不需要确认', async () => {
  const w = await world({});
  assert.strictEqual(appts.getAppointment(w.db, w.a.id).confirm_status, null);
  assert.strictEqual((await confirm(w, true)).status, 409);
});
```

**Step 2: 运行，确认失败**

Run: `node --test tests/single-accrual.test.js`
Expected: FAIL

**Step 3: 实现**

`server/src/services/appointments.js` 在 `module.exports` 之前加入：

```js
const CONFIRM_HOURS = 48;

function accrueSingle(db, a) {
  const rel = db.prepare('SELECT * FROM service_relations WHERE id = ?').get(a.relation_id);
  if (rel.package_type !== 'single') return 0;
  const n = db.prepare(`INSERT OR IGNORE INTO accruals (relation_id, date, teacher_id, amount_cents)
                        VALUES (?, ?, ?, ?)`).run(rel.id, a.date, a.teacher_id, rel.amount_cents).changes;
  db.prepare("UPDATE service_relations SET status = 'ended' WHERE id = ? AND status = 'active'").run(rel.id);
  return n;
}

function confirmCall(db, { userId, id, ok }) {
  return db.transaction(() => {
    const a = getAppointment(db, id);
    if (!a || a.user_id !== userId) throw new HttpError(404, '预约不存在');
    if (a.status !== 'completed' || a.confirm_status !== 'pending') throw new HttpError(409, '该通话无需确认');
    if (ok) {
      db.prepare("UPDATE appointments SET confirm_status = 'confirmed' WHERE id = ?").run(a.id);
      accrueSingle(db, a);
    } else {
      db.prepare("UPDATE appointments SET confirm_status = 'disputed' WHERE id = ?").run(a.id);
      notify(db, a.teacher_id, 'call_disputed', { appointmentId: a.id });
    }
    return getAppointment(db, a.id);
  })();
}

function autoConfirm(db, nowMs) {
  const rows = db.prepare(`SELECT * FROM appointments
                           WHERE status = 'completed' AND confirm_status = 'pending' AND ended_ms + ? <= ?`)
    .all(CONFIRM_HOURS * 3600 * 1000, nowMs);
  db.transaction(() => {
    for (const a of rows) {
      db.prepare("UPDATE appointments SET confirm_status = 'auto' WHERE id = ?").run(a.id);
      accrueSingle(db, a);
    }
  })();
  return rows.length;
}
```

导出追加 `confirmCall, autoConfirm`。

`server/src/routes/appointments.js` 追加：

```js
  router.post('/:id/confirm', (req, res) => {
    res.json(appts.confirmCall(db, { userId: req.userId, id: Number(req.params.id), ok: !!(req.body && req.body.ok) }));
  });
```

**Step 4: 运行，确认通过**

Run: `node --test tests/single-accrual.test.js && node --test tests/accrual.test.js`
Expected: 新增 5 个 PASS；第一阶段日计提仍 PASS（单次套餐不参与日计提）。

**Step 5: Commit**

```bash
git add server/src server/tests/single-accrual.test.js
git commit -m "feat: 单次套餐通话确认与计提"
```

---

### Task 11: 聊天权限、IM 发送前回调与联系人

**Files:**
- Create: `server/src/services/chat.js`
- Modify: `server/src/routes/im.js`
- Test: `server/tests/chat.test.js`

**规则：**
- 学员 ↔ 原老师：存在 `active` 的服务关系即可（包括原老师请假当天）。
- 学员 ↔ 代班老师：仅当天落在该老师代班分段的服务关系。
- `resolvePair(a, b)` 自动识别谁是学员；同一对有多条关系时，优先当天由该老师负责的那条。返回 `responsible`（当天负责老师；暂停日为 `null`），供回复时效统计使用。
- IM 回调 `C2C.CallbackBeforeSendMsg`：没有权限时返回 `ErrorCode 120001` 拦截；非 `u{id}` 账号（如系统管理员）放行。所有回调先校验 `Sign`。

**Step 1: 写失败测试**

`server/tests/chat.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { setup, loginTeacher, loginAs, insertPackage, buyAndPay, FIXED_NOW } = require('./helpers');
const { resolvePair } = require('../src/services/chat');
const { loadSegments, saveSegments } = require('../src/services/relations');
const { applySubstitute } = require('../src/services/segments');

const TODAY = '2026-11-01';

async function world(opts) {
  const ctx = setup(opts);
  const t = await loginTeacher(ctx, 't');
  const s = await loginTeacher(ctx, 's');
  const u = await loginAs(ctx, 'u');
  const x = await loginAs(ctx, 'x');
  const rel = buyAndPay(ctx, u.userId, insertPackage(ctx.db, t.userId));
  return { ctx, db: ctx.db, t, s, u, x, rel };
}
const substituteOn = (w, date) => saveSegments(w.db, w.rel.id,
  applySubstitute(loadSegments(w.db, w.rel.id), { from: date, to: date, teacherId: w.s.userId }));
const before = (w, from, to, query = {}) => w.ctx.api.post('/api/im/callback').query(query).send({
  CallbackCommand: 'C2C.CallbackBeforeSendMsg', From_Account: from, To_Account: to,
  MsgBody: [{ MsgType: 'TIMTextElem', MsgContent: { Text: '你好' } }],
});

test('学员与原老师可聊天（双向识别），与陌生人不可', async () => {
  const w = await world();
  const p = resolvePair(w.db, w.u.userId, w.t.userId, TODAY);
  assert.strictEqual(p.studentId, w.u.userId);
  assert.strictEqual(p.teacherId, w.t.userId);
  assert.strictEqual(p.responsible, w.t.userId);
  assert.strictEqual(resolvePair(w.db, w.t.userId, w.u.userId, TODAY).studentId, w.u.userId);
  assert.strictEqual(resolvePair(w.db, w.u.userId, w.x.userId, TODAY), null);
  assert.strictEqual(resolvePair(w.db, w.u.userId, w.s.userId, TODAY), null);
});

test('代班老师仅在代班日可聊天；当天原老师仍可聊但不是负责人', async () => {
  const w = await world();
  substituteOn(w, TODAY);
  assert.strictEqual(resolvePair(w.db, w.u.userId, w.s.userId, TODAY).responsible, w.s.userId);
  assert.strictEqual(resolvePair(w.db, w.u.userId, w.s.userId, '2026-11-02'), null);
  assert.strictEqual(resolvePair(w.db, w.u.userId, w.t.userId, TODAY).responsible, w.s.userId);
});

test('服务关系结束后不可聊天', async () => {
  const w = await world();
  w.db.prepare("UPDATE service_relations SET status = 'ended'").run();
  assert.strictEqual(resolvePair(w.db, w.u.userId, w.t.userId, TODAY), null);
});

test('IM 发送前回调：有权限放行、无权限拦截、系统账号放行', async () => {
  const w = await world();
  assert.deepStrictEqual((await before(w, `u${w.u.userId}`, `u${w.t.userId}`)).body,
    { ActionStatus: 'OK', ErrorCode: 0, ErrorInfo: '' });
  assert.strictEqual((await before(w, `u${w.u.userId}`, `u${w.x.userId}`)).body.ErrorCode, 120001);
  assert.strictEqual((await before(w, 'administrator', `u${w.x.userId}`)).body.ErrorCode, 0);
});

test('IM 回调鉴权：配置 Token 后签名错误返回 403', async () => {
  const tencent = { sdkAppId: 1400000001, secretKey: 'sk', imCallbackToken: 'tok', trtcCallbackKey: '' };
  const w = await world({ config: { tencent } });
  const sec = String(Math.floor(FIXED_NOW / 1000));
  const sign = crypto.createHash('sha256').update(`tok${sec}`).digest('hex');
  assert.strictEqual((await before(w, `u${w.u.userId}`, `u${w.t.userId}`, { RequestTime: sec, Sign: sign })).status, 200);
  assert.strictEqual((await before(w, `u${w.u.userId}`, `u${w.t.userId}`, { RequestTime: sec, Sign: 'bad' })).status, 403);
});

test('联系人：学员看到原老师与当日代班老师；老师各自看到学员', async () => {
  const w = await world();
  substituteOn(w, TODAY);
  const list = async (who) => (await w.ctx.api.get('/api/im/contacts').set(who.auth)).body;

  const mine = await list(w.u);
  assert.deepStrictEqual(mine.map((c) => [c.userId, c.role, c.substitute]), [
    [w.t.userId, 'teacher', false], [w.s.userId, 'teacher', true],
  ]);
  assert.strictEqual(mine[0].imId, `u${w.t.userId}`);
  assert.strictEqual(mine[0].name, `老师${w.t.userId}`);
  assert.deepStrictEqual((await list(w.t)).map((c) => [c.userId, c.role, c.substitute]), [[w.u.userId, 'student', false]]);
  assert.deepStrictEqual((await list(w.s)).map((c) => [c.userId, c.role, c.substitute]), [[w.u.userId, 'student', true]]);
  assert.deepStrictEqual(await list(w.x), []);
});
```

**Step 2: 运行，确认失败**

Run: `node --test tests/chat.test.js`
Expected: FAIL

**Step 3: 实现**

`server/src/services/chat.js`：

```js
const { loadSegments } = require('./relations');
const { segmentOn } = require('./segments');
const { imIdOf } = require('../tencent/usersig');

function todaySegment(db, relationId, today) {
  return segmentOn(loadSegments(db, relationId), today);
}

function linkOf(db, studentId, teacherId, today) {
  const rels = db.prepare("SELECT * FROM service_relations WHERE user_id = ? AND status = 'active' ORDER BY id").all(studentId);
  let found = null;
  for (const r of rels) {
    const seg = todaySegment(db, r.id, today);
    const responsible = seg && seg.kind !== 'paused' ? seg.teacher_id : null;
    const isOwner = r.teacher_id === teacherId;
    const isSubstitute = !!seg && seg.kind === 'substitute' && seg.teacher_id === teacherId;
    if (!isOwner && !isSubstitute) continue;
    const link = { relation: r, studentId, teacherId, responsible };
    if (responsible === teacherId) return link;
    found = found || link;
  }
  return found;
}

const resolvePair = (db, a, b, today) => linkOf(db, a, b, today) || linkOf(db, b, a, today);

function contactsOf(db, userId, today) {
  const out = new Map();
  const add = (id, role, substitute) => {
    if (!out.has(id)) out.set(id, { userId: id, imId: imIdOf(id), role, substitute });
  };

  for (const r of db.prepare("SELECT * FROM service_relations WHERE user_id = ? AND status = 'active' ORDER BY id").all(userId)) {
    add(r.teacher_id, 'teacher', false);
    const seg = todaySegment(db, r.id, today);
    if (seg && seg.kind === 'substitute') add(seg.teacher_id, 'teacher', true);
  }
  for (const r of db.prepare("SELECT user_id FROM service_relations WHERE teacher_id = ? AND status = 'active' ORDER BY id").all(userId)) {
    add(r.user_id, 'student', false);
  }
  for (const r of db.prepare(`SELECT r.user_id FROM service_relations r
                              JOIN service_segments s ON s.relation_id = r.id
                              WHERE r.status = 'active' AND s.kind = 'substitute' AND s.teacher_id = ?
                                AND s.start_date <= ? AND s.end_date >= ? ORDER BY r.id`).all(userId, today, today)) {
    add(r.user_id, 'student', true);
  }

  const teacherName = db.prepare('SELECT display_name FROM teacher_profiles WHERE user_id = ?');
  const nickname = db.prepare('SELECT nickname FROM users WHERE id = ?');
  return [...out.values()].map((c) => ({
    ...c,
    name: c.role === 'teacher' ? teacherName.get(c.userId).display_name : nickname.get(c.userId).nickname,
  }));
}

const textOf = (msgBody) => (Array.isArray(msgBody) ? msgBody : [])
  .filter((e) => e && e.MsgType === 'TIMTextElem')
  .map((e) => (e.MsgContent && e.MsgContent.Text) || '')
  .join('\n');

// 后续 Task 在此追加：发送后处理（关键词、回复时效）

module.exports = { resolvePair, contactsOf, textOf };
```

`server/src/routes/im.js`：
- 把 `require('../tencent/usersig')` 那一行改为
  `const { SIG_EXPIRE, imIdOf, parseImId, tencentMock, userSigFor } = require('../tencent/usersig');`
- 顶部再加入：

```js
const { todayCN } = require('../lib/dates');
const { verifyImSign } = require('../tencent/callback-auth');
const chat = require('../services/chat');

const IM_OK = { ActionStatus: 'OK', ErrorCode: 0, ErrorInfo: '' };
const IM_NO_SERVICE = { ActionStatus: 'OK', ErrorCode: 120001, ErrorInfo: '当前没有进行中的服务，无法发送消息' };
```

- 在 `// 后续 Task 在此追加 IM 回调（腾讯云调用，不走用户登录）` 下方加入：

```js
  router.post('/callback', (req, res) => {
    const nowMs = config.now();
    if (!verifyImSign(config.tencent.imCallbackToken, req.query, nowMs)) {
      return res.status(403).json({ ActionStatus: 'FAIL', ErrorCode: 1, ErrorInfo: 'invalid sign' });
    }
    const body = req.body || {};
    const from = parseImId(body.From_Account);
    const to = parseImId(body.To_Account);
    if (from && to && body.CallbackCommand === 'C2C.CallbackBeforeSendMsg') {
      if (!chat.resolvePair(db, from, to, todayCN(nowMs))) return res.json(IM_NO_SERVICE);
    }
    // 后续 Task 在此追加发送后回调处理
    res.json(IM_OK);
  });
```

- 在 `// 后续 Task 在此追加需登录的 IM 接口` 下方加入：

```js
  router.get('/contacts', (req, res) => {
    res.json(chat.contactsOf(db, req.userId, todayCN(config.now())));
  });
```

**Step 4: 运行，确认通过**

Run: `node --test tests/chat.test.js`
Expected: PASS（6 tests）

**Step 5: Commit**

```bash
git add server/src server/tests/chat.test.js
git commit -m "feat: 聊天权限、IM 发送前回调与联系人"
```

---

### Task 12: 危机词与私下交易提示、回复时效统计

**Files:**
- Create: `server/src/lib/keywords.js`
- Create: `server/src/services/replies.js`
- Modify: `server/src/services/chat.js`
- Modify: `server/src/routes/im.js`（`C2C.CallbackAfterSendMsg`）
- Modify: `server/src/routes/teacher.js`（`GET /reply-stats`）
- Test: `server/tests/chat-after-send.test.js`

**规则：**
- 只处理有聊天权限的消息（`resolvePair` 非空）。
- 危机词：写 `crisis_events`（`user_id` 为发送者），给发送者发热线提示（`config.crisisHotline`），并通知对方 `crisis_alert`。
- 私下交易（关键词或手机号）：写 `risk_events`，提示发送者。
- 回复时效：学员发给**当天负责老师**的消息开始计时（同一对已有未回复的计时则不重复）；老师给该学员发任意消息即结束。原老师请假暂停日不计时。
- 统计：区间内发起的计时中，已回复且未超过 `reply_hours` 算达标；未回复且已超时算未达标；未回复也未超时的不计入。

**Step 1: 写失败测试**

`server/tests/chat-after-send.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert');
const { setup, loginTeacher, loginAs, insertPackage, buyAndPay, FIXED_NOW, HOUR } = require('./helpers');
const { scanText } = require('../src/lib/keywords');
const { handleAfterSend } = require('../src/services/chat');
const { replyStats } = require('../src/services/replies');
const { loadSegments, saveSegments } = require('../src/services/relations');
const { applyPause } = require('../src/services/segments');

async function world() {
  const ctx = setup();
  const t = await loginTeacher(ctx, 't');
  const u = await loginAs(ctx, 'u');
  const x = await loginAs(ctx, 'x');
  const rel = buyAndPay(ctx, u.userId, insertPackage(ctx.db, t.userId, { reply_hours: 12 }));
  return { ctx, db: ctx.db, t, u, x, rel };
}
const send = (w, from, to, text, nowMs = FIXED_NOW) =>
  handleAfterSend(w.db, { from: from.userId, to: to.userId, text, nowMs, hotline: '12356' });
const types = (w, userId) => w.db.prepare('SELECT type, payload FROM notifications WHERE user_id = ? ORDER BY id').all(userId);
const count = (w, table) => w.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;

test('关键词扫描', () => {
  assert.deepStrictEqual(scanText('我真的不想活了'), { crisis: '不想活', privateTrade: null });
  assert.deepStrictEqual(scanText('加我微信吧'), { crisis: null, privateTrade: '微信' });
  assert.deepStrictEqual(scanText('打我电话13812345678'), { crisis: null, privateTrade: '13812345678' });
  assert.deepStrictEqual(scanText('加个VX'), { crisis: null, privateTrade: 'vx' });
  assert.deepStrictEqual(scanText('今天心情不错'), { crisis: null, privateTrade: null });
});

test('危机词：记录事件，给发送者热线提示，通知对方', async () => {
  const w = await world();
  send(w, w.u, w.t, '最近总想自杀');
  const e = w.db.prepare('SELECT * FROM crisis_events').get();
  assert.strictEqual(e.user_id, w.u.userId);
  assert.strictEqual(e.peer_id, w.t.userId);
  assert.strictEqual(e.keyword, '自杀');
  assert.strictEqual(e.status, 'open');
  const mine = types(w, w.u.userId);
  assert.strictEqual(mine[0].type, 'crisis_hotline');
  assert.strictEqual(JSON.parse(mine[0].payload).hotline, '12356');
  assert.strictEqual(types(w, w.t.userId)[0].type, 'crisis_alert');
});

test('私下交易：记录风险事件并提示发送者', async () => {
  const w = await world();
  send(w, w.t, w.u, '加我微信聊');
  const r = w.db.prepare('SELECT * FROM risk_events').get();
  assert.strictEqual(r.from_user_id, w.t.userId);
  assert.strictEqual(r.to_user_id, w.u.userId);
  assert.strictEqual(types(w, w.t.userId)[0].type, 'private_trade_warning');
});

test('没有服务关系的消息不处理', async () => {
  const w = await world();
  send(w, w.u, w.x, '想死');
  assert.strictEqual(count(w, 'crisis_events'), 0);
  assert.strictEqual(count(w, 'reply_waits'), 0);
});

test('回复时效：学员提问开始计时、老师回复结束；按承诺小时数统计达标率', async () => {
  const w = await world();
  const t0 = FIXED_NOW;
  send(w, w.u, w.t, '在吗', t0);
  send(w, w.u, w.t, '有个问题', t0 + 60000);
  assert.strictEqual(count(w, 'reply_waits'), 1);
  send(w, w.t, w.u, '在的', t0 + 2 * HOUR);
  assert.strictEqual(w.db.prepare('SELECT replied_ms FROM reply_waits').get().replied_ms, t0 + 2 * HOUR);

  const t1 = t0 + 3 * HOUR;
  send(w, w.u, w.t, '还有一个问题', t1);
  const range = { fromMs: t0, toMs: t0 + 24 * HOUR };
  assert.deepStrictEqual(replyStats(w.db, w.t.userId, { ...range, nowMs: t1 + 11 * HOUR }), { total: 1, onTime: 1, rate: 1 });
  assert.deepStrictEqual(replyStats(w.db, w.t.userId, { ...range, nowMs: t1 + 13 * HOUR }), { total: 2, onTime: 1, rate: 0.5 });
});

test('原老师当天暂停（请假）时，学员消息不计时', async () => {
  const w = await world();
  saveSegments(w.db, w.rel.id, applyPause(loadSegments(w.db, w.rel.id), { from: '2026-11-01', to: '2026-11-01' }));
  send(w, w.u, w.t, '老师好');
  assert.strictEqual(count(w, 'reply_waits'), 0);
});

test('HTTP：IM 发送后回调接入处理；老师查看回复时效统计', async () => {
  const w = await world();
  const res = await w.ctx.api.post('/api/im/callback').send({
    CallbackCommand: 'C2C.CallbackAfterSendMsg', From_Account: `u${w.u.userId}`, To_Account: `u${w.t.userId}`,
    MsgBody: [{ MsgType: 'TIMTextElem', MsgContent: { Text: '我不想活了' } }],
  });
  assert.strictEqual(res.body.ErrorCode, 0);
  assert.strictEqual(count(w, 'crisis_events'), 1);
  assert.strictEqual(count(w, 'reply_waits'), 1);

  w.ctx.config.now = () => FIXED_NOW + 13 * HOUR;
  const stats = await w.ctx.api.get('/api/teacher/reply-stats').query({ from: '2026-11-01', to: '2026-11-01' }).set(w.t.auth);
  assert.deepStrictEqual(stats.body, { from: '2026-11-01', to: '2026-11-01', total: 1, onTime: 0, rate: 0 });
});
```

**Step 2: 运行，确认失败**

Run: `node --test tests/chat-after-send.test.js`
Expected: FAIL

**Step 3: 实现**

`server/src/lib/keywords.js`：

```js
const CRISIS_WORDS = ['自杀', '轻生', '不想活', '想死', '活不下去', '结束生命', '割腕', '跳楼', '自残'];
const PRIVATE_WORDS = ['微信', 'vx', 'v信', '加我', '私下', '转账', '支付宝', 'qq'];
const PHONE = /1[3-9]\d{9}/;

function scanText(text) {
  const t = String(text || '').toLowerCase();
  const crisis = CRISIS_WORDS.find((k) => t.includes(k)) || null;
  const phone = PHONE.exec(t);
  const privateTrade = PRIVATE_WORDS.find((k) => t.includes(k)) || (phone ? phone[0] : null);
  return { crisis, privateTrade };
}

module.exports = { scanText };
```

`server/src/services/replies.js`：

```js
const HOUR = 3600 * 1000;

function onMessage(db, pair, fromId, nowMs) {
  if (fromId === pair.studentId) {
    if (pair.responsible !== pair.teacherId) return;
    const open = db.prepare('SELECT 1 FROM reply_waits WHERE teacher_id = ? AND user_id = ? AND replied_ms IS NULL')
      .get(pair.teacherId, pair.studentId);
    if (!open) {
      db.prepare(`INSERT INTO reply_waits (teacher_id, user_id, relation_id, reply_hours, asked_ms)
                  VALUES (?, ?, ?, ?, ?)`)
        .run(pair.teacherId, pair.studentId, pair.relation.id, pair.relation.reply_hours, nowMs);
    }
  } else {
    db.prepare('UPDATE reply_waits SET replied_ms = ? WHERE teacher_id = ? AND user_id = ? AND replied_ms IS NULL')
      .run(nowMs, pair.teacherId, pair.studentId);
  }
}

function replyStats(db, teacherId, { fromMs, toMs, nowMs }) {
  const rows = db.prepare('SELECT * FROM reply_waits WHERE teacher_id = ? AND asked_ms >= ? AND asked_ms < ?')
    .all(teacherId, fromMs, toMs);
  let total = 0;
  let onTime = 0;
  for (const r of rows) {
    const deadline = r.asked_ms + r.reply_hours * HOUR;
    if (r.replied_ms != null) {
      total += 1;
      if (r.replied_ms <= deadline) onTime += 1;
    } else if (nowMs > deadline) {
      total += 1;
    }
  }
  return { total, onTime, rate: total ? onTime / total : null };
}

module.exports = { onMessage, replyStats };
```

`server/src/services/chat.js`：顶部加入

```js
const { todayCN } = require('../lib/dates');
const { notify } = require('../lib/notify');
const { scanText } = require('../lib/keywords');
const replies = require('./replies');
```

在 `// 后续 Task 在此追加：发送后处理（关键词、回复时效）` 下方加入：

```js
function handleAfterSend(db, { from, to, text, nowMs, hotline }) {
  const pair = resolvePair(db, from, to, todayCN(nowMs));
  if (!pair) return;
  const excerpt = String(text || '').slice(0, 200);
  const { crisis, privateTrade } = scanText(text);
  db.transaction(() => {
    if (crisis) {
      const eventId = db.prepare('INSERT INTO crisis_events (user_id, peer_id, keyword, excerpt) VALUES (?, ?, ?, ?)')
        .run(from, to, crisis, excerpt).lastInsertRowid;
      notify(db, from, 'crisis_hotline', { hotline });
      notify(db, to, 'crisis_alert', { eventId, fromUserId: from });
    }
    if (privateTrade) {
      db.prepare('INSERT INTO risk_events (from_user_id, to_user_id, keyword, excerpt) VALUES (?, ?, ?, ?)')
        .run(from, to, privateTrade, excerpt);
      notify(db, from, 'private_trade_warning', { keyword: privateTrade });
    }
    replies.onMessage(db, pair, from, nowMs);
  })();
}
```

导出改为 `module.exports = { resolvePair, contactsOf, textOf, handleAfterSend };`

`server/src/routes/im.js` 在 `// 后续 Task 在此追加发送后回调处理` 下方加入：

```js
    if (from && to && body.CallbackCommand === 'C2C.CallbackAfterSendMsg') {
      chat.handleAfterSend(db, { from, to, text: chat.textOf(body.MsgBody), nowMs, hotline: config.crisisHotline });
    }
```

`server/src/routes/teacher.js` 顶部加：

```js
const { addDays, todayCN, isDate, cnMs } = require('../lib/dates');
const { replyStats } = require('../services/replies');
```

追加：

```js
  router.get('/reply-stats', (req, res) => {
    requireActiveTeacher(req);
    const nowMs = config.now();
    const to = isDate(req.query.to) ? req.query.to : todayCN(nowMs);
    const from = isDate(req.query.from) ? req.query.from : addDays(to, -29);
    res.json({ from, to, ...replyStats(db, req.userId, { fromMs: cnMs(from), toMs: cnMs(addDays(to, 1)), nowMs }) });
  });
```

**Step 4: 运行，确认通过**

Run: `node --test tests/chat-after-send.test.js tests/chat.test.js`
Expected: PASS（7 + 6）

**Step 5: Commit**

```bash
git add server/src server/tests/chat-after-send.test.js
git commit -m "feat: 危机词与私下交易提示、回复时效统计"
```

---

### Task 13: 高频定时任务接入 + 第二阶段全链路测试

**Files:**
- Modify: `server/src/jobs.js`（整文件替换）
- Test: `server/tests/phase2-flow.test.js`

**说明：** 第一阶段的每日任务每小时跑一次；本阶段新增的过期 / 爽约 / 自动完成 / 自动确认需要分钟级，新增 `runFrequentJobs`，每 60 秒跑一次。

**Step 1: 写失败测试**

`server/tests/phase2-flow.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert');
const { setup, loginTeacher, loginAs, insertPackage, buyAndPay, FIXED_NOW, HOUR } = require('./helpers');
const { setSchedule } = require('../src/services/schedule');
const appts = require('../src/services/appointments');
const leaves = require('../src/services/leaves');
const { runDailyJobs, runFrequentJobs } = require('../src/jobs');

const MIN = 60000;

test('runFrequentJobs 汇总各高频任务', async () => {
  const ctx = setup();
  const t = await loginTeacher(ctx, 't');
  const s = await loginTeacher(ctx, 's');
  const u = await loginAs(ctx, 'u');
  setSchedule(ctx.db, t.userId, [{ weekday: 1, start: '09:00', end: '12:00' }]);
  const rel = buyAndPay(ctx, u.userId, insertPackage(ctx.db, t.userId));
  const a = appts.book(ctx.db, { userId: u.userId, relationId: rel.id, date: '2026-11-02', start: '10:00', nowMs: FIXED_NOW });
  leaves.createLeave(ctx.db, { teacherId: t.userId, startDate: '2026-11-10', endDate: '2026-11-12', candidateIds: [s.userId], nowMs: FIXED_NOW });

  assert.deepStrictEqual(runFrequentJobs(ctx.db, a.start_ms + 15 * MIN),
    { expiredChoices: 0, noShows: 1, autoCompleted: 0, autoConfirmed: 0 });
  assert.deepStrictEqual(runFrequentJobs(ctx.db, FIXED_NOW + 48 * HOUR),
    { expiredChoices: 1, noShows: 0, autoCompleted: 0, autoConfirmed: 0 });
});

test('全链路：排班 → 购买 → 预约 → 请假取消预约 → 选代班 → 与代班通话 → 计提归属', async () => {
  const ctx = setup();
  const t = await loginTeacher(ctx, 't');
  const s = await loginTeacher(ctx, 's');
  const u = await loginAs(ctx, 'u');
  await ctx.api.put('/api/teacher/schedule').set(t.auth).send({ items: [{ weekday: 2, start: '09:00', end: '12:00' }] });
  await ctx.api.put('/api/teacher/schedule').set(s.auth).send({ items: [{ weekday: 2, start: '14:00', end: '16:00' }] });
  const pkg = (await ctx.api.post('/api/teacher/packages').set(t.auth)
    .send({ type: 'month', title: '包月', priceCents: 3000, callQuota: 4, replyHours: 12 })).body;
  const order = (await ctx.api.post('/api/orders').set(u.auth).send({ packageId: pkg.id })).body;
  await ctx.api.post(`/api/pay/mock/confirm?out_trade_no=${order.outTradeNo}`);
  const rel = (await ctx.api.get('/api/relations').set(u.auth)).body[0];

  const first = (await ctx.api.post('/api/appointments').set(u.auth)
    .send({ relationId: rel.id, date: '2026-11-10', start: '10:00' })).body;
  assert.strictEqual(first.teacher_id, t.userId);

  const leave = (await ctx.api.post('/api/teacher/leaves').set(t.auth)
    .send({ startDate: '2026-11-10', endDate: '2026-11-12', candidateIds: [s.userId] })).body;
  assert.strictEqual(appts.getAppointment(ctx.db, first.id).status, 'cancelled');
  await ctx.api.post(`/api/teacher/substitute-invites/${leave.id}/respond`).set(s.auth).send({ accept: true });

  const [choice] = (await ctx.api.get('/api/leave-choices').set(u.auth)).body;
  await ctx.api.post(`/api/leave-choices/${choice.id}`).set(u.auth).send({ action: 'substitute', teacherId: s.userId });

  const slots = await ctx.api.get('/api/appointments/slots').query({ relationId: rel.id, date: '2026-11-10' }).set(u.auth);
  assert.strictEqual(slots.body.teacherId, s.userId);
  const second = (await ctx.api.post('/api/appointments').set(u.auth)
    .send({ relationId: rel.id, date: '2026-11-10', start: '14:00' })).body;
  assert.strictEqual(second.teacher_id, s.userId);

  ctx.config.now = () => second.start_ms - 5 * MIN;
  const contacts = (await ctx.api.get('/api/im/contacts').set(u.auth)).body.map((c) => c.userId);
  assert.deepStrictEqual(contacts, [t.userId, s.userId]);
  await ctx.api.post(`/api/teacher/appointments/${second.id}/join`).set(s.auth);
  await ctx.api.post(`/api/appointments/${second.id}/join`).set(u.auth);
  runFrequentJobs(ctx.db, second.end_ms + 30 * MIN);
  assert.strictEqual(appts.getAppointment(ctx.db, second.id).status, 'completed');

  runDailyJobs(ctx.db, '2026-12-01');
  const sum = (id) => ctx.db.prepare('SELECT COALESCE(SUM(amount_cents),0) s FROM accruals WHERE teacher_id = ?').get(id).s;
  assert.strictEqual(sum(s.userId), 300);
  assert.strictEqual(sum(t.userId), 2700);
  const r = ctx.db.prepare('SELECT calls_left, status FROM service_relations').get();
  assert.deepStrictEqual(r, { calls_left: 3, status: 'ended' });
});
```

**Step 2: 运行，确认失败**

Run: `node --test tests/phase2-flow.test.js`
Expected: FAIL（`runFrequentJobs is not a function`）

**Step 3: 实现**

`server/src/jobs.js` 整文件替换为：

```js
const { addDays, todayCN } = require('./lib/dates');
const { accrueUpTo } = require('./services/accrual');
const { markNoShows, autoComplete, autoConfirm } = require('./services/appointments');
const { expireChoices } = require('./services/leaves');

function runDailyJobs(db, today) {
  const accrued = accrueUpTo(db, addDays(today, -1));
  const ended = db.prepare(`UPDATE service_relations SET status = 'ended'
                            WHERE status = 'active' AND frozen = 0 AND end_date < ?`).run(today).changes;
  return { accrued, ended };
}

function runFrequentJobs(db, nowMs) {
  return {
    expiredChoices: expireChoices(db, nowMs),
    noShows: markNoShows(db, nowMs),
    autoCompleted: autoComplete(db, nowMs),
    autoConfirmed: autoConfirm(db, nowMs),
  };
}

function startJobs(db, config) {
  const guard = (name, fn) => () => {
    try {
      const r = fn();
      if (Object.values(r).some(Boolean)) console.log(`[jobs:${name}]`, r);
    } catch (e) {
      console.error(`[jobs:${name}] 执行失败`, e);
    }
  };
  const daily = guard('daily', () => runDailyJobs(db, todayCN(config.now())));
  const frequent = guard('frequent', () => runFrequentJobs(db, config.now()));
  daily();
  frequent();
  return [setInterval(daily, 3600 * 1000), setInterval(frequent, 60 * 1000)];
}

module.exports = { runDailyJobs, runFrequentJobs, startJobs };
```

**Step 4: 全量测试**

Run: `cd /data/workspace/ngr/wx/LiaoYu/server && npm test`
Expected: 全部 PASS，0 fail（第一阶段约 60 + 第二阶段约 66）

**Step 5: 冒烟**

```bash
cd /data/workspace/ngr/wx/LiaoYu/server
DB_FILE=/tmp/liaoyu-smoke2.db PORT=8712 node src/index.js &
sleep 1
TOKEN=$(curl -s -X POST http://localhost:8712/api/auth/wxlogin -H 'Content-Type: application/json' -d '{"code":"smoke"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s http://localhost:8712/api/im/usersig -H "Authorization: Bearer $TOKEN"
curl -s http://localhost:8712/api/notifications -H "Authorization: Bearer $TOKEN"
kill %1; rm -f /tmp/liaoyu-smoke2.db*
```

Expected: `usersig` 返回 `{"mock":true,...,"userSig":"mock",...}`；通知返回 `[]`。

**Step 6: Commit**

```bash
git add server/src/jobs.js server/tests/phase2-flow.test.js
git commit -m "feat: 高频定时任务与第二阶段全链路测试"
```

---

## 第二阶段完成标准

- `npm test` 全绿。
- MOCK 模式下可走通：老师排班 → 学员购买 → 预约通话 → 老师请假（预约自动取消、学员暂停顺延）→ 候选老师接受 → 学员选代班 → 与代班老师进入通话 → 自动完成 → 日计提代班日归代班老师。
- 单次套餐：通话完成 → 用户确认或 48 小时自动确认 → 全额计提并进入周结算。
- 配置 `TENCENT_SDKAPPID / TENCENT_SECRETKEY / IM_CALLBACK_TOKEN / TRTC_CALLBACK_KEY` 后：小程序可用 UserSig 登录 IM 与进入 TRTC 房间；IM 发送前回调拦截无服务关系的消息；TRTC 房间回调驱动通话完成。

## 腾讯云控制台配置（上线前）

- IM：开启「发单聊消息之前」「发单聊消息之后」回调，回调地址 `${PUBLIC_BASE_URL}/api/im/callback`，配置鉴权 Token = `IM_CALLBACK_TOKEN`。
- TRTC：开启房间事件回调，地址 `${PUBLIC_BASE_URL}/api/trtc/callback`，回调密钥 = `TRTC_CALLBACK_KEY`。

## 已知遗留（后续阶段处理）

- 危机事件 / 私下交易风险的管理端查看与处理记录（第五阶段，表已就绪）。
- 单次通话异议的工单处理（第五阶段）。
- 小程序订阅消息推送（第四阶段，站内通知已就绪）。
- IM 内容安全检测（不做）。
- 撤销请假、改期请假（MVP 不支持）。
- 爽约次数、通话准时率、回复时效达标率汇入月度等级建议（第五阶段，数据已采集）。
