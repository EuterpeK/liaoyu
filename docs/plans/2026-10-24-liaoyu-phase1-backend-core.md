# LiaoYu 第一阶段：后端核心 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 搭建 LiaoYu 后端，打通「微信登录 → 老师入驻审核 → 套餐 → 下单付款（ZPAY）→ 服务关系与分段 → 日计提 → 周结算人工打款登记 → 订单统计导出」的资金闭环。

**Architecture:** Node.js + Express 单进程服务，SQLite（better-sqlite3）独立数据库。路由以工厂函数 `(db, config) => router` 注入依赖，便于用内存库测试。金额全程用整数「分」。服务关系有效期拆成「服务分段」（normal / substitute / paused），日计提只看当天所在分段，代班与暂停复用同一逻辑。

**Tech Stack:** Node 20、Express 4、better-sqlite3、jsonwebtoken、bcryptjs；测试用 `node:test` + supertest。

**设计文档：** `docs/plans/2026-10-24-liaoyu-platform-design.md`

---

## 阶段路线图（本文件只覆盖第一阶段）

| 阶段 | 内容 | 计划文件 |
|---|---|---|
| **1. 后端核心** | 登录、入驻审核、套餐、下单付款、服务关系/分段、计提、结算、订单导出 | 本文件 |
| 2. 服务交付 | 请假与代班 API、通话预约 + TRTC、单次套餐按通话计提、腾讯云 IM（UserSig、消息回调：内容安全/危机词/私下交易）、回复时效统计 | 待写 |
| 3. 管理网页 | Vue3 + Element Plus：登录、老师审核定级、订单查询导出、结算打款登记、抽成配置 | 待写 |
| 4. 小程序 | 原生 + TS：登录、老师列表/详情、下单复制支付链接、我的服务、IM、预约、老师工作台 | 待写 |
| 5. 运营与风控 | 工单（退款/换师/投诉 + 冻结）、评价、等级月度建议、危机事件处理、数据看板 | 待写 |

---

## 约定

- 项目根：`/data/workspace/ngr/wx/LiaoYu`，后端目录：`/data/workspace/ngr/wx/LiaoYu/server`（下文路径均相对 `server/`）。
- 运行单个测试：`cd /data/workspace/ngr/wx/LiaoYu/server && node --test tests/<file>.test.js`
- 运行全部测试：`cd /data/workspace/ngr/wx/LiaoYu/server && npm test`
- 日期一律为 `YYYY-MM-DD` 字符串（北京时间），可直接字符串比较。
- 测试固定时钟：`2026-11-01T04:00:00Z`（北京时间 2026-11-01 12:00）。
- 每个 Task 结束都提交一次 git。

---

### Task 1: 项目脚手架 + 健康检查

**Files:**
- Create: `server/package.json`
- Create: `server/src/app.js`
- Create: `server/src/config.js`
- Create: `server/src/lib/errors.js`
- Create: `.gitignore`
- Create: `README.md`
- Test: `server/tests/health.test.js`

**Step 1: 写 package.json 并安装依赖**

```json
{
  "name": "liaoyu-server",
  "version": "0.1.0",
  "private": true,
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js",
    "test": "node --test",
    "create-admin": "node scripts/create-admin.js"
  },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "better-sqlite3": "^12.9.0",
    "express": "^4.18.2",
    "jsonwebtoken": "^9.0.2"
  },
  "devDependencies": {
    "supertest": "^7.0.0"
  }
}
```

`.gitignore`（项目根）：

```
node_modules/
server/data/
*.db
*.db-wal
*.db-shm
```

Run: `cd /data/workspace/ngr/wx/LiaoYu/server && npm install`
Expected: 安装成功，无 ERR。

**Step 2: 写失败测试**

`server/tests/health.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');

test('GET /api/health 返回 ok', async () => {
  const app = createApp({ db: null, config: loadConfig({}) });
  const res = await request(app).get('/api/health');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { ok: true });
});

test('未知错误返回 500，HttpError 返回对应状态码', async () => {
  const { HttpError } = require('../src/lib/errors');
  const app = createApp({ db: null, config: loadConfig({}) });
  app.get('/boom', () => { throw new HttpError(418, '茶壶'); });
  app.use(require('../src/app').errorHandler);
  const res = await request(app).get('/boom');
  assert.strictEqual(res.status, 418);
  assert.strictEqual(res.body.error, '茶壶');
});
```

**Step 3: 运行，确认失败**

Run: `node --test tests/health.test.js`
Expected: FAIL，`Cannot find module '../src/app'`

**Step 4: 最小实现**

`server/src/lib/errors.js`：

```js
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { HttpError, wrap };
```

`server/src/config.js`：

```js
const path = require('path');

function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 8700),
    dbFile: env.DB_FILE || path.join(__dirname, '..', 'data', 'liaoyu.db'),
    jwtSecret: env.JWT_SECRET || 'dev-user-secret',
    adminJwtSecret: env.ADMIN_JWT_SECRET || 'dev-admin-secret',
    publicBaseUrl: (env.PUBLIC_BASE_URL || 'http://localhost:8700').replace(/\/+$/, ''),
    zpay: {
      pid: env.ZPAY_PID || '',
      key: env.ZPAY_KEY || '',
      gateway: (env.ZPAY_GATEWAY || 'https://z-pay.cn').replace(/\/+$/, ''),
    },
    wx: { appid: env.WX_APPID || '', secret: env.WX_APPSECRET || '' },
    now: () => Date.now(),
  };
}

module.exports = { loadConfig };
```

`server/src/app.js`：

```js
const express = require('express');
const { HttpError } = require('./lib/errors');

function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: '请求体格式错误' });
  console.error(err);
  res.status(500).json({ error: '服务器错误' });
}

function createApp({ db, config }) {
  const app = express();
  app.use(express.json());

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  // 后续 Task 在此挂载路由

  app.use(errorHandler);
  return app;
}

module.exports = { createApp, errorHandler };
```

`README.md`（项目根）：

```markdown
# LiaoYu

咨询陪伴服务平台：微信小程序（用户/老师）+ 负责人管理网页 + Node.js 后端。

- 设计文档：`docs/plans/2026-10-24-liaoyu-platform-design.md`
- 后端：`server/`

## 后端开发

    cd server
    npm install
    npm test
    npm run create-admin -- <用户名> <密码>
    npm run dev   # 默认端口 8700

未配置 `ZPAY_PID/ZPAY_KEY` 时支付走本地 MOCK 收银台；未配置 `WX_APPSECRET` 时微信登录走 MOCK。
```

**Step 5: 运行，确认通过**

Run: `node --test tests/health.test.js`
Expected: PASS（2 tests）

**Step 6: Commit**

```bash
cd /data/workspace/ngr/wx/LiaoYu
git add .gitignore README.md server/package.json server/package-lock.json server/src server/tests
git commit -m "chore: 后端脚手架与健康检查"
```

---

### Task 2: 日期与金额工具

**Files:**
- Create: `server/src/lib/dates.js`
- Create: `server/src/lib/money.js`
- Test: `server/tests/lib.test.js`

**Step 1: 写失败测试**

```js
const test = require('node:test');
const assert = require('node:assert');
const { addDays, diffDays, eachDay, todayCN } = require('../src/lib/dates');
const { splitEvenly, centsToYuan, yuanStrToCents } = require('../src/lib/money');

test('addDays 跨月', () => {
  assert.strictEqual(addDays('2026-01-31', 1), '2026-02-01');
  assert.strictEqual(addDays('2026-03-01', -1), '2026-02-28');
});

test('diffDays 与 eachDay', () => {
  assert.strictEqual(diffDays('2026-02-27', '2026-03-01'), 2);
  assert.deepStrictEqual(eachDay('2026-02-27', '2026-03-01'), ['2026-02-27', '2026-02-28', '2026-03-01']);
  assert.deepStrictEqual(eachDay('2026-03-02', '2026-03-01'), []);
});

test('todayCN 按北京时间取日期', () => {
  assert.strictEqual(todayCN(Date.parse('2026-10-24T17:00:00Z')), '2026-10-25');
  assert.strictEqual(todayCN(Date.parse('2026-10-24T15:59:59Z')), '2026-10-24');
});

test('splitEvenly 余数分摊到前几天且总和不变', () => {
  assert.strictEqual(splitEvenly(1000, 3, 0), 334);
  assert.strictEqual(splitEvenly(1000, 3, 1), 333);
  assert.strictEqual(splitEvenly(1000, 3, 2), 333);
  let sum = 0;
  for (let i = 0; i < 30; i++) sum += splitEvenly(1000, 30, i);
  assert.strictEqual(sum, 1000);
});

test('元/分换算', () => {
  assert.strictEqual(centsToYuan(1999), '19.99');
  assert.strictEqual(yuanStrToCents('19.99'), 1999);
  assert.strictEqual(yuanStrToCents('30'), 3000);
});
```

**Step 2: 运行，确认失败**

Run: `node --test tests/lib.test.js`
Expected: FAIL，`Cannot find module`

**Step 3: 实现**

`server/src/lib/dates.js`：

```js
const DAY_MS = 86400000;

const parse = (d) => {
  const [y, m, dd] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, dd);
};
const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);

const addDays = (d, n) => fmt(parse(d) + n * DAY_MS);
const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / DAY_MS);

function eachDay(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

const todayCN = (nowMs = Date.now()) => fmt(nowMs + 8 * 3600 * 1000);

module.exports = { addDays, diffDays, eachDay, todayCN };
```

`server/src/lib/money.js`：

```js
function splitEvenly(totalCents, n, index) {
  const base = Math.floor(totalCents / n);
  const rem = totalCents - base * n;
  return base + (index < rem ? 1 : 0);
}

const centsToYuan = (c) => (c / 100).toFixed(2);
const yuanStrToCents = (s) => Math.round(parseFloat(s) * 100);

module.exports = { splitEvenly, centsToYuan, yuanStrToCents };
```

**Step 4: 运行，确认通过**

Run: `node --test tests/lib.test.js`
Expected: PASS（5 tests）

**Step 5: Commit**

```bash
git add server/src/lib server/tests/lib.test.js
git commit -m "feat: 日期与金额工具"
```

---

### Task 3: 数据库 schema

**Files:**
- Create: `server/src/schema.sql`
- Create: `server/src/db.js`
- Test: `server/tests/db.test.js`

**Step 1: 写失败测试**

```js
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');

test('openDb 建好全部表并开启外键', () => {
  const db = openDb(':memory:');
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of ['users', 'teacher_profiles', 'packages', 'orders', 'service_relations',
    'service_segments', 'accruals', 'settlements', 'admins', 'audit_logs', 'settings']) {
    assert.ok(names.includes(t), `缺少表 ${t}`);
  }
  assert.strictEqual(db.pragma('foreign_keys', { simple: true }), 1);
});

test('accruals 对 (relation_id, date) 唯一', () => {
  const db = openDb(':memory:');
  const idx = db.prepare("SELECT sql FROM sqlite_master WHERE name='accruals'").get().sql;
  assert.match(idx, /UNIQUE\s*\(\s*relation_id\s*,\s*date\s*\)/);
});
```

**Step 2: 运行，确认失败**

Run: `node --test tests/db.test.js`
Expected: FAIL

**Step 3: 实现**

`server/src/schema.sql`：

```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  openid TEXT NOT NULL UNIQUE,
  nickname TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS teacher_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  display_name TEXT NOT NULL,
  real_name TEXT NOT NULL,
  intro TEXT NOT NULL DEFAULT '',
  directions TEXT NOT NULL DEFAULT '[]',
  credentials TEXT NOT NULL DEFAULT '[]',
  level INTEGER NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 5),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','rejected','disabled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('single','month','quarter','year')),
  title TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  days INTEGER NOT NULL,
  call_quota INTEGER NOT NULL DEFAULT 0,
  reply_hours INTEGER NOT NULL DEFAULT 24,
  on_sale INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  out_trade_no TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  package_id INTEGER NOT NULL REFERENCES packages(id),
  package_snapshot TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  pay_provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid')),
  trade_no TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_teacher ON orders(teacher_id);

CREATE TABLE IF NOT EXISTS service_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  package_type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  total_days INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  calls_left INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended','refunded','switched')),
  frozen INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rel_user ON service_relations(user_id);
CREATE INDEX IF NOT EXISTS idx_rel_teacher ON service_relations(teacher_id);

CREATE TABLE IF NOT EXISTS service_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  relation_id INTEGER NOT NULL REFERENCES service_relations(id),
  kind TEXT NOT NULL CHECK (kind IN ('normal','substitute','paused')),
  teacher_id INTEGER REFERENCES users(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seg_rel ON service_segments(relation_id);

CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  gross_cents INTEGER NOT NULL,
  commission_cents INTEGER NOT NULL,
  net_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid')),
  proof TEXT,
  operator_id INTEGER,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accruals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  relation_id INTEGER NOT NULL REFERENCES service_relations(id),
  date TEXT NOT NULL,
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  settlement_id INTEGER REFERENCES settlements(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (relation_id, date)
);
CREATE INDEX IF NOT EXISTS idx_acc_teacher_date ON accruals(teacher_id, date);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

`server/src/db.js`：

```js
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function openDb(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  return db;
}

module.exports = { openDb };
```

**Step 4: 运行，确认通过**

Run: `node --test tests/db.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add server/src/schema.sql server/src/db.js server/tests/db.test.js
git commit -m "feat: 数据库 schema"
```

---

### Task 4: 测试辅助 + 微信登录 + /me

**Files:**
- Create: `server/tests/helpers.js`
- Create: `server/src/wechat.js`
- Create: `server/src/middleware/auth.js`
- Create: `server/src/routes/auth.js`
- Modify: `server/src/app.js`（挂载 `/api/auth`）
- Test: `server/tests/auth.test.js`

**Step 1: 写测试辅助**

`server/tests/helpers.js`（后续 Task 会用到其中的全部函数）：

```js
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');

const FIXED_NOW = Date.parse('2026-11-01T04:00:00Z'); // 北京时间 2026-11-01 12:00

function setup({ config: override = {} } = {}) {
  const db = openDb(':memory:');
  const config = { ...loadConfig({}), publicBaseUrl: 'http://test.local', now: () => FIXED_NOW, ...override };
  const app = createApp({ db, config });
  return { db, config, app, api: request(app) };
}

function insertUser(db, openid) {
  return db.prepare('INSERT INTO users (openid) VALUES (?)').run(openid).lastInsertRowid;
}

function makeTeacherProfile(db, userId, { level = 2, status = 'active', directions = ['情感'] } = {}) {
  db.prepare(`INSERT INTO teacher_profiles (user_id, display_name, real_name, directions, level, status)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(userId, `老师${userId}`, `实名${userId}`, JSON.stringify(directions), level, status);
}

function insertTeacher(db, openid, opts) {
  const id = insertUser(db, openid);
  makeTeacherProfile(db, id, opts);
  return id;
}

function insertPackage(db, teacherId, o = {}) {
  const p = { type: 'month', title: '包月陪伴', price_cents: 3000, days: 30, call_quota: 4, reply_hours: 12, on_sale: 1, ...o };
  return db.prepare(`INSERT INTO packages (teacher_id, type, title, price_cents, days, call_quota, reply_hours, on_sale)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(teacherId, p.type, p.title, p.price_cents, p.days, p.call_quota, p.reply_hours, p.on_sale).lastInsertRowid;
}

async function loginUser(ctx, code) {
  const res = await ctx.api.post('/api/auth/wxlogin').send({ code });
  return { token: res.body.token, userId: res.body.user.id };
}

async function adminToken(ctx, username = 'boss', password = 'pw') {
  ctx.db.prepare('INSERT OR IGNORE INTO admins (username, password_hash) VALUES (?, ?)')
    .run(username, bcrypt.hashSync(password, 4));
  const res = await ctx.api.post('/api/admin/login').send({ username, password });
  return res.body.token;
}

function buyAndPay(ctx, userId, packageId) {
  const { createOrder, fulfillOrder } = require('../src/services/orders');
  const order = createOrder(ctx.db, { userId, packageId, provider: 'zpay', nowMs: ctx.config.now() });
  fulfillOrder(ctx.db, order.out_trade_no, { tradeNo: 'T', paidCents: order.amount_cents, nowMs: ctx.config.now() });
  return ctx.db.prepare('SELECT * FROM service_relations WHERE order_id = ?').get(order.id);
}

module.exports = {
  FIXED_NOW, setup, insertUser, makeTeacherProfile, insertTeacher, insertPackage,
  loginUser, adminToken, buyAndPay,
};
```

**Step 2: 写失败测试**

`server/tests/auth.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert');
const { setup, loginUser } = require('./helpers');

test('同一 code 登录得到同一用户（MOCK 模式）', async () => {
  const ctx = setup();
  const a = await loginUser(ctx, 'code-1');
  const b = await loginUser(ctx, 'code-1');
  assert.ok(a.token);
  assert.strictEqual(a.userId, b.userId);
});

test('缺少 code 返回 400', async () => {
  const ctx = setup();
  const res = await ctx.api.post('/api/auth/wxlogin').send({});
  assert.strictEqual(res.status, 400);
});

test('/api/auth/me 需要登录，返回用户与老师身份', async () => {
  const ctx = setup();
  assert.strictEqual((await ctx.api.get('/api/auth/me')).status, 401);
  const { token, userId } = await loginUser(ctx, 'code-1');
  const res = await ctx.api.get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.user.id, userId);
  assert.strictEqual(res.body.teacher, null);
});
```

**Step 3: 运行，确认失败**

Run: `node --test tests/auth.test.js`
Expected: FAIL（404 或 module not found）

**Step 4: 实现**

`server/src/wechat.js`：

```js
const crypto = require('crypto');
const { HttpError } = require('./lib/errors');

function createWechat(wx) {
  const isMock = !wx.secret;

  async function code2Session(code) {
    if (!code) throw new HttpError(400, 'code 不能为空');
    if (isMock) {
      const h = crypto.createHash('sha1').update(`mock:${code}`).digest('hex');
      return { openid: `mock_${h.slice(0, 24)}` };
    }
    const url = 'https://api.weixin.qq.com/sns/jscode2session'
      + `?appid=${wx.appid}&secret=${wx.secret}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
    const data = await (await fetch(url)).json();
    if (data.errcode) throw new HttpError(401, `微信登录失败: ${data.errmsg || data.errcode}`);
    return { openid: data.openid };
  }

  return { isMock, code2Session };
}

module.exports = { createWechat };
```

`server/src/middleware/auth.js`：

```js
const jwt = require('jsonwebtoken');

function bearer(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return m ? m[1] : null;
}

function userAuth(config) {
  return (req, res, next) => {
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: '未登录' });
    try {
      const p = jwt.verify(token, config.jwtSecret);
      if (p.typ !== 'user') throw new Error('typ');
      req.userId = p.uid;
      next();
    } catch {
      res.status(401).json({ error: '登录已失效' });
    }
  };
}

function adminAuth(config) {
  return (req, res, next) => {
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: '未登录' });
    try {
      const p = jwt.verify(token, config.adminJwtSecret);
      if (p.typ !== 'admin') throw new Error('typ');
      req.adminId = p.aid;
      next();
    } catch {
      res.status(401).json({ error: '登录已失效' });
    }
  };
}

const signUser = (config, uid) => jwt.sign({ uid, typ: 'user' }, config.jwtSecret, { expiresIn: '30d' });
const signAdmin = (config, aid) => jwt.sign({ aid, typ: 'admin' }, config.adminJwtSecret, { expiresIn: '12h' });

module.exports = { userAuth, adminAuth, signUser, signAdmin };
```

`server/src/routes/auth.js`：

```js
const express = require('express');
const { wrap } = require('../lib/errors');
const { createWechat } = require('../wechat');
const { userAuth, signUser } = require('../middleware/auth');

module.exports = (db, config) => {
  const router = express.Router();
  const wechat = createWechat(config.wx);

  router.post('/wxlogin', wrap(async (req, res) => {
    const { openid } = await wechat.code2Session(req.body && req.body.code);
    db.prepare('INSERT OR IGNORE INTO users (openid) VALUES (?)').run(openid);
    const user = db.prepare('SELECT id, nickname FROM users WHERE openid = ?').get(openid);
    res.json({ token: signUser(config, user.id), user });
  }));

  router.get('/me', userAuth(config), (req, res) => {
    const user = db.prepare('SELECT id, nickname FROM users WHERE id = ?').get(req.userId);
    const teacher = db.prepare('SELECT status, level, display_name FROM teacher_profiles WHERE user_id = ?')
      .get(req.userId) || null;
    res.json({ user, teacher });
  });

  return router;
};
```

`server/src/app.js` 在注释 `// 后续 Task 在此挂载路由` 下方加入：

```js
  app.use('/api/auth', require('./routes/auth')(db, config));
```

**Step 5: 运行，确认通过**

Run: `node --test tests/auth.test.js`
Expected: PASS（3 tests）

**Step 6: Commit**

```bash
git add server/src server/tests
git commit -m "feat: 微信登录与 JWT 鉴权"
```

---

### Task 5: 管理员登录 + 审计日志 + 建管理员脚本

**Files:**
- Create: `server/src/lib/audit.js`
- Create: `server/src/routes/admin.js`
- Create: `server/scripts/create-admin.js`
- Modify: `server/src/app.js`（挂载 `/api/admin`）
- Test: `server/tests/admin-auth.test.js`

**Step 1: 写失败测试**

```js
const test = require('node:test');
const assert = require('node:assert');
const { setup, adminToken, loginUser } = require('./helpers');

test('管理员密码错误返回 401', async () => {
  const ctx = setup();
  await adminToken(ctx);
  const res = await ctx.api.post('/api/admin/login').send({ username: 'boss', password: 'wrong' });
  assert.strictEqual(res.status, 401);
});

test('管理员登录后可访问 /api/admin/me', async () => {
  const ctx = setup();
  const token = await adminToken(ctx);
  const res = await ctx.api.get('/api/admin/me').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.username, 'boss');
});

test('普通用户 token 不能访问管理接口', async () => {
  const ctx = setup();
  const { token } = await loginUser(ctx, 'u1');
  const res = await ctx.api.get('/api/admin/me').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 401);
});
```

**Step 2: 运行，确认失败**

Run: `node --test tests/admin-auth.test.js`
Expected: FAIL

**Step 3: 实现**

`server/src/lib/audit.js`：

```js
function audit(db, adminId, action, target, detail = {}) {
  db.prepare('INSERT INTO audit_logs (admin_id, action, target, detail) VALUES (?, ?, ?, ?)')
    .run(adminId, action, target, JSON.stringify(detail));
}

module.exports = { audit };
```

`server/src/routes/admin.js`：

```js
const express = require('express');
const bcrypt = require('bcryptjs');
const { HttpError } = require('../lib/errors');
const { adminAuth, signAdmin } = require('../middleware/auth');

module.exports = (db, config) => {
  const router = express.Router();

  router.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(String(username || ''));
    if (!admin || !bcrypt.compareSync(String(password || ''), admin.password_hash)) {
      throw new HttpError(401, '账号或密码错误');
    }
    res.json({ token: signAdmin(config, admin.id) });
  });

  router.use(adminAuth(config));

  router.get('/me', (req, res) => {
    res.json(db.prepare('SELECT id, username FROM admins WHERE id = ?').get(req.adminId));
  });

  // 后续 Task 在此追加管理接口

  return router;
};
```

`server/scripts/create-admin.js`：

```js
const bcrypt = require('bcryptjs');
const { openDb } = require('../src/db');
const { loadConfig } = require('../src/config');

const [username, password] = process.argv.slice(2);
if (!username || !password || password.length < 8) {
  console.error('用法: npm run create-admin -- <用户名> <密码(至少8位)>');
  process.exit(1);
}
const db = openDb(loadConfig().dbFile);
db.prepare(`INSERT INTO admins (username, password_hash) VALUES (?, ?)
            ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash`)
  .run(username, bcrypt.hashSync(password, 10));
console.log(`管理员 ${username} 已创建/更新`);
```

`server/src/app.js` 挂载：

```js
  app.use('/api/admin', require('./routes/admin')(db, config));
```

**Step 4: 运行，确认通过**

Run: `node --test tests/admin-auth.test.js`
Expected: PASS（3 tests）

**Step 5: Commit**

```bash
git add server/src server/scripts server/tests
git commit -m "feat: 管理员登录、审计日志与建号脚本"
```

---

### Task 6: 老师入驻申请 + 管理员审核定级

**Files:**
- Create: `server/src/routes/teacher.js`
- Modify: `server/src/routes/admin.js`（老师列表、审核）
- Modify: `server/src/app.js`（挂载 `/api/teacher`）
- Test: `server/tests/teacher-apply.test.js`

**Step 1: 写失败测试**

```js
const test = require('node:test');
const assert = require('node:assert');
const { setup, loginUser, adminToken } = require('./helpers');

const APPLY = { displayName: '小林老师', realName: '林某', intro: '十年情感咨询', directions: ['情感'], credentials: ['证书A'] };

test('入驻申请 → 待审核，重复申请 409', async () => {
  const ctx = setup();
  const { token } = await loginUser(ctx, 't1');
  const auth = { Authorization: `Bearer ${token}` };
  const r1 = await ctx.api.post('/api/teacher/apply').set(auth).send(APPLY);
  assert.strictEqual(r1.status, 201);
  assert.strictEqual(r1.body.status, 'pending');
  const r2 = await ctx.api.post('/api/teacher/apply').set(auth).send(APPLY);
  assert.strictEqual(r2.status, 409);
});

test('缺少擅长方向返回 400', async () => {
  const ctx = setup();
  const { token } = await loginUser(ctx, 't1');
  const res = await ctx.api.post('/api/teacher/apply').set('Authorization', `Bearer ${token}`)
    .send({ ...APPLY, directions: [] });
  assert.strictEqual(res.status, 400);
});

test('管理员审核通过并定级，写审计日志', async () => {
  const ctx = setup();
  const { token, userId } = await loginUser(ctx, 't1');
  await ctx.api.post('/api/teacher/apply').set('Authorization', `Bearer ${token}`).send(APPLY);
  const admin = { Authorization: `Bearer ${await adminToken(ctx)}` };

  const list = await ctx.api.get('/api/admin/teachers?status=pending').set(admin);
  assert.strictEqual(list.body.length, 1);
  assert.strictEqual(list.body[0].user_id, userId);

  const bad = await ctx.api.post(`/api/admin/teachers/${userId}/review`).set(admin).send({ approve: true, level: 4 });
  assert.strictEqual(bad.status, 400);

  const ok = await ctx.api.post(`/api/admin/teachers/${userId}/review`).set(admin).send({ approve: true, level: 3 });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.status, 'active');
  assert.strictEqual(ok.body.level, 3);

  const me = await ctx.api.get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(me.body.teacher.status, 'active');

  const logs = ctx.db.prepare("SELECT * FROM audit_logs WHERE action = 'teacher.approve'").all();
  assert.strictEqual(logs.length, 1);
});

test('被拒绝后可重新申请', async () => {
  const ctx = setup();
  const { token, userId } = await loginUser(ctx, 't1');
  const auth = { Authorization: `Bearer ${token}` };
  await ctx.api.post('/api/teacher/apply').set(auth).send(APPLY);
  const admin = { Authorization: `Bearer ${await adminToken(ctx)}` };
  await ctx.api.post(`/api/admin/teachers/${userId}/review`).set(admin).send({ approve: false });
  const again = await ctx.api.post('/api/teacher/apply').set(auth).send(APPLY);
  assert.strictEqual(again.status, 201);
});
```

**Step 2: 运行，确认失败**

Run: `node --test tests/teacher-apply.test.js`
Expected: FAIL

**Step 3: 实现**

`server/src/routes/teacher.js`：

```js
const express = require('express');
const { HttpError } = require('../lib/errors');
const { userAuth } = require('../middleware/auth');

module.exports = (db, config) => {
  const router = express.Router();
  router.use(userAuth(config));

  router.post('/apply', (req, res) => {
    const { displayName, realName, intro = '', directions = [], credentials = [] } = req.body || {};
    if (!displayName || !realName || !Array.isArray(directions) || directions.length === 0) {
      throw new HttpError(400, '请填写展示名、真实姓名和擅长方向');
    }
    const existing = db.prepare('SELECT status FROM teacher_profiles WHERE user_id = ?').get(req.userId);
    if (existing && existing.status !== 'rejected') throw new HttpError(409, '已提交过入驻申请');

    db.prepare(`INSERT INTO teacher_profiles (user_id, display_name, real_name, intro, directions, credentials, status)
                VALUES (?, ?, ?, ?, ?, ?, 'pending')
                ON CONFLICT(user_id) DO UPDATE SET
                  display_name = excluded.display_name, real_name = excluded.real_name, intro = excluded.intro,
                  directions = excluded.directions, credentials = excluded.credentials,
                  status = 'pending', reviewed_at = NULL`)
      .run(req.userId, displayName, realName, intro, JSON.stringify(directions), JSON.stringify(credentials));
    res.status(201).json({ status: 'pending' });
  });

  // 后续 Task 在此追加老师工作台接口

  return router;
};
```

`server/src/routes/admin.js` 顶部加 `const { audit } = require('../lib/audit');`，在 `// 后续 Task 在此追加管理接口` 下方加入：

```js
  router.get('/teachers', (req, res) => {
    const { status } = req.query;
    const rows = status
      ? db.prepare('SELECT * FROM teacher_profiles WHERE status = ? ORDER BY created_at').all(status)
      : db.prepare('SELECT * FROM teacher_profiles ORDER BY created_at').all();
    res.json(rows.map((r) => ({ ...r, directions: JSON.parse(r.directions), credentials: JSON.parse(r.credentials) })));
  });

  router.post('/teachers/:userId/review', (req, res) => {
    const uid = Number(req.params.userId);
    const { approve, level } = req.body || {};
    const t = db.prepare('SELECT status FROM teacher_profiles WHERE user_id = ?').get(uid);
    if (!t) throw new HttpError(404, '申请不存在');
    if (t.status !== 'pending') throw new HttpError(409, '该申请不在待审核状态');

    if (approve) {
      if (!Number.isInteger(level) || level < 1 || level > 3) throw new HttpError(400, '初始等级须为 1~3');
      db.prepare("UPDATE teacher_profiles SET status = 'active', level = ?, reviewed_at = datetime('now') WHERE user_id = ?")
        .run(level, uid);
    } else {
      db.prepare("UPDATE teacher_profiles SET status = 'rejected', reviewed_at = datetime('now') WHERE user_id = ?")
        .run(uid);
    }
    audit(db, req.adminId, approve ? 'teacher.approve' : 'teacher.reject', `teacher:${uid}`, { level });
    res.json(db.prepare('SELECT user_id, status, level FROM teacher_profiles WHERE user_id = ?').get(uid));
  });
```

`server/src/app.js` 挂载：

```js
  app.use('/api/teacher', require('./routes/teacher')(db, config));
```

**Step 4: 运行，确认通过**

Run: `node --test tests/teacher-apply.test.js`
Expected: PASS（4 tests）

**Step 5: Commit**

```bash
git add server/src server/tests
git commit -m "feat: 老师入驻申请与管理员审核定级"
```

---

### Task 7: 老师套餐管理

**Files:**
- Modify: `server/src/routes/teacher.js`
- Test: `server/tests/packages.test.js`

**规则：** 类型 single/month/quarter/year 对应有效天数 0/30/90/365；single 强制 `call_quota = 1`；year 仅 L3 及以上；价格为正整数（分）。

**Step 1: 写失败测试**

```js
const test = require('node:test');
const assert = require('node:assert');
const { setup, loginUser, makeTeacherProfile } = require('./helpers');

async function teacher(ctx, code, level) {
  const u = await loginUser(ctx, code);
  makeTeacherProfile(ctx.db, u.userId, { level });
  return { ...u, auth: { Authorization: `Bearer ${u.token}` } };
}

test('非老师不能建套餐', async () => {
  const ctx = setup();
  const { token } = await loginUser(ctx, 'u1');
  const res = await ctx.api.post('/api/teacher/packages').set('Authorization', `Bearer ${token}`)
    .send({ type: 'month', title: '包月', priceCents: 3000 });
  assert.strictEqual(res.status, 403);
});

test('建包月套餐，天数自动为 30', async () => {
  const ctx = setup();
  const t = await teacher(ctx, 't1', 2);
  const res = await ctx.api.post('/api/teacher/packages').set(t.auth)
    .send({ type: 'month', title: '包月', priceCents: 3000, callQuota: 4, replyHours: 12 });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.days, 30);
  assert.strictEqual(res.body.call_quota, 4);
});

test('单次套餐通话次数强制为 1', async () => {
  const ctx = setup();
  const t = await teacher(ctx, 't1', 1);
  const res = await ctx.api.post('/api/teacher/packages').set(t.auth)
    .send({ type: 'single', title: '单次', priceCents: 500, callQuota: 9 });
  assert.strictEqual(res.body.call_quota, 1);
});

test('年包仅 L3 及以上', async () => {
  const ctx = setup();
  const low = await teacher(ctx, 't1', 2);
  const high = await teacher(ctx, 't2', 3);
  const body = { type: 'year', title: '包年', priceCents: 300000 };
  assert.strictEqual((await ctx.api.post('/api/teacher/packages').set(low.auth).send(body)).status, 403);
  assert.strictEqual((await ctx.api.post('/api/teacher/packages').set(high.auth).send(body)).status, 201);
});

test('价格非法返回 400', async () => {
  const ctx = setup();
  const t = await teacher(ctx, 't1', 2);
  const res = await ctx.api.post('/api/teacher/packages').set(t.auth)
    .send({ type: 'month', title: '包月', priceCents: 12.5 });
  assert.strictEqual(res.status, 400);
});

test('下架自己的套餐；不能改别人的套餐', async () => {
  const ctx = setup();
  const a = await teacher(ctx, 't1', 2);
  const b = await teacher(ctx, 't2', 2);
  const created = await ctx.api.post('/api/teacher/packages').set(a.auth)
    .send({ type: 'month', title: '包月', priceCents: 3000 });
  const id = created.body.id;
  const off = await ctx.api.patch(`/api/teacher/packages/${id}`).set(a.auth).send({ onSale: false });
  assert.strictEqual(off.body.on_sale, 0);
  const other = await ctx.api.patch(`/api/teacher/packages/${id}`).set(b.auth).send({ onSale: true });
  assert.strictEqual(other.status, 404);
  const mine = await ctx.api.get('/api/teacher/packages').set(a.auth);
  assert.strictEqual(mine.body.length, 1);
});
```

**Step 2: 运行，确认失败**

Run: `node --test tests/packages.test.js`
Expected: FAIL

**Step 3: 实现**

在 `server/src/routes/teacher.js` 的 `module.exports` 外部顶部加：

```js
const PACKAGE_DAYS = { single: 0, month: 30, quarter: 90, year: 365 };
```

在 `// 后续 Task 在此追加老师工作台接口` 下方加入：

```js
  const getPackage = (id) => db.prepare('SELECT * FROM packages WHERE id = ?').get(id);

  function requireActiveTeacher(req) {
    const t = db.prepare('SELECT level, status FROM teacher_profiles WHERE user_id = ?').get(req.userId);
    if (!t || t.status !== 'active') throw new HttpError(403, '仅已认证老师可操作');
    return t;
  }

  router.post('/packages', (req, res) => {
    const t = requireActiveTeacher(req);
    const { type, title, priceCents, callQuota = 0, replyHours = 24 } = req.body || {};
    if (!Object.prototype.hasOwnProperty.call(PACKAGE_DAYS, type)) throw new HttpError(400, '无效的套餐类型');
    if (!title) throw new HttpError(400, '请填写套餐名称');
    if (!Number.isInteger(priceCents) || priceCents <= 0) throw new HttpError(400, '价格必须为正整数（分）');
    if (!Number.isInteger(callQuota) || callQuota < 0) throw new HttpError(400, '通话次数非法');
    if (!Number.isInteger(replyHours) || replyHours <= 0) throw new HttpError(400, '回复时效非法');
    if (type === 'year' && t.level < 3) throw new HttpError(403, '年包仅 L3 及以上老师可开放');

    const quota = type === 'single' ? 1 : callQuota;
    const info = db.prepare(`INSERT INTO packages (teacher_id, type, title, price_cents, days, call_quota, reply_hours)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(req.userId, type, title, priceCents, PACKAGE_DAYS[type], quota, replyHours);
    res.status(201).json(getPackage(info.lastInsertRowid));
  });

  router.get('/packages', (req, res) => {
    requireActiveTeacher(req);
    res.json(db.prepare('SELECT * FROM packages WHERE teacher_id = ? ORDER BY id').all(req.userId));
  });

  router.patch('/packages/:id', (req, res) => {
    requireActiveTeacher(req);
    const pkg = db.prepare('SELECT * FROM packages WHERE id = ? AND teacher_id = ?').get(Number(req.params.id), req.userId);
    if (!pkg) throw new HttpError(404, '套餐不存在');
    const { onSale, priceCents, title } = req.body || {};
    if (priceCents !== undefined && (!Number.isInteger(priceCents) || priceCents <= 0)) {
      throw new HttpError(400, '价格必须为正整数（分）');
    }
    db.prepare('UPDATE packages SET on_sale = ?, price_cents = ?, title = ? WHERE id = ?').run(
      onSale === undefined ? pkg.on_sale : (onSale ? 1 : 0),
      priceCents ?? pkg.price_cents,
      title ?? pkg.title,
      pkg.id,
    );
    res.json(getPackage(pkg.id));
  });
```

**Step 4: 运行，确认通过**

Run: `node --test tests/packages.test.js`
Expected: PASS（6 tests）

**Step 5: Commit**

```bash
git add server/src server/tests
git commit -m "feat: 老师套餐管理"
```

---

### Task 8: 公开老师列表与详情

**Files:**
- Create: `server/src/routes/teachers.js`
- Modify: `server/src/app.js`（挂载 `/api/teachers`）
- Test: `server/tests/teachers-public.test.js`

**Step 1: 写失败测试**

```js
const test = require('node:test');
const assert = require('node:assert');
const { setup, insertTeacher, insertPackage } = require('./helpers');

test('列表只返回已认证老师，含最低在售价，可按方向/等级筛选', async () => {
  const ctx = setup();
  const a = insertTeacher(ctx.db, 'a', { level: 3, directions: ['情感', '职业'] });
  const b = insertTeacher(ctx.db, 'b', { level: 1, directions: ['健身'] });
  insertTeacher(ctx.db, 'c', { status: 'pending' });
  insertPackage(ctx.db, a, { price_cents: 3000 });
  insertPackage(ctx.db, a, { type: 'single', days: 0, price_cents: 500 });
  insertPackage(ctx.db, a, { type: 'single', days: 0, price_cents: 100, on_sale: 0 });

  const all = await ctx.api.get('/api/teachers');
  assert.deepStrictEqual(all.body.map((t) => t.id), [a, b]);
  assert.strictEqual(all.body[0].min_price_cents, 500);
  assert.deepStrictEqual(all.body[0].directions, ['情感', '职业']);
  assert.strictEqual(all.body[0].real_name, undefined);

  const byDir = await ctx.api.get('/api/teachers').query({ direction: '健身' });
  assert.deepStrictEqual(byDir.body.map((t) => t.id), [b]);

  const byLevel = await ctx.api.get('/api/teachers').query({ level: 3 });
  assert.deepStrictEqual(byLevel.body.map((t) => t.id), [a]);
});

test('详情只含在售套餐；未认证老师 404', async () => {
  const ctx = setup();
  const a = insertTeacher(ctx.db, 'a');
  const pending = insertTeacher(ctx.db, 'p', { status: 'pending' });
  insertPackage(ctx.db, a);
  insertPackage(ctx.db, a, { on_sale: 0 });

  const res = await ctx.api.get(`/api/teachers/${a}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.packages.length, 1);
  assert.strictEqual((await ctx.api.get(`/api/teachers/${pending}`)).status, 404);
});
```

**Step 2: 运行，确认失败**

Run: `node --test tests/teachers-public.test.js`
Expected: FAIL

**Step 3: 实现**

`server/src/routes/teachers.js`：

```js
const express = require('express');
const { HttpError } = require('../lib/errors');

const PUBLIC_COLS = `t.user_id AS id, t.display_name, t.intro, t.directions, t.level,
  (SELECT MIN(p.price_cents) FROM packages p WHERE p.teacher_id = t.user_id AND p.on_sale = 1) AS min_price_cents`;

const toPublic = (r) => ({ ...r, directions: JSON.parse(r.directions) });

module.exports = (db) => {
  const router = express.Router();

  router.get('/', (req, res) => {
    const { direction, level } = req.query;
    let rows = db.prepare(`SELECT ${PUBLIC_COLS} FROM teacher_profiles t
                           WHERE t.status = 'active' ORDER BY t.level DESC, t.user_id`).all().map(toPublic);
    if (direction) rows = rows.filter((r) => r.directions.includes(direction));
    if (level) rows = rows.filter((r) => r.level === Number(level));
    res.json(rows);
  });

  router.get('/:id', (req, res) => {
    const row = db.prepare(`SELECT ${PUBLIC_COLS} FROM teacher_profiles t
                            WHERE t.user_id = ? AND t.status = 'active'`).get(Number(req.params.id));
    if (!row) throw new HttpError(404, '老师不存在');
    const packages = db.prepare(`SELECT id, type, title, price_cents, days, call_quota, reply_hours
                                 FROM packages WHERE teacher_id = ? AND on_sale = 1 ORDER BY price_cents`).all(row.id);
    res.json({ ...toPublic(row), packages });
  });

  return router;
};
```

`server/src/app.js` 挂载：

```js
  app.use('/api/teachers', require('./routes/teachers')(db, config));
```

**Step 4: 运行，确认通过**

Run: `node --test tests/teachers-public.test.js`
Expected: PASS（2 tests）

**Step 5: Commit**

```bash
git add server/src server/tests
git commit -m "feat: 公开老师列表与详情"
```

---

### Task 9: ZPAY 支付封装（移植自 divination）

**Files:**
- Create: `server/src/payment/zpay.js`
- Test: `server/tests/zpay.test.js`

参考：`/data/workspace/ngr/wx/divination/server/zpay.js`。区别：配置由参数注入，不读文件；固定支付宝。

**Step 1: 写失败测试**

```js
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createZpay, buildSignStr } = require('../src/payment/zpay');

const CFG = { pid: 'p1', key: 'k1', gateway: 'https://z-pay.cn' };

test('未配置 pid/key 时为 MOCK', () => {
  assert.strictEqual(createZpay({ pid: '', key: '', gateway: 'x' }).isMock, true);
  assert.strictEqual(createZpay(CFG).isMock, false);
});

test('待签名串：过滤空值与 sign/sign_type，按键名排序', () => {
  assert.strictEqual(buildSignStr({ b: 2, a: 1, sign: 'x', sign_type: 'MD5', c: '' }), 'a=1&b=2');
});

test('签名 = md5(signStr + key)，验签可往返，篡改失败', () => {
  const z = createZpay(CFG);
  const params = { pid: 'p1', out_trade_no: 'O1', money: '30.00', trade_status: 'TRADE_SUCCESS' };
  const expect = crypto.createHash('md5').update(buildSignStr(params) + 'k1', 'utf8').digest('hex');
  const sign = z.sign(params);
  assert.strictEqual(sign, expect);
  assert.strictEqual(z.verify({ ...params, sign, sign_type: 'MD5' }), true);
  assert.strictEqual(z.verify({ ...params, money: '0.01', sign, sign_type: 'MD5' }), false);
  assert.strictEqual(z.verify(params), false);
});

test('buildPayUrl 指向 submit.php 且带签名', () => {
  const url = createZpay(CFG).buildPayUrl({
    outTradeNo: 'O1', money: '30.00', name: '包月陪伴',
    notifyUrl: 'http://h/api/pay/notify', returnUrl: 'http://h/api/pay/return',
  });
  assert.ok(url.startsWith('https://z-pay.cn/submit.php?'));
  assert.match(url, /type=alipay/);
  assert.match(url, /sign=[0-9a-f]{32}&sign_type=MD5$/);
  assert.match(url, new RegExp(encodeURIComponent('包月陪伴')));
});
```

**Step 2: 运行，确认失败**

Run: `node --test tests/zpay.test.js`
Expected: FAIL

**Step 3: 实现**

`server/src/payment/zpay.js`：

```js
const crypto = require('crypto');

function buildSignStr(params) {
  return Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] != null)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

function createZpay(cfg) {
  const isMock = !cfg.pid || !cfg.key;

  const sign = (params) => crypto.createHash('md5').update(buildSignStr(params) + cfg.key, 'utf8').digest('hex');

  const verify = (params) => !!(params && params.sign) && sign(params) === String(params.sign).toLowerCase();

  function buildPayUrl({ outTradeNo, money, name, notifyUrl, returnUrl }) {
    const params = {
      pid: cfg.pid,
      money,
      name,
      notify_url: notifyUrl,
      out_trade_no: outTradeNo,
      return_url: returnUrl,
      sitename: 'LiaoYu',
      type: 'alipay',
    };
    const query = Object.keys(params)
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
      .join('&');
    return `${cfg.gateway}/submit.php?${query}&sign=${sign(params)}&sign_type=MD5`;
  }

  return { isMock, sign, verify, buildPayUrl };
}

module.exports = { createZpay, buildSignStr };
```

**Step 4: 运行，确认通过**

Run: `node --test tests/zpay.test.js`
Expected: PASS（4 tests）

**Step 5: Commit**

```bash
git add server/src/payment server/tests/zpay.test.js
git commit -m "feat: ZPAY 支付封装"
```

---

### Task 10: 服务分段（纯函数）

**Files:**
- Create: `server/src/services/segments.js`
- Test: `server/tests/segments.test.js`

**思路：** 把分段展开成逐日数组 → 修改 → 重新压缩。代码最短、最不易错，内测规模下性能足够。

**Step 1: 写失败测试**

```js
const test = require('node:test');
const assert = require('node:assert');
const {
  initialSegments, applySubstitute, applyPause, segmentOn, activeDayIndex,
} = require('../src/services/segments');

const base = () => initialSegments(1, '2026-11-01', '2026-11-30');

test('代班：中间插入代班分段', () => {
  const segs = applySubstitute(base(), { from: '2026-11-10', to: '2026-11-12', teacherId: 2 });
  assert.deepStrictEqual(segs, [
    { kind: 'normal', teacher_id: 1, start_date: '2026-11-01', end_date: '2026-11-09' },
    { kind: 'substitute', teacher_id: 2, start_date: '2026-11-10', end_date: '2026-11-12' },
    { kind: 'normal', teacher_id: 1, start_date: '2026-11-13', end_date: '2026-11-30' },
  ]);
});

test('暂停：插入暂停分段并整体顺延', () => {
  const segs = applyPause(base(), { from: '2026-11-10', to: '2026-11-14' });
  assert.deepStrictEqual(segs, [
    { kind: 'normal', teacher_id: 1, start_date: '2026-11-01', end_date: '2026-11-09' },
    { kind: 'paused', teacher_id: null, start_date: '2026-11-10', end_date: '2026-11-14' },
    { kind: 'normal', teacher_id: 1, start_date: '2026-11-15', end_date: '2026-12-05' },
  ]);
});

test('暂停起始日晚于服务期则报错', () => {
  assert.throws(() => applyPause(base(), { from: '2026-12-01', to: '2026-12-02' }));
});

test('segmentOn 与 activeDayIndex 跳过暂停日', () => {
  const segs = applyPause(base(), { from: '2026-11-10', to: '2026-11-14' });
  assert.strictEqual(segmentOn(segs, '2026-11-12').kind, 'paused');
  assert.strictEqual(segmentOn(segs, '2026-12-06'), null);
  assert.strictEqual(activeDayIndex(segs, '2026-11-01'), 0);
  assert.strictEqual(activeDayIndex(segs, '2026-11-15'), 9);
  assert.strictEqual(activeDayIndex(segs, '2026-12-05'), 29);
});
```

**Step 2: 运行，确认失败**

Run: `node --test tests/segments.test.js`
Expected: FAIL

**Step 3: 实现**

`server/src/services/segments.js`：

```js
const { addDays, diffDays, eachDay } = require('../lib/dates');

function expand(segments) {
  const days = [];
  for (const s of segments) {
    for (const date of eachDay(s.start_date, s.end_date)) days.push({ date, kind: s.kind, teacher_id: s.teacher_id });
  }
  return days;
}

function compress(days) {
  const out = [];
  for (const d of days) {
    const last = out[out.length - 1];
    if (last && last.kind === d.kind && last.teacher_id === d.teacher_id && addDays(last.end_date, 1) === d.date) {
      last.end_date = d.date;
    } else {
      out.push({ kind: d.kind, teacher_id: d.teacher_id, start_date: d.date, end_date: d.date });
    }
  }
  return out;
}

const initialSegments = (teacherId, start, end) => [{ kind: 'normal', teacher_id: teacherId, start_date: start, end_date: end }];

function applySubstitute(segments, { from, to, teacherId }) {
  return compress(expand(segments).map((d) => (
    d.date >= from && d.date <= to && d.kind === 'normal' ? { ...d, kind: 'substitute', teacher_id: teacherId } : d
  )));
}

function applyPause(segments, { from, to }) {
  const days = expand(segments);
  const idx = days.findIndex((d) => d.date >= from);
  if (idx === -1) throw new Error('暂停起始日不在服务期内');
  const paused = Array.from({ length: diffDays(from, to) + 1 }, () => ({ kind: 'paused', teacher_id: null }));
  const seq = [...days.slice(0, idx), ...paused, ...days.slice(idx)];
  const start = days[0].date;
  return compress(seq.map((d, i) => ({ ...d, date: addDays(start, i) })));
}

const segmentOn = (segments, date) => segments.find((s) => s.start_date <= date && date <= s.end_date) || null;

function activeDayIndex(segments, date) {
  let n = 0;
  for (const s of segments) {
    if (s.kind === 'paused') continue;
    if (s.end_date < date) n += diffDays(s.start_date, s.end_date) + 1;
    else if (s.start_date < date) n += diffDays(s.start_date, date);
  }
  return n;
}

module.exports = { initialSegments, applySubstitute, applyPause, segmentOn, activeDayIndex };
```

**Step 4: 运行，确认通过**

Run: `node --test tests/segments.test.js`
Expected: PASS（4 tests）

**Step 5: Commit**

```bash
git add server/src/services/segments.js server/tests/segments.test.js
git commit -m "feat: 服务分段纯函数（代班/暂停顺延）"
```

---

### Task 11: 下单与履约服务（服务关系 + 续费顺接）

**Files:**
- Create: `server/src/services/relations.js`
- Create: `server/src/services/orders.js`
- Test: `server/tests/orders-service.test.js`

**规则：**
- 订单保存套餐快照；不能购买自己的套餐；套餐须在售且老师已认证。
- 履约幂等；金额不符不履约。
- 周期套餐：若同一用户对同一老师已有未到期的周期服务，新服务从其结束日次日开始（续费顺接）。
- 单次套餐：有效期 30 天、通话 1 次、`total_days = 0`（不参与日计提，第二阶段按通话计提）。

**Step 1: 写失败测试**

```js
const test = require('node:test');
const assert = require('node:assert');
const { setup, insertUser, insertTeacher, insertPackage } = require('./helpers');
const { createOrder, fulfillOrder } = require('../src/services/orders');
const { loadSegments } = require('../src/services/relations');

function world() {
  const ctx = setup();
  const teacher = insertTeacher(ctx.db, 't');
  const user = insertUser(ctx.db, 'u');
  const month = insertPackage(ctx.db, teacher, { price_cents: 3000 });
  const single = insertPackage(ctx.db, teacher, { type: 'single', days: 0, call_quota: 1, price_cents: 500 });
  return { ctx, teacher, user, month, single, now: ctx.config.now() };
}

test('创建订单保存快照与金额', () => {
  const w = world();
  const o = createOrder(w.ctx.db, { userId: w.user, packageId: w.month, provider: 'zpay', nowMs: w.now });
  assert.strictEqual(o.status, 'pending');
  assert.strictEqual(o.amount_cents, 3000);
  assert.strictEqual(o.teacher_id, w.teacher);
  assert.strictEqual(JSON.parse(o.package_snapshot).type, 'month');
  assert.match(o.out_trade_no, /^20261101\d{12}$/);
});

test('下架套餐、自己的套餐不能下单', () => {
  const w = world();
  const off = insertPackage(w.ctx.db, w.teacher, { on_sale: 0 });
  assert.throws(() => createOrder(w.ctx.db, { userId: w.user, packageId: off, provider: 'zpay', nowMs: w.now }), /下架/);
  assert.throws(() => createOrder(w.ctx.db, { userId: w.teacher, packageId: w.month, provider: 'zpay', nowMs: w.now }), /自己/);
});

test('履约创建服务关系与初始分段，且幂等', () => {
  const w = world();
  const o = createOrder(w.ctx.db, { userId: w.user, packageId: w.month, provider: 'zpay', nowMs: w.now });
  const r1 = fulfillOrder(w.ctx.db, o.out_trade_no, { tradeNo: 'T1', paidCents: 3000, nowMs: w.now });
  const r2 = fulfillOrder(w.ctx.db, o.out_trade_no, { tradeNo: 'T1', paidCents: 3000, nowMs: w.now });
  assert.deepStrictEqual(r1, { ok: true, fulfilled: true });
  assert.deepStrictEqual(r2, { ok: true, fulfilled: false });

  const rels = w.ctx.db.prepare('SELECT * FROM service_relations').all();
  assert.strictEqual(rels.length, 1);
  assert.strictEqual(rels[0].start_date, '2026-11-01');
  assert.strictEqual(rels[0].end_date, '2026-11-30');
  assert.strictEqual(rels[0].total_days, 30);
  assert.strictEqual(rels[0].calls_left, 4);
  assert.deepStrictEqual(loadSegments(w.ctx.db, rels[0].id), [
    { kind: 'normal', teacher_id: w.teacher, start_date: '2026-11-01', end_date: '2026-11-30' },
  ]);
});

test('金额不符不履约', () => {
  const w = world();
  const o = createOrder(w.ctx.db, { userId: w.user, packageId: w.month, provider: 'zpay', nowMs: w.now });
  const r = fulfillOrder(w.ctx.db, o.out_trade_no, { tradeNo: 'T1', paidCents: 1, nowMs: w.now });
  assert.deepStrictEqual(r, { ok: false, reason: 'amount_mismatch' });
  assert.strictEqual(w.ctx.db.prepare('SELECT status FROM orders').get().status, 'pending');
});

test('续费顺接：第二个包月从上一个结束次日开始', () => {
  const w = world();
  for (let i = 0; i < 2; i++) {
    const o = createOrder(w.ctx.db, { userId: w.user, packageId: w.month, provider: 'zpay', nowMs: w.now });
    fulfillOrder(w.ctx.db, o.out_trade_no, { tradeNo: `T${i}`, paidCents: 3000, nowMs: w.now });
  }
  const rels = w.ctx.db.prepare('SELECT start_date, end_date FROM service_relations ORDER BY id').all();
  assert.deepStrictEqual(rels[1], { start_date: '2026-12-01', end_date: '2026-12-30' });
});

test('单次套餐：有效 30 天、1 次通话、不参与日计提', () => {
  const w = world();
  const o = createOrder(w.ctx.db, { userId: w.user, packageId: w.single, provider: 'zpay', nowMs: w.now });
  fulfillOrder(w.ctx.db, o.out_trade_no, { tradeNo: 'T', paidCents: 500, nowMs: w.now });
  const rel = w.ctx.db.prepare('SELECT * FROM service_relations').get();
  assert.strictEqual(rel.total_days, 0);
  assert.strictEqual(rel.calls_left, 1);
  assert.strictEqual(rel.end_date, '2026-11-30');
});
```

**Step 2: 运行，确认失败**

Run: `node --test tests/orders-service.test.js`
Expected: FAIL

**Step 3: 实现**

`server/src/services/relations.js`：

```js
const { addDays } = require('../lib/dates');
const { initialSegments } = require('./segments');

const SINGLE_VALID_DAYS = 30;

function loadSegments(db, relationId) {
  return db.prepare(`SELECT kind, teacher_id, start_date, end_date FROM service_segments
                     WHERE relation_id = ? ORDER BY start_date`).all(relationId);
}

function saveSegments(db, relationId, segments) {
  db.transaction(() => {
    db.prepare('DELETE FROM service_segments WHERE relation_id = ?').run(relationId);
    const ins = db.prepare(`INSERT INTO service_segments (relation_id, kind, teacher_id, start_date, end_date)
                            VALUES (?, ?, ?, ?, ?)`);
    for (const s of segments) ins.run(relationId, s.kind, s.teacher_id, s.start_date, s.end_date);
    db.prepare('UPDATE service_relations SET end_date = ? WHERE id = ?')
      .run(segments[segments.length - 1].end_date, relationId);
  })();
}

function createRelationForOrder(db, order, today) {
  const snap = JSON.parse(order.package_snapshot);
  const isSingle = snap.type === 'single';
  let start = today;
  if (!isSingle) {
    const last = db.prepare(`SELECT MAX(end_date) AS e FROM service_relations
                             WHERE user_id = ? AND teacher_id = ? AND status = 'active' AND package_type != 'single'`)
      .get(order.user_id, order.teacher_id).e;
    if (last && last >= today) start = addDays(last, 1);
  }
  const totalDays = isSingle ? 0 : snap.days;
  const end = addDays(start, (isSingle ? SINGLE_VALID_DAYS : totalDays) - 1);
  const info = db.prepare(`INSERT INTO service_relations
      (order_id, user_id, teacher_id, package_type, amount_cents, total_days, start_date, end_date, calls_left)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(order.id, order.user_id, order.teacher_id, snap.type, order.amount_cents, totalDays, start, end, snap.call_quota);
  saveSegments(db, info.lastInsertRowid, initialSegments(order.teacher_id, start, end));
  return info.lastInsertRowid;
}

module.exports = { SINGLE_VALID_DAYS, loadSegments, saveSegments, createRelationForOrder };
```

`server/src/services/orders.js`：

```js
const crypto = require('crypto');
const { HttpError } = require('../lib/errors');
const { todayCN } = require('../lib/dates');
const { createRelationForOrder } = require('./relations');

function genOutTradeNo(nowMs) {
  const d = new Date(nowMs + 8 * 3600 * 1000);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${p(crypto.randomInt(0, 1e6), 6)}`;
}

const getOrder = (db, outTradeNo) => db.prepare('SELECT * FROM orders WHERE out_trade_no = ?').get(outTradeNo);

function createOrder(db, { userId, packageId, provider, nowMs }) {
  const pkg = db.prepare(`SELECT p.*, t.status AS teacher_status FROM packages p
                          JOIN teacher_profiles t ON t.user_id = p.teacher_id WHERE p.id = ?`).get(packageId);
  if (!pkg || !pkg.on_sale || pkg.teacher_status !== 'active') throw new HttpError(400, '套餐不存在或已下架');
  if (pkg.teacher_id === userId) throw new HttpError(400, '不能购买自己的套餐');

  const snapshot = {
    type: pkg.type, title: pkg.title, price_cents: pkg.price_cents,
    days: pkg.days, call_quota: pkg.call_quota, reply_hours: pkg.reply_hours,
  };
  let otn;
  do { otn = genOutTradeNo(nowMs); } while (getOrder(db, otn));

  db.prepare(`INSERT INTO orders (out_trade_no, user_id, teacher_id, package_id, package_snapshot, amount_cents, pay_provider)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(otn, userId, pkg.teacher_id, pkg.id, JSON.stringify(snapshot), pkg.price_cents, provider);
  return getOrder(db, otn);
}

function fulfillOrder(db, outTradeNo, { tradeNo, paidCents, nowMs }) {
  return db.transaction(() => {
    const order = getOrder(db, outTradeNo);
    if (!order) return { ok: false, reason: 'not_found' };
    if (order.status === 'paid') return { ok: true, fulfilled: false };
    if (paidCents !== order.amount_cents) return { ok: false, reason: 'amount_mismatch' };
    db.prepare("UPDATE orders SET status = 'paid', trade_no = ?, paid_at = ? WHERE id = ?")
      .run(tradeNo, new Date(nowMs).toISOString(), order.id);
    createRelationForOrder(db, order, todayCN(nowMs));
    return { ok: true, fulfilled: true };
  })();
}

module.exports = { getOrder, createOrder, fulfillOrder };
```

**Step 4: 运行，确认通过**

Run: `node --test tests/orders-service.test.js`
Expected: PASS（6 tests）

**Step 5: Commit**

```bash
git add server/src/services server/tests/orders-service.test.js
git commit -m "feat: 下单与履约（服务关系、续费顺接）"
```

---

### Task 12: 订单/支付/我的服务 接口

**Files:**
- Create: `server/src/routes/orders.js`
- Create: `server/src/routes/pay.js`
- Create: `server/src/routes/relations.js`
- Modify: `server/src/routes/teacher.js`（`GET /students`）
- Modify: `server/src/app.js`（挂载 `/api/orders`、`/api/pay`、`/api/relations`）
- Test: `server/tests/orders-api.test.js`

**接口：**
- `POST /api/orders {packageId}` → `{ outTradeNo, amountCents, payUrl, mock }`（小程序复制 `payUrl` 到浏览器）
- `GET /api/orders/:outTradeNo` → 仅本人，`{ status, paid, amountCents }`
- `GET /api/pay/notify` → ZPAY 异步回调，返回纯文本 `success` / `fail`
- `GET /api/pay/return` → 浏览器同步回跳，提示"返回小程序"
- `GET /api/pay/mock`、`POST /api/pay/mock/confirm` → 仅 MOCK 模式
- `GET /api/relations` → 我购买的服务
- `GET /api/teacher/students` → 老师名下的服务关系

**Step 1: 写失败测试**

```js
const test = require('node:test');
const assert = require('node:assert');
const {
  setup, loginUser, insertUser, insertTeacher, makeTeacherProfile, insertPackage, buyAndPay,
} = require('./helpers');
const { createZpay } = require('../src/payment/zpay');

const ZPAY = { pid: 'p1', key: 'k1', gateway: 'https://z-pay.cn' };

async function world(opts) {
  const ctx = setup(opts);
  const teacher = insertTeacher(ctx.db, 't');
  const pkg = insertPackage(ctx.db, teacher, { price_cents: 3000 });
  const u = await loginUser(ctx, 'u1');
  return { ctx, teacher, pkg, auth: { Authorization: `Bearer ${u.token}` } };
}

test('MOCK 模式：下单 → 模拟确认 → 订单已付 → 我的服务出现', async () => {
  const w = await world();
  const created = await w.ctx.api.post('/api/orders').set(w.auth).send({ packageId: w.pkg });
  assert.strictEqual(created.status, 201);
  assert.strictEqual(created.body.mock, true);
  assert.strictEqual(created.body.amountCents, 3000);
  assert.ok(created.body.payUrl.startsWith('http://test.local/api/pay/mock?out_trade_no='));

  const otn = created.body.outTradeNo;
  assert.strictEqual((await w.ctx.api.get(`/api/orders/${otn}`).set(w.auth)).body.paid, false);
  assert.strictEqual((await w.ctx.api.post(`/api/pay/mock/confirm?out_trade_no=${otn}`)).status, 200);
  assert.strictEqual((await w.ctx.api.get(`/api/orders/${otn}`).set(w.auth)).body.paid, true);

  const rels = await w.ctx.api.get('/api/relations').set(w.auth);
  assert.strictEqual(rels.body.length, 1);
  assert.strictEqual(rels.body[0].teacher_id, w.teacher);
  assert.strictEqual(rels.body[0].teacher_name, `老师${w.teacher}`);
});

test('他人订单不可查', async () => {
  const w = await world();
  const created = await w.ctx.api.post('/api/orders').set(w.auth).send({ packageId: w.pkg });
  const other = await loginUser(w.ctx, 'u2');
  const res = await w.ctx.api.get(`/api/orders/${created.body.outTradeNo}`).set('Authorization', `Bearer ${other.token}`);
  assert.strictEqual(res.status, 404);
});

test('真实模式：返回 ZPAY 收银台链接，mock 接口不可用', async () => {
  const w = await world({ config: { zpay: ZPAY } });
  const created = await w.ctx.api.post('/api/orders').set(w.auth).send({ packageId: w.pkg });
  assert.strictEqual(created.body.mock, false);
  assert.ok(created.body.payUrl.startsWith('https://z-pay.cn/submit.php?'));
  assert.match(created.body.payUrl, /notify_url=http%3A%2F%2Ftest.local%2Fapi%2Fpay%2Fnotify/);
  assert.strictEqual((await w.ctx.api.post(`/api/pay/mock/confirm?out_trade_no=${created.body.outTradeNo}`)).status, 404);
});

test('notify：验签通过且金额正确 → success 并履约；验签失败/金额不符 → fail', async () => {
  const w = await world({ config: { zpay: ZPAY } });
  const z = createZpay(ZPAY);
  const created = await w.ctx.api.post('/api/orders').set(w.auth).send({ packageId: w.pkg });
  const otn = created.body.outTradeNo;
  const signed = (p) => ({ ...p, sign: z.sign(p), sign_type: 'MD5' });
  const base = { pid: 'p1', trade_no: 'Z1', out_trade_no: otn, type: 'alipay', name: '包月陪伴', trade_status: 'TRADE_SUCCESS' };

  const badSign = await w.ctx.api.get('/api/pay/notify').query({ ...signed({ ...base, money: '30.00' }), sign: 'x'.repeat(32) });
  assert.strictEqual(badSign.text, 'fail');

  const badMoney = await w.ctx.api.get('/api/pay/notify').query(signed({ ...base, money: '0.01' }));
  assert.strictEqual(badMoney.text, 'fail');

  const ok = await w.ctx.api.get('/api/pay/notify').query(signed({ ...base, money: '30.00' }));
  assert.strictEqual(ok.text, 'success');
  assert.strictEqual(w.ctx.db.prepare('SELECT status, trade_no FROM orders').get().status, 'paid');

  const again = await w.ctx.api.get('/api/pay/notify').query(signed({ ...base, money: '30.00' }));
  assert.strictEqual(again.text, 'success');
  assert.strictEqual(w.ctx.db.prepare('SELECT COUNT(*) c FROM service_relations').get().c, 1);
});

test('老师可查看名下学员', async () => {
  const ctx = setup();
  const t = await loginUser(ctx, 'teacher-login');
  makeTeacherProfile(ctx.db, t.userId);
  buyAndPay(ctx, insertUser(ctx.db, 'u'), insertPackage(ctx.db, t.userId));
  const res = await ctx.api.get('/api/teacher/students').set('Authorization', `Bearer ${t.token}`);
  assert.strictEqual(res.body.length, 1);
});
```

**Step 2: 运行，确认失败**

Run: `node --test tests/orders-api.test.js`
Expected: FAIL

**Step 3: 实现**

`server/src/routes/orders.js`：

```js
const express = require('express');
const { HttpError } = require('../lib/errors');
const { userAuth } = require('../middleware/auth');
const { centsToYuan } = require('../lib/money');
const { createZpay } = require('../payment/zpay');
const { createOrder, getOrder } = require('../services/orders');

module.exports = (db, config) => {
  const router = express.Router();
  const zpay = createZpay(config.zpay);
  router.use(userAuth(config));

  router.post('/', (req, res) => {
    const order = createOrder(db, {
      userId: req.userId, packageId: Number(req.body && req.body.packageId), provider: 'zpay', nowMs: config.now(),
    });
    const base = config.publicBaseUrl;
    const payUrl = zpay.isMock
      ? `${base}/api/pay/mock?out_trade_no=${order.out_trade_no}`
      : zpay.buildPayUrl({
        outTradeNo: order.out_trade_no,
        money: centsToYuan(order.amount_cents),
        name: JSON.parse(order.package_snapshot).title,
        notifyUrl: `${base}/api/pay/notify`,
        returnUrl: `${base}/api/pay/return`,
      });
    res.status(201).json({ outTradeNo: order.out_trade_no, amountCents: order.amount_cents, payUrl, mock: zpay.isMock });
  });

  router.get('/:outTradeNo', (req, res) => {
    const o = getOrder(db, req.params.outTradeNo);
    if (!o || o.user_id !== req.userId) throw new HttpError(404, '订单不存在');
    res.json({ outTradeNo: o.out_trade_no, status: o.status, paid: o.status === 'paid', amountCents: o.amount_cents });
  });

  return router;
};
```

`server/src/routes/pay.js`：

```js
const express = require('express');
const { yuanStrToCents, centsToYuan } = require('../lib/money');
const { createZpay } = require('../payment/zpay');
const { getOrder, fulfillOrder } = require('../services/orders');

const page = (body) => `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>LiaoYu 支付</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;
min-height:100vh;margin:0;background:#f5f6f8}.c{background:#fff;padding:32px;border-radius:16px;text-align:center;
max-width:340px;width:90%}button{width:100%;padding:14px;border:0;border-radius:10px;background:#1677ff;color:#fff;
font-size:16px}</style></head><body><div class="c">${body}</div></body></html>`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

module.exports = (db, config) => {
  const router = express.Router();
  const zpay = createZpay(config.zpay);

  router.get('/notify', (req, res) => {
    const p = req.query;
    if (!zpay.verify(p)) return res.send('fail');
    if (p.trade_status !== 'TRADE_SUCCESS') return res.send('success');
    const r = fulfillOrder(db, p.out_trade_no, {
      tradeNo: p.trade_no || null, paidCents: yuanStrToCents(p.money), nowMs: config.now(),
    });
    if (!r.ok) console.warn('[pay] notify 履约失败', p.out_trade_no, r.reason);
    res.send(r.ok ? 'success' : 'fail');
  });

  router.get('/return', (req, res) => {
    res.type('html').send(page('<h3>支付已提交</h3><p>请返回微信小程序查看服务是否已开通。</p>'));
  });

  router.get('/mock', (req, res) => {
    if (!zpay.isMock) return res.sendStatus(404);
    const o = getOrder(db, String(req.query.out_trade_no || ''));
    if (!o) return res.status(404).send('订单不存在');
    const title = esc(JSON.parse(o.package_snapshot).title);
    res.type('html').send(page(`<p>⚠ 开发模拟收银台</p><h3>${title}</h3><h2>¥${centsToYuan(o.amount_cents)}</h2>
      <form method="post" action="/api/pay/mock/confirm?out_trade_no=${o.out_trade_no}"><button>确认支付</button></form>`));
  });

  router.post('/mock/confirm', (req, res) => {
    if (!zpay.isMock) return res.sendStatus(404);
    const o = getOrder(db, String(req.query.out_trade_no || ''));
    if (!o) return res.status(404).send('订单不存在');
    fulfillOrder(db, o.out_trade_no, { tradeNo: `MOCK_${Date.now()}`, paidCents: o.amount_cents, nowMs: config.now() });
    res.type('html').send(page('<h3>模拟支付成功</h3><p>请返回微信小程序。</p>'));
  });

  return router;
};
```

`server/src/routes/relations.js`：

```js
const express = require('express');
const { userAuth } = require('../middleware/auth');

module.exports = (db, config) => {
  const router = express.Router();
  router.use(userAuth(config));

  router.get('/', (req, res) => {
    res.json(db.prepare(`SELECT r.*, t.display_name AS teacher_name FROM service_relations r
                         JOIN teacher_profiles t ON t.user_id = r.teacher_id
                         WHERE r.user_id = ? ORDER BY r.id DESC`).all(req.userId));
  });

  return router;
};
```

`server/src/routes/teacher.js` 追加：

```js
  router.get('/students', (req, res) => {
    requireActiveTeacher(req);
    res.json(db.prepare(`SELECT r.*, u.nickname AS user_nickname FROM service_relations r
                         JOIN users u ON u.id = r.user_id
                         WHERE r.teacher_id = ? ORDER BY r.status, r.end_date`).all(req.userId));
  });
```

`server/src/app.js` 挂载：

```js
  app.use('/api/orders', require('./routes/orders')(db, config));
  app.use('/api/pay', require('./routes/pay')(db, config));
  app.use('/api/relations', require('./routes/relations')(db, config));
```

**Step 4: 运行，确认通过**

Run: `node --test tests/orders-api.test.js`
Expected: PASS（5 tests）

**Step 5: 全量回归**

Run: `npm test`
Expected: 全部 PASS

**Step 6: Commit**

```bash
git add server/src server/tests
git commit -m "feat: 订单、ZPAY 回调、我的服务接口"
```

---

### Task 13: 日计提 + 每日任务

**Files:**
- Create: `server/src/services/accrual.js`
- Create: `server/src/jobs.js`
- Test: `server/tests/accrual.test.js`

**规则：**
- 只处理 `status='active' AND frozen=0` 的周期套餐。
- 当天落在 normal/substitute 分段 → 计给该分段老师；paused → 不计。
- 日额 = `splitEvenly(amount, total_days, 第几个有效日)`，保证总和精确等于订单金额。
- `(relation_id, date)` 唯一，重复跑幂等；`accrueUpTo` 从最早开始日补齐，解冻后自动补算。
- 每日任务：计提到昨天，再把 `end_date < 今天` 且未冻结的关系置为 `ended`。

**Step 1: 写失败测试**

```js
const test = require('node:test');
const assert = require('node:assert');
const { setup, insertUser, insertTeacher, insertPackage, buyAndPay } = require('./helpers');
const { accrueForDate, accrueUpTo } = require('../src/services/accrual');
const { runDailyJobs } = require('../src/jobs');
const { loadSegments, saveSegments } = require('../src/services/relations');
const { applySubstitute, applyPause } = require('../src/services/segments');

function world(price = 3000) {
  const ctx = setup();
  const teacher = insertTeacher(ctx.db, 'a');
  const sub = insertTeacher(ctx.db, 'b');
  const user = insertUser(ctx.db, 'u');
  const pkg = insertPackage(ctx.db, teacher, { price_cents: price });
  const rel = buyAndPay(ctx, user, pkg);
  return { ctx, db: ctx.db, teacher, sub, user, rel };
}

const sumBy = (db, teacherId) =>
  db.prepare('SELECT COALESCE(SUM(amount_cents),0) s FROM accruals WHERE teacher_id = ?').get(teacherId).s;

test('按日计提且幂等', () => {
  const w = world();
  assert.strictEqual(accrueForDate(w.db, '2026-11-01'), 1);
  assert.strictEqual(accrueForDate(w.db, '2026-11-01'), 0);
  const row = w.db.prepare('SELECT * FROM accruals').get();
  assert.strictEqual(row.amount_cents, 100);
  assert.strictEqual(row.teacher_id, w.teacher);
});

test('服务期外不计提', () => {
  const w = world();
  assert.strictEqual(accrueForDate(w.db, '2026-10-31'), 0);
  assert.strictEqual(accrueForDate(w.db, '2026-12-01'), 0);
});

test('代班期间计给代班老师', () => {
  const w = world();
  saveSegments(w.db, w.rel.id, applySubstitute(loadSegments(w.db, w.rel.id),
    { from: '2026-11-10', to: '2026-11-12', teacherId: w.sub }));
  accrueUpTo(w.db, '2026-11-30');
  assert.strictEqual(sumBy(w.db, w.sub), 300);
  assert.strictEqual(sumBy(w.db, w.teacher), 2700);
});

test('暂停不计提并顺延，总额精确等于订单金额', () => {
  const w = world(1000);
  saveSegments(w.db, w.rel.id, applyPause(loadSegments(w.db, w.rel.id), { from: '2026-11-10', to: '2026-11-14' }));
  assert.strictEqual(w.db.prepare('SELECT end_date FROM service_relations').get().end_date, '2026-12-05');
  accrueUpTo(w.db, '2026-12-05');
  assert.strictEqual(w.db.prepare("SELECT COUNT(*) c FROM accruals WHERE date = '2026-11-10'").get().c, 0);
  assert.strictEqual(w.db.prepare("SELECT amount_cents a FROM accruals WHERE date = '2026-11-15'").get().a, 34);
  assert.strictEqual(w.db.prepare('SELECT COUNT(*) c FROM accruals').get().c, 30);
  assert.strictEqual(sumBy(w.db, w.teacher), 1000);
});

test('冻结不计提，解冻后补算', () => {
  const w = world();
  w.db.prepare('UPDATE service_relations SET frozen = 1').run();
  assert.strictEqual(accrueUpTo(w.db, '2026-11-05'), 0);
  w.db.prepare('UPDATE service_relations SET frozen = 0').run();
  assert.strictEqual(accrueUpTo(w.db, '2026-11-05'), 5);
});

test('单次套餐不参与日计提', () => {
  const ctx = setup();
  const t = insertTeacher(ctx.db, 'a');
  const u = insertUser(ctx.db, 'u');
  buyAndPay(ctx, u, insertPackage(ctx.db, t, { type: 'single', days: 0, call_quota: 1, price_cents: 500 }));
  assert.strictEqual(accrueUpTo(ctx.db, '2026-11-30'), 0);
});

test('每日任务：计提到昨天并结束到期关系', () => {
  const w = world();
  const r = runDailyJobs(w.db, '2026-12-01');
  assert.deepStrictEqual(r, { accrued: 30, ended: 1 });
  assert.strictEqual(w.db.prepare('SELECT status FROM service_relations').get().status, 'ended');
  assert.strictEqual(sumBy(w.db, w.teacher), 3000);
});
```

**Step 2: 运行，确认失败**

Run: `node --test tests/accrual.test.js`
Expected: FAIL

**Step 3: 实现**

`server/src/services/accrual.js`：

```js
const { eachDay } = require('../lib/dates');
const { splitEvenly } = require('../lib/money');
const { loadSegments } = require('./relations');
const { segmentOn, activeDayIndex } = require('./segments');

function accrueForDate(db, date) {
  const rels = db.prepare(`SELECT * FROM service_relations
                           WHERE status = 'active' AND frozen = 0 AND package_type != 'single'
                             AND start_date <= ? AND end_date >= ?`).all(date, date);
  const ins = db.prepare(`INSERT OR IGNORE INTO accruals (relation_id, date, teacher_id, amount_cents)
                          VALUES (?, ?, ?, ?)`);
  let created = 0;
  db.transaction(() => {
    for (const r of rels) {
      const segs = loadSegments(db, r.id);
      const seg = segmentOn(segs, date);
      if (!seg || seg.kind === 'paused') continue;
      const idx = activeDayIndex(segs, date);
      if (idx >= r.total_days) continue;
      created += ins.run(r.id, date, seg.teacher_id, splitEvenly(r.amount_cents, r.total_days, idx)).changes;
    }
  })();
  return created;
}

function accrueUpTo(db, date) {
  const min = db.prepare(`SELECT MIN(start_date) m FROM service_relations
                          WHERE status = 'active' AND frozen = 0 AND package_type != 'single'`).get().m;
  if (!min || min > date) return 0;
  let n = 0;
  for (const d of eachDay(min, date)) n += accrueForDate(db, d);
  return n;
}

module.exports = { accrueForDate, accrueUpTo };
```

`server/src/jobs.js`：

```js
const { addDays, todayCN } = require('./lib/dates');
const { accrueUpTo } = require('./services/accrual');

function runDailyJobs(db, today) {
  const accrued = accrueUpTo(db, addDays(today, -1));
  const ended = db.prepare(`UPDATE service_relations SET status = 'ended'
                            WHERE status = 'active' AND frozen = 0 AND end_date < ?`).run(today).changes;
  return { accrued, ended };
}

function startJobs(db, config) {
  const tick = () => {
    try {
      const r = runDailyJobs(db, todayCN(config.now()));
      if (r.accrued || r.ended) console.log('[jobs]', r);
    } catch (e) {
      console.error('[jobs] 执行失败', e);
    }
  };
  tick();
  return setInterval(tick, 3600 * 1000);
}

module.exports = { runDailyJobs, startJobs };
```

**Step 4: 运行，确认通过**

Run: `node --test tests/accrual.test.js`
Expected: PASS（7 tests）

**Step 5: Commit**

```bash
git add server/src server/tests/accrual.test.js
git commit -m "feat: 按服务分段日计提与每日任务"
```

---

### Task 14: 周结算 + 人工打款登记 + 抽成配置

**Files:**
- Create: `server/src/services/settlement.js`
- Modify: `server/src/routes/admin.js`
- Test: `server/tests/settlement.test.js`

**规则：**
- 抽成比例存 `settings.commission_rate`，默认 0.2，范围 `[0, 1)`。
- 生成结算：按老师汇总区间内**未结算**且**所属关系未冻结**的计提，`commission = round(gross × rate)`，`net = gross − commission`，并回写 `accruals.settlement_id`。重复生成不会重复计入。
- 打款登记：仅 `pending` 可标记为 `paid`，记录凭证与操作人，写审计日志。

**Step 1: 写失败测试**

```js
const test = require('node:test');
const assert = require('node:assert');
const { setup, insertUser, insertTeacher, insertPackage, buyAndPay, adminToken } = require('./helpers');
const { accrueUpTo } = require('../src/services/accrual');
const { generateSettlements } = require('../src/services/settlement');

function world() {
  const ctx = setup();
  const teacher = insertTeacher(ctx.db, 'a');
  const user = insertUser(ctx.db, 'u');
  const rel = buyAndPay(ctx, user, insertPackage(ctx.db, teacher, { price_cents: 3000 }));
  accrueUpTo(ctx.db, '2026-11-07');
  return { ctx, db: ctx.db, teacher, rel };
}

test('生成结算：默认抽成 20%，不重复计入', () => {
  const w = world();
  const [s] = generateSettlements(w.db, { periodStart: '2026-11-01', periodEnd: '2026-11-07' });
  assert.strictEqual(s.teacher_id, w.teacher);
  assert.strictEqual(s.gross_cents, 700);
  assert.strictEqual(s.commission_cents, 140);
  assert.strictEqual(s.net_cents, 560);
  assert.deepStrictEqual(generateSettlements(w.db, { periodStart: '2026-11-01', periodEnd: '2026-11-07' }), []);
});

test('冻结关系的计提不进入结算', () => {
  const w = world();
  w.db.prepare('UPDATE service_relations SET frozen = 1').run();
  assert.deepStrictEqual(generateSettlements(w.db, { periodStart: '2026-11-01', periodEnd: '2026-11-07' }), []);
});

test('管理接口：改抽成 → 生成 → 列表 → 登记打款 → 重复登记 409', async () => {
  const w = world();
  const admin = { Authorization: `Bearer ${await adminToken(w.ctx)}` };

  assert.strictEqual((await w.ctx.api.put('/api/admin/settings/commission-rate').set(admin).send({ rate: 1 })).status, 400);
  assert.strictEqual((await w.ctx.api.put('/api/admin/settings/commission-rate').set(admin).send({ rate: 0.3 })).status, 200);

  const gen = await w.ctx.api.post('/api/admin/settlements/generate').set(admin)
    .send({ periodStart: '2026-11-01', periodEnd: '2026-11-07' });
  assert.strictEqual(gen.status, 201);
  assert.strictEqual(gen.body[0].commission_cents, 210);
  assert.strictEqual(gen.body[0].net_cents, 490);

  const list = await w.ctx.api.get('/api/admin/settlements?status=pending').set(admin);
  assert.strictEqual(list.body.length, 1);
  assert.strictEqual(list.body[0].teacher_name, `老师${w.teacher}`);

  const id = gen.body[0].id;
  const paid = await w.ctx.api.post(`/api/admin/settlements/${id}/pay`).set(admin).send({ proof: '支付宝转账单号 123' });
  assert.strictEqual(paid.status, 200);
  assert.strictEqual(paid.body.status, 'paid');
  assert.strictEqual((await w.ctx.api.post(`/api/admin/settlements/${id}/pay`).set(admin).send({ proof: 'x' })).status, 409);

  const logs = w.db.prepare("SELECT action FROM audit_logs ORDER BY id").all().map((r) => r.action);
  assert.deepStrictEqual(logs, ['settings.commission_rate', 'settlement.generate', 'settlement.pay']);
});

test('登记打款必须填写凭证', async () => {
  const w = world();
  const admin = { Authorization: `Bearer ${await adminToken(w.ctx)}` };
  const [s] = generateSettlements(w.db, { periodStart: '2026-11-01', periodEnd: '2026-11-07' });
  const res = await w.ctx.api.post(`/api/admin/settlements/${s.id}/pay`).set(admin).send({});
  assert.strictEqual(res.status, 400);
});
```

**Step 2: 运行，确认失败**

Run: `node --test tests/settlement.test.js`
Expected: FAIL

**Step 3: 实现**

`server/src/services/settlement.js`：

```js
const { HttpError } = require('../lib/errors');

const DEFAULT_RATE = 0.2;
const NOT_FROZEN = 'relation_id NOT IN (SELECT id FROM service_relations WHERE frozen = 1)';

function getCommissionRate(db) {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'commission_rate'").get();
  return r ? Number(r.value) : DEFAULT_RATE;
}

function setCommissionRate(db, rate) {
  if (typeof rate !== 'number' || !(rate >= 0 && rate < 1)) throw new HttpError(400, '抽成比例须在 [0, 1) 之间');
  db.prepare(`INSERT INTO settings (key, value) VALUES ('commission_rate', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(rate));
}

function generateSettlements(db, { periodStart, periodEnd }) {
  if (!periodStart || !periodEnd || periodStart > periodEnd) throw new HttpError(400, '结算区间非法');
  const rate = getCommissionRate(db);
  const ids = [];
  db.transaction(() => {
    const rows = db.prepare(`SELECT teacher_id, SUM(amount_cents) AS gross FROM accruals
                             WHERE settlement_id IS NULL AND date BETWEEN ? AND ? AND ${NOT_FROZEN}
                             GROUP BY teacher_id ORDER BY teacher_id`).all(periodStart, periodEnd);
    for (const r of rows) {
      const commission = Math.round(r.gross * rate);
      const id = db.prepare(`INSERT INTO settlements (teacher_id, period_start, period_end, gross_cents, commission_cents, net_cents)
                             VALUES (?, ?, ?, ?, ?, ?)`)
        .run(r.teacher_id, periodStart, periodEnd, r.gross, commission, r.gross - commission).lastInsertRowid;
      db.prepare(`UPDATE accruals SET settlement_id = ?
                  WHERE settlement_id IS NULL AND teacher_id = ? AND date BETWEEN ? AND ? AND ${NOT_FROZEN}`)
        .run(id, r.teacher_id, periodStart, periodEnd);
      ids.push(id);
    }
  })();
  return ids.map((id) => db.prepare('SELECT * FROM settlements WHERE id = ?').get(id));
}

function markSettlementPaid(db, id, { proof, adminId }) {
  if (!proof) throw new HttpError(400, '请填写打款凭证');
  const r = db.prepare(`UPDATE settlements SET status = 'paid', proof = ?, operator_id = ?, paid_at = datetime('now')
                        WHERE id = ? AND status = 'pending'`).run(proof, adminId, id);
  if (!r.changes) throw new HttpError(409, '结算单不存在或已打款');
  return db.prepare('SELECT * FROM settlements WHERE id = ?').get(id);
}

module.exports = { getCommissionRate, setCommissionRate, generateSettlements, markSettlementPaid };
```

`server/src/routes/admin.js` 顶部加：

```js
const settlement = require('../services/settlement');
```

并追加路由：

```js
  router.put('/settings/commission-rate', (req, res) => {
    const rate = req.body && req.body.rate;
    settlement.setCommissionRate(db, rate);
    audit(db, req.adminId, 'settings.commission_rate', 'settings', { rate });
    res.json({ rate });
  });

  router.post('/settlements/generate', (req, res) => {
    const { periodStart, periodEnd } = req.body || {};
    const rows = settlement.generateSettlements(db, { periodStart, periodEnd });
    audit(db, req.adminId, 'settlement.generate', `period:${periodStart}~${periodEnd}`, { ids: rows.map((r) => r.id) });
    res.status(201).json(rows);
  });

  router.get('/settlements', (req, res) => {
    const { status } = req.query;
    const sql = `SELECT s.*, t.display_name AS teacher_name FROM settlements s
                 JOIN teacher_profiles t ON t.user_id = s.teacher_id
                 ${status ? 'WHERE s.status = ?' : ''} ORDER BY s.id DESC`;
    res.json(status ? db.prepare(sql).all(status) : db.prepare(sql).all());
  });

  router.post('/settlements/:id/pay', (req, res) => {
    const id = Number(req.params.id);
    const row = settlement.markSettlementPaid(db, id, { proof: req.body && req.body.proof, adminId: req.adminId });
    audit(db, req.adminId, 'settlement.pay', `settlement:${id}`, { net_cents: row.net_cents, proof: row.proof });
    res.json(row);
  });
```

**Step 4: 运行，确认通过**

Run: `node --test tests/settlement.test.js`
Expected: PASS（4 tests）

**Step 5: Commit**

```bash
git add server/src server/tests/settlement.test.js
git commit -m "feat: 周结算、人工打款登记与抽成配置"
```

---

### Task 15: 管理端订单查询与 CSV 导出

**Files:**
- Modify: `server/src/routes/admin.js`
- Test: `server/tests/admin-orders.test.js`

**目标：** 回答"哪个用户给哪个老师付了多少钱"。支持按 `userId`、`teacherId`、`status`、`from`、`to`（北京时间日期）筛选；CSV 带 BOM，Excel 可直接打开。

**Step 1: 写失败测试**

```js
const test = require('node:test');
const assert = require('node:assert');
const { setup, insertUser, insertTeacher, insertPackage, buyAndPay, adminToken } = require('./helpers');
const { createOrder } = require('../src/services/orders');

async function world() {
  const ctx = setup();
  const a = insertTeacher(ctx.db, 'a');
  const b = insertTeacher(ctx.db, 'b');
  const u = insertUser(ctx.db, 'u');
  buyAndPay(ctx, u, insertPackage(ctx.db, a, { price_cents: 3000, title: '包月, 情感' }));
  createOrder(ctx.db, { userId: u, packageId: insertPackage(ctx.db, b, { price_cents: 500 }), provider: 'zpay', nowMs: ctx.config.now() });
  const admin = { Authorization: `Bearer ${await adminToken(ctx)}` };
  return { ctx, a, b, u, admin };
}

test('订单列表含用户、老师、套餐、金额，可按老师/状态筛选', async () => {
  const w = await world();
  const all = await w.ctx.api.get('/api/admin/orders').set(w.admin);
  assert.strictEqual(all.body.length, 2);
  const byA = await w.ctx.api.get('/api/admin/orders').query({ teacherId: w.a }).set(w.admin);
  assert.strictEqual(byA.body.length, 1);
  assert.strictEqual(byA.body[0].user_id, w.u);
  assert.strictEqual(byA.body[0].teacher_name, `老师${w.a}`);
  assert.strictEqual(byA.body[0].package_title, '包月, 情感');
  assert.strictEqual(byA.body[0].amount_cents, 3000);
  const paid = await w.ctx.api.get('/api/admin/orders').query({ status: 'paid' }).set(w.admin);
  assert.strictEqual(paid.body.length, 1);
});

test('CSV 导出：BOM + 表头 + 含逗号字段加引号', async () => {
  const w = await world();
  const res = await w.ctx.api.get('/api/admin/orders.csv').query({ status: 'paid' }).set(w.admin);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  const lines = res.text.replace(/^\ufeff/, '').trim().split('\n');
  assert.ok(res.text.startsWith('\ufeff'));
  assert.strictEqual(lines[0], '订单号,用户ID,用户昵称,老师ID,老师,套餐,金额(元),状态,支付时间');
  assert.strictEqual(lines.length, 2);
  assert.match(lines[1], /"包月, 情感",30\.00,paid/);
});
```

**Step 2: 运行，确认失败**

Run: `node --test tests/admin-orders.test.js`
Expected: FAIL

**Step 3: 实现**

`server/src/routes/admin.js` 顶部加：

```js
const { centsToYuan } = require('../lib/money');

function queryOrders(db, q) {
  const where = [];
  const args = [];
  if (q.userId) { where.push('o.user_id = ?'); args.push(Number(q.userId)); }
  if (q.teacherId) { where.push('o.teacher_id = ?'); args.push(Number(q.teacherId)); }
  if (q.status) { where.push('o.status = ?'); args.push(q.status); }
  if (q.from) { where.push("date(o.created_at, '+8 hours') >= ?"); args.push(q.from); }
  if (q.to) { where.push("date(o.created_at, '+8 hours') <= ?"); args.push(q.to); }
  return db.prepare(`SELECT o.out_trade_no, o.user_id, u.nickname AS user_nickname, o.teacher_id,
                            t.display_name AS teacher_name, json_extract(o.package_snapshot, '$.title') AS package_title,
                            o.amount_cents, o.status, o.trade_no, o.paid_at, o.created_at
                     FROM orders o
                     JOIN users u ON u.id = o.user_id
                     JOIN teacher_profiles t ON t.user_id = o.teacher_id
                     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                     ORDER BY o.id DESC`).all(...args);
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
```

追加路由：

```js
  router.get('/orders', (req, res) => res.json(queryOrders(db, req.query)));

  router.get('/orders.csv', (req, res) => {
    const header = ['订单号', '用户ID', '用户昵称', '老师ID', '老师', '套餐', '金额(元)', '状态', '支付时间'];
    const lines = queryOrders(db, req.query).map((o) => [
      o.out_trade_no, o.user_id, o.user_nickname, o.teacher_id, o.teacher_name,
      o.package_title, centsToYuan(o.amount_cents), o.status, o.paid_at,
    ].map(csvCell).join(','));
    audit(db, req.adminId, 'orders.export', 'orders', req.query);
    res.type('text/csv; charset=utf-8')
      .set('Content-Disposition', 'attachment; filename="orders.csv"')
      .send(`\ufeff${[header.join(','), ...lines].join('\n')}\n`);
  });
```

**Step 4: 运行，确认通过**

Run: `node --test tests/admin-orders.test.js`
Expected: PASS（2 tests）

**Step 5: Commit**

```bash
git add server/src server/tests/admin-orders.test.js
git commit -m "feat: 管理端订单查询与 CSV 导出"
```

---

### Task 16: 启动入口 + 冒烟验证

**Files:**
- Create: `server/src/index.js`

**Step 1: 实现入口**

```js
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { startJobs } = require('./jobs');

const config = loadConfig();
const db = openDb(config.dbFile);
const app = createApp({ db, config });
startJobs(db, config);

app.listen(config.port, () => {
  console.log(`[LiaoYu] listening on :${config.port}`);
  if (!config.zpay.pid || !config.zpay.key) console.warn('[LiaoYu] ZPAY 未配置，支付走 MOCK 收银台');
  if (!config.wx.secret) console.warn('[LiaoYu] WX_APPSECRET 未配置，微信登录走 MOCK');
  if (config.jwtSecret === 'dev-user-secret') console.warn('[LiaoYu] 使用默认 JWT_SECRET，上线前必须修改');
});
```

**Step 2: 全量测试**

Run: `cd /data/workspace/ngr/wx/LiaoYu/server && npm test`
Expected: 全部 PASS，0 fail

**Step 3: 冒烟**

```bash
cd /data/workspace/ngr/wx/LiaoYu/server
DB_FILE=/tmp/liaoyu-smoke.db PORT=8711 node src/index.js &
sleep 1
curl -s http://localhost:8711/api/health
curl -s -X POST http://localhost:8711/api/auth/wxlogin -H 'Content-Type: application/json' -d '{"code":"smoke"}'
kill %1; rm -f /tmp/liaoyu-smoke.db*
```

Expected: `{"ok":true}`；登录返回含 `token` 的 JSON。

**Step 4: Commit**

```bash
git add server/src/index.js
git commit -m "feat: 服务启动入口与定时任务"
```

---

## 第一阶段完成标准

- `npm test` 全绿（约 60 个用例）。
- MOCK 模式下可走通：登录 → 申请入驻 → 管理员审核 → 建套餐 → 用户下单 → 模拟付款 → 服务关系生成 → 每日任务计提 → 生成周结算 → 登记打款 → 导出订单 CSV。
- 配置 `ZPAY_PID/ZPAY_KEY/PUBLIC_BASE_URL` 后，真实支付宝付款可通过 `/api/pay/notify` 自动开通服务。

## 已知遗留（后续阶段处理）

- 请假/代班/暂停的业务接口（第二阶段，复用 `applySubstitute` / `applyPause` / `saveSegments`）。
- 单次套餐按通话完成计提（第二阶段）。
- 工单与冻结的业务入口（第五阶段，计提与结算已支持 `frozen`）。
- 管理员登录限流、HTTPS、生产部署（管理网页阶段一并处理）。
