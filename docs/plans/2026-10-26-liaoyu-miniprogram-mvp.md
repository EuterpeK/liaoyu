# LiaoYu 小程序端 MVP 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 新建 `apps/miniprogram` 原生微信小程序（纯 JS、零构建），打通学员核心闭环：登录 → 浏览老师 → 买套餐 → 预约 → 我的服务；老师角色提供最小视图。

**Architecture:** 原生小程序单包双角色：静态 tabBar「首页/服务/我的」，各页按 `/api/auth/me` 的角色分支渲染。请求层统一封装 Bearer token 与 401 自动重登；MOCK 支付走后端模拟收银台 + 订单轮询。

**Tech Stack:** 微信原生小程序（WXML/WXSS/JS，无框架无构建）；后端 Fastify `apps/server`（已交付，MOCK 模式可本地跑通全流程）。

**设计文档:** `docs/plans/2026-10-26-miniprogram-client-design.md`

**测试说明:** 小程序端零构建、不加单测框架；每个 Task 的验证 = 后端 curl 冒烟（MOCK）+ 开发者工具手工操作路径。后端质量由现有 `pnpm check` 保障。

**与设计稿的两处修正（依据接口现实）:**
- 预约入口在「我的服务 → 我的老师」进入（`GET /api/appointments/slots` 需要 `relationId`，师生关系由订单履约创建），不在老师详情页直接约。
- 支付：`POST /api/orders` 返回 `{outTradeNo, amountCents, payUrl, mock}`；MOCK 时 `POST /api/pay/mock/confirm?out_trade_no=` 后轮询 `GET /api/orders/:outTradeNo` 至 `paid`。正式 `wx.requestPayment` 仅留适配函数占位。

---

## 准备：环境

```bash
cd /data/workspace/ngr/wx/LiaoYu
source ~/.nvm/nvm.sh && nvm use 24
pnpm db:up                            # PostgreSQL 54329
pnpm -F @liaoyu/server dev            # http://localhost:8700（未配 WX_*/ZPAY_* 即 MOCK）
```

MOCK 登录冒烟（后续 Task 验证都依赖它）：

```bash
curl -s -X POST localhost:8700/api/auth/wxlogin -H 'content-type: application/json' -d '{"code":"dev"}'
# 期望: {"token":"...","user":{"id":N,"nickname":null}}
```

微信开发者工具：导入项目指向 `apps/miniprogram`，AppID 选「测试号」，详情→本地设置→勾选「不校验合法域名」。

---

### Task 1: 工程骨架与全局配置

**Files:**
- Create: `apps/miniprogram/project.config.json`
- Create: `apps/miniprogram/sitemap.json`
- Create: `apps/miniprogram/app.json`
- Create: `apps/miniprogram/app.js`
- Create: `apps/miniprogram/app.wxss`
- Create: `apps/miniprogram/config/env.js`

**Step 1: project.config.json（修掉 app.json is not found 报错的根）**

```json
{
  "appid": "touristappid",
  "compileType": "miniprogram",
  "libVersion": "latest",
  "setting": {
    "es6": true,
    "postcss": true,
    "minified": true,
    "urlCheck": false
  },
  "projectname": "liaoyu",
  "miniprogramRoot": "./"
}
```

**Step 2: sitemap.json**

```json
{ "desc": "关于本文件的更多信息，请参考文档", "rules": [{ "action": "allow", "page": "*" }] }
```

**Step 3: app.json（tabBar 三页 + 首版全部页面路径，页面文件 Task 3+ 逐个补齐；本 Task 先建三个 tab 占位页）**

```json
{
  "pages": [
    "pages/index/index",
    "pages/services/services",
    "pages/profile/profile",
    "pages/login/login",
    "pages/teacher/detail/detail",
    "pages/package/buy/buy",
    "pages/appointment/book/book"
  ],
  "window": {
    "navigationBarBackgroundColor": "#ffffff",
    "navigationBarTextStyle": "black",
    "navigationBarTitleText": "LiaoYu",
    "backgroundColor": "#f5f6f8"
  },
  "tabBar": {
    "color": "#999999",
    "selectedColor": "#1677ff",
    "list": [
      { "pagePath": "pages/index/index", "text": "首页" },
      { "pagePath": "pages/services/services", "text": "服务" },
      { "pagePath": "pages/profile/profile", "text": "我的" }
    ]
  },
  "sitemapLocation": "sitemap.json"
}
```

注意：`pages` 里声明的每个路径必须有对应 4 件套，否则编译报错。本 Task 先创建三个 tab 页与 login 的占位（`.js/.wxml/.wxss/.json` 最小内容），其余三个页面路径暂不写入 `app.json`，在各自 Task 里再追加声明。

修正后的本 Task `app.json` 的 `pages` 数组为：

```json
["pages/index/index", "pages/services/services", "pages/profile/profile", "pages/login/login"]
```

**Step 4: config/env.js**

```js
// 开发直连本地后端；生产换成 https://$DOMAIN（需加入小程序 request 合法域名）
const ENV = 'dev';

const BASE_URLS = {
  dev: 'http://localhost:8700',
  prod: 'https://CHANGE_ME.example.com',
};

module.exports = { baseURL: BASE_URLS[ENV] };
```

**Step 5: app.js（全局登录就绪 Promise，页面用 `getApp().ensureLoginReady()` 等待）**

```js
const auth = require('./utils/auth.js');

App({
  loginPromise: null,

  ensureLoginReady() {
    if (!this.loginPromise) {
      this.loginPromise = auth.ensureLogin().catch((e) => {
        this.loginPromise = null;
        throw e;
      });
    }
    return this.loginPromise;
  },

  resetLogin() {
    this.loginPromise = null;
  },
});
```

注意：`utils/auth.js` 在 Task 2 才创建，本 Task 提交前 `app.js` 的 require 会报错——所以 Task 1 的 `app.js` 暂时只写 `App({})`，Task 2 补全。

**Step 6: app.wxss（全局基础样式）**

```css
page {
  background: #f5f6f8;
  font-size: 28rpx;
  color: #222;
}
.card {
  background: #fff;
  border-radius: 16rpx;
  padding: 28rpx;
  margin: 20rpx;
}
.btn {
  background: #1677ff;
  color: #fff;
  border-radius: 12rpx;
  font-size: 30rpx;
  padding: 20rpx 0;
  text-align: center;
}
.btn[disabled] {
  opacity: 0.5;
}
.muted {
  color: #999;
  font-size: 24rpx;
}
.empty {
  text-align: center;
  color: #999;
  padding: 80rpx 0;
}
```

**Step 7: 三个 tab 页 + login 占位**

每页四件套，以 `pages/index/index` 为例（其余三个同理，标题不同）：

`pages/index/index.js`：

```js
Page({
  data: { ready: false },
});
```

`pages/index/index.wxml`：

```xml
<view class="empty" wx:if="{{!ready}}">加载中…</view>
```

`pages/index/index.wxss`：空文件。
`pages/index/index.json`：`{ "navigationBarTitleText": "首页" }`（services 页为「服务」，profile 页为「我的」，login 页为「登录」）。

**Step 8: 验证**

- 微信开发者工具导入 `apps/miniprogram`：编译通过、无 app.json 报错、底部出现三个 tab、模拟器显示「加载中…」。
- 终端确认目录完整：`ls apps/miniprogram` 出现 `app.js app.json app.wxss project.config.json sitemap.json config/ pages/ utils/(暂无)`。

**Step 9: Commit**

```bash
git add apps/miniprogram
git commit -m "feat(miniprogram): 工程骨架与全局配置（tabBar/环境/样式）"
```

---

### Task 2: 基础设施 utils（request / auth / format）

**Files:**
- Create: `apps/miniprogram/utils/request.js`
- Create: `apps/miniprogram/utils/auth.js`
- Create: `apps/miniprogram/utils/format.js`
- Modify: `apps/miniprogram/app.js`（补 require）

**Step 1: utils/auth.js（登录与角色）**

```js
const { baseURL } = require('../config/env.js');

const TOKEN_KEY = 'liaoyu_token';

function raw(method, path, data) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: baseURL + path,
      method,
      data,
      success: (res) => (res.statusCode >= 200 && res.statusCode < 300 ? resolve(res.data) : reject(res)),
      fail: () => reject(new Error('network')),
    });
  });
}

function wxLoginCode() {
  return new Promise((resolve, reject) => wx.login({ success: (r) => resolve(r.code), fail: reject }));
}

function fetchMe() {
  return new Promise((resolve, reject) => {
    wx.request({
      url: baseURL + '/api/auth/me',
      header: { Authorization: 'Bearer ' + (wx.getStorageSync(TOKEN_KEY) || '') },
      success: (res) => (res.statusCode === 200 ? resolve(res.data) : reject(res)),
      fail: () => reject(new Error('network')),
    });
  });
}

/** 确保已登录并返回 { user, teacher, role }；role: 'teacher' | 'student' */
async function ensureLogin() {
  const token = wx.getStorageSync(TOKEN_KEY);
  if (token) {
    const me = await fetchMe().catch(() => null);
    if (me) return withRole(me);
  }
  const res = await raw('POST', '/api/auth/wxlogin', { code: await wxLoginCode() });
  wx.setStorageSync(TOKEN_KEY, res.token);
  return withRole(await fetchMe());
}

/** 401 时强制重登（request 层调用） */
async function relogin() {
  wx.removeStorageSync(TOKEN_KEY);
  return ensureLogin();
}

function withRole(me) {
  const role = me.teacher && me.teacher.status === 'active' ? 'teacher' : 'student';
  return { ...me, role };
}

module.exports = { ensureLogin, relogin, fetchMe, withRole };
```

**Step 2: utils/request.js（统一请求层）**

```js
const { baseURL } = require('../config/env.js');
const auth = require('./auth.js');

function toast(msg) {
  wx.showToast({ title: msg, icon: 'none' });
}

function request(method, path, { data, silent } = {}) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: baseURL + path,
      method,
      data,
      header: { Authorization: 'Bearer ' + (wx.getStorageSync('liaoyu_token') || '') },
      success: async (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(res.data);
        if (res.statusCode === 401 && !silent) {
          try {
            await auth.relogin();
            return resolve(await request(method, path, { data, silent: true }));
          } catch (e) {
            if (!silent) toast('请先登录');
            return reject(e);
          }
        }
        const msg = (res.data && res.data.error) || '请求失败';
        if (!silent) toast(msg);
        return reject(new Error(msg));
      },
      fail: () => {
        if (!silent) toast('网络异常，请重试');
        reject(new Error('network'));
      },
    });
  });
}

module.exports = {
  get: (path, opts) => request('GET', path, opts),
  post: (path, data, opts) => request('POST', path, { ...opts, data }),
};
```

**Step 3: utils/format.js**

```js
const FEN = (cents) => (cents / 100).toFixed(2);

const ymd = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 未来 n 天（含今天）的 [{date, label}]，label 如「10-26 周一」 */
function nextDays(n) {
  const weeks = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const today = new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    return { date: ymd(d), label: `${ymd(d).slice(5)} ${weeks[d.getDay()]}` };
  });
}

module.exports = { FEN, ymd, nextDays };
```

**Step 4: app.js 补 require（替换 Task 1 的占位）**

```js
const auth = require('./utils/auth.js');

App({
  loginPromise: null,

  ensureLoginReady() {
    if (!this.loginPromise) {
      this.loginPromise = auth.ensureLogin().catch((e) => {
        this.loginPromise = null;
        throw e;
      });
    }
    return this.loginPromise;
  },

  resetLogin() {
    this.loginPromise = null;
  },
});
```

**Step 5: 验证**

- 开发者工具编译无报错（Console 无模块找不到）。
- Mock 验证后端可达：`curl -s localhost:8700/api/health` → `{"ok":true}`。
- 在开发者工具 Console 执行 `getApp().ensureLoginReady().then(console.log)`：应输出 `{user:{id,...}, teacher:null, role:'student'}`（MOCK 登录）。

**Step 6: Commit**

```bash
git add apps/miniprogram
git commit -m "feat(miniprogram): 请求层与登录基础设施"
```

---

### Task 3: 登录页 + 首页双视图（老师列表 / 老师今日概览）

**Files:**
- Modify: `apps/miniprogram/pages/login/login.*`（占位 → 完整）
- Modify: `apps/miniprogram/pages/index/index.*`（占位 → 完整）

**Step 1: pages/login/login.js**

```js
Page({
  data: { loading: false },

  async onTapLogin() {
    this.setData({ loading: true });
    try {
      const me = await getApp().ensureLoginReady();
      wx.reLaunch({ url: '/pages/index/index' });
    } catch (e) {
      /* toast 已由下层给出 */
    }
    this.setData({ loading: false });
  },
});
```

**Step 2: pages/login/login.wxml**

```xml
<view class="login">
  <view class="logo">LiaoYu</view>
  <view class="muted">陪伴咨询平台</view>
  <button class="btn login-btn" disabled="{{loading}}" bindtap="onTapLogin">
    {{loading ? '登录中…' : '微信一键登录'}}
  </button>
</view>
```

**Step 3: pages/login/login.wxss**

```css
.login {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 240rpx;
}
.logo {
  font-size: 64rpx;
  font-weight: 700;
  margin-bottom: 12rpx;
}
.login-btn {
  width: 80%;
  margin-top: 120rpx;
}
```

**Step 4: pages/index/index.js（双视图）**

```js
const api = require('../../utils/request.js');
const { FEN } = require('../../utils/format.js');

Page({
  data: { role: 'student', loading: true, teachers: [], directions: [], direction: '', appointments: [], todayLabel: '' },

  async onShow() {
    try {
      const me = await getApp().ensureLoginReady();
      this.setData({ role: me.role });
      if (me.role === 'teacher') await this.loadTeacherHome();
      else await this.loadTeachers();
    } catch (e) {
      wx.redirectTo({ url: '/pages/login/login' });
    }
  },

  async loadTeachers() {
    this.setData({ loading: true });
    const q = this.data.direction ? `?direction=${encodeURIComponent(this.data.direction)}` : '';
    const teachers = await api.get(`/api/teachers${q}`, { silent: true }).catch(() => []);
    this.setData({ teachers, loading: false });
  },

  async loadTeacherHome() {
    const list = await api.get('/api/teacher/appointments', { silent: true }).catch(() => []);
    const todayLabel = new Date().toLocaleDateString('zh-CN');
    this.setData({ appointments: list, todayLabel, loading: false });
  },

  onTapDirection(e) {
    const direction = e.currentTarget.dataset.d === this.data.direction ? '' : e.currentTarget.dataset.d;
    this.setData({ direction }, () => this.loadTeachers());
  },

  onTapTeacher(e) {
    wx.navigateTo({ url: `/pages/teacher/detail/detail?id=${e.currentTarget.dataset.id}` });
  },
});
```

**Step 5: pages/index/index.wxml**

```xml
<view wx:if="{{loading}}">
  <view class="empty">加载中…</view>
</view>

<!-- 学员：老师列表 -->
<block wx:elif="{{role === 'student'}}">
  <view class="filter" wx:if="{{directions.length}}">
    <view
      wx:for="{{directions}}"
      wx:key="*this"
      class="chip {{direction === item ? 'chip-on' : ''}}"
      data-d="{{item}}"
      bindtap="onTapDirection"
    >{{item}}</view>
  </view>
  <view class="card" wx:for="{{teachers}}" wx:key="id" data-id="{{item.id}}" bindtap="onTapTeacher">
    <view class="row">
      <text class="name">{{item.displayName}}</text>
      <text class="level">Lv{{item.level}}</text>
    </view>
    <view class="muted">{{item.intro}}</view>
    <view class="row">
      <text class="muted" wx:for="{{item.directions}}" wx:for-item="d" wx:key="*this">{{d}} </text>
      <text class="price" wx:if="{{item.minPriceCents}}">¥{{item.minPriceCents / 100}} 起</text>
    </view>
  </view>
  <view class="empty" wx:if="{{!teachers.length}}">暂无老师入驻</view>
</block>

<!-- 老师：今日概览 -->
<block wx:else>
  <view class="card">
    <view class="name">今日概览（{{todayLabel}}）</view>
    <view class="muted">共 {{appointments.length}} 条预约</view>
  </view>
  <view class="card" wx:for="{{appointments}}" wx:key="id">
    <view class="row">
      <text>{{item.date}} {{item.start}}</text>
      <text class="muted">{{item.status}}</text>
    </view>
  </view>
  <view class="empty" wx:if="{{!appointments.length}}">暂无预约</view>
</block>
```

**Step 6: pages/index/index.wxss**

```css
.filter {
  display: flex;
  flex-wrap: wrap;
  padding: 20rpx;
}
.chip {
  background: #fff;
  border-radius: 999rpx;
  padding: 10rpx 28rpx;
  margin: 0 16rpx 16rpx 0;
  font-size: 24rpx;
  color: #666;
}
.chip-on {
  background: #1677ff;
  color: #fff;
}
.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.name {
  font-size: 32rpx;
  font-weight: 600;
}
.level {
  color: #1677ff;
  font-size: 24rpx;
}
.price {
  color: #e6533c;
}
```

注意：首页 `directions`（可选方向筛选）后端未提供枚举接口，首版先置空数组（`data.directions` 初始即 `[]`），筛选 UI 不展示；`onTapDirection` 保留备用。这是 YAGNI 取舍：等管理端定义方向枚举后再接。

**Step 7: 验证（开发者工具 + 后端造数）**

后端造一个老师 + 套餐（MOCK）：

```bash
TOKEN=$(curl -s -X POST localhost:8700/api/auth/wxlogin -H 'content-type: application/json' -d '{"code":"teacher"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -s -X POST localhost:8700/api/teacher -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"displayName":"测试老师","realName":"张三","intro":"擅长倾听","directions":["学业"],"credentials":["证书A"]}'
# 老师申请需 admin 审核通过后才出现在公开列表；用 create-admin：
pnpm -F @liaoyu/server create-admin boss 'password-123456'
ADMIN=$(curl -s -X POST localhost:8700/api/admin/login -H 'content-type: application/json' -d '{"username":"boss","password":"password-123456"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -s -X POST localhost:8700/api/admin/teachers/2/review -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' -d '{"approve":true,"level":2}'
curl -s 'localhost:8700/api/teachers'   # 期望出现测试老师（id=2）
```

- 学员身份（另一个 code 登录的用户）打开首页：能看到测试老师卡片；点击进入详情页（Task 4 才有内容，先允许白屏）。
- 老师身份（token 存 storage 的那个号）打开首页：显示「今日概览 共 0 条」。

**Step 8: Commit**

```bash
git add apps/miniprogram
git commit -m "feat(miniprogram): 登录页与首页双角色视图"
```

---

### Task 4: 老师详情 + 套餐购买（MOCK 支付闭环）

**Files:**
- Modify: `apps/miniprogram/app.json`（pages 追加 `pages/teacher/detail/detail`、`pages/package/buy/buy`）
- Create: `apps/miniprogram/pages/teacher/detail/detail.*`
- Create: `apps/miniprogram/pages/package/buy/buy.*`

**Step 1: app.json 的 pages 数组改为**

```json
[
  "pages/index/index",
  "pages/services/services",
  "pages/profile/profile",
  "pages/login/login",
  "pages/teacher/detail/detail",
  "pages/package/buy/buy"
]
```

**Step 2: pages/teacher/detail/detail.js**

```js
const api = require('../../../utils/request.js');
const { FEN } = require('../../../utils/format.js');

const TYPE_TEXT = { regular: '常规陪伴', intensive: '强化陪伴', single: '单次通话' };

Page({
  data: { t: null, packages: [] },

  async onLoad({ id }) {
    const t = await api.get(`/api/teachers/${id}`).catch(() => null);
    if (!t) return wx.showToast({ title: '老师不存在', icon: 'none' });
    this.setData({
      t,
      packages: t.packages.map((p) => ({ ...p, typeText: TYPE_TEXT[p.type] || p.type, yuan: FEN(p.priceCents) })),
    });
  },

  onTapBuy(e) {
    const p = this.data.packages.find((x) => x.id === e.currentTarget.dataset.id);
    wx.navigateTo({ url: `/pages/package/buy/buy?packageId=${p.id}&title=${encodeURIComponent(p.title)}&yuan=${p.yuan}` });
  },
});
```

**Step 3: pages/teacher/detail/detail.wxml**

```xml
<view class="card" wx:if="{{t}}">
  <view class="row">
    <text class="name">{{t.displayName}}</text>
    <text class="level">Lv{{t.level}}</text>
  </view>
  <view class="muted">{{t.intro}}</view>
</view>
<view class="card" wx:for="{{packages}}" wx:key="id">
  <view class="row">
    <text class="name">{{item.title}}</text>
    <text class="price">¥{{item.yuan}}</text>
  </view>
  <view class="muted">{{item.typeText}} · {{item.replyHours}}小时内回复 · 通话额度 {{item.callQuota}}</view>
  <button class="btn buy-btn" data-id="{{item.id}}" bindtap="onTapBuy">购买</button>
</view>
<view class="empty" wx:if="{{t && !packages.length}}">该老师暂无在售套餐</view>
```

**Step 4: pages/teacher/detail/detail.wxss**

```css
@import "../../../app.wxss";
.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8rpx;
}
.name {
  font-size: 32rpx;
  font-weight: 600;
}
.level {
  color: #1677ff;
  font-size: 24rpx;
}
.price {
  color: #e6533c;
  font-weight: 600;
}
.buy-btn {
  margin-top: 16rpx;
}
```

**Step 5: pages/package/buy/buy.js（MOCK 支付 + 轮询；正式 JSAPI 留适配函数）**

```js
const api = require('../../../utils/request.js');

Page({
  data: { title: '', yuan: '', packageId: 0, paying: false, paid: false },

  onLoad({ packageId, title, yuan }) {
    this.setData({ packageId: Number(packageId), title: decodeURIComponent(title), yuan });
  },

  async onTapPay() {
    if (this.data.paying) return;
    this.setData({ paying: true });
    try {
      const order = await api.post('/api/orders', { packageId: this.data.packageId });
      if (order.mock) {
        await this.mockPay(order.outTradeNo);
      } else {
        this.realPay(order); // 正式环境：wx.requestPayment 适配，首版不实现
        return;
      }
      await this.waitPaid(order.outTradeNo);
      this.setData({ paid: true, paying: false });
      wx.showToast({ title: '支付成功', icon: 'success' });
      setTimeout(() => wx.switchTab({ url: '/pages/services/services' }), 800);
    } catch (e) {
      this.setData({ paying: false });
    }
  },

  async mockPay(outTradeNo) {
    // 后端模拟收银台：确认接口无鉴权，返回 HTML 忽略 body
    await new Promise((resolve, reject) => {
      wx.request({
        url: `http://localhost:8700/api/pay/mock/confirm?out_trade_no=${encodeURIComponent(outTradeNo)}`,
        method: 'POST',
        success: resolve,
        fail: reject,
      });
    });
  },

  realPay(order) {
    // TODO(正式支付): 调用 wx.requestPayment({timeStamp, nonceStr, package, signType, paySign})
    // 参数需后端提供 JSAPI 下单接口（ZPAY 适配），首版仅 MOCK。
    wx.showToast({ title: '正式支付尚未开通', icon: 'none' });
  },

  waitPaid(outTradeNo, times = 10) {
    return new Promise((resolve, reject) => {
      const tick = async (left) => {
        const o = await api.get(`/api/orders/${outTradeNo}`, { silent: true }).catch(() => null);
        if (o && o.paid) return resolve();
        if (left <= 0) return reject(new Error('支付确认超时'));
        setTimeout(() => tick(left - 1), 1000);
      };
      tick(times);
    });
  },
});
```

**Step 6: pages/package/buy/buy.wxml**

```xml
<view class="card">
  <view class="row">
    <text class="name">{{title}}</text>
    <text class="price">¥{{yuan}}</text>
  </view>
  <view class="muted">支付后自动建立师生服务关系</view>
</view>
<button class="btn" disabled="{{paying || paid}}" bindtap="onTapPay">
  {{paid ? '已支付' : paying ? '支付中…' : '立即支付'}}
</button>
```

**Step 7: pages/package/buy/buy.wxss**

```css
.row {
  display: flex;
  justify-content: space-between;
  margin-bottom: 8rpx;
}
.name {
  font-size: 32rpx;
  font-weight: 600;
}
.price {
  color: #e6533c;
  font-weight: 700;
  font-size: 36rpx;
}
```

**Step 8: 验证（全链路 MOCK）**

- 后端给测试老师上架套餐：

```bash
curl -s -X POST localhost:8700/api/teacher/packages -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"type":"regular","title":"月度陪伴","priceCents":99900,"callQuota":4,"replyHours":24}'
```

- 学员身份：首页 → 测试老师 → 套餐「购买」→ 立即支付 → toast「支付成功」→ 自动跳「服务」tab。
- 后端核对订单已履约：

```bash
curl -s "localhost:8700/api/relations" -H "authorization: Bearer $STU_TOKEN"   # 期望出现与老师的关系
```

**Step 9: Commit**

```bash
git add apps/miniprogram
git commit -m "feat(miniprogram): 老师详情与套餐购买（MOCK 支付闭环）"
```

---

### Task 5: 我的服务（学员：关系+预约；老师：预约列表）

**Files:**
- Modify: `apps/miniprogram/pages/services/services.*`（占位 → 完整）

**Step 1: pages/services/services.js**

```js
const api = require('../../utils/request.js');

Page({
  data: { role: 'student', loading: true, relations: [], appointments: [] },

  async onShow() {
    try {
      const me = await getApp().ensureLoginReady();
      this.setData({ role: me.role });
      if (me.role === 'teacher') {
        const appointments = await api.get('/api/teacher/appointments', { silent: true }).catch(() => []);
        this.setData({ appointments, loading: false });
      } else {
        const [relations, appointments] = await Promise.all([
          api.get('/api/relations', { silent: true }).catch(() => []),
          api.get('/api/appointments', { silent: true }).catch(() => []),
        ]);
        this.setData({ relations, appointments, loading: false });
      }
    } catch (e) {
      wx.redirectTo({ url: '/pages/login/login' });
    }
  },

  onTapBook(e) {
    const r = this.data.relations.find((x) => x.id === e.currentTarget.dataset.id);
    wx.navigateTo({
      url: `/pages/appointment/book/book?relationId=${r.id}&name=${encodeURIComponent(r.teacherName || r.displayName || r.name || '')}`,
    });
  },

  async onTapCancel(e) {
    const id = e.currentTarget.dataset.id;
    const res = await new Promise((resolve) =>
      wx.showModal({ title: '取消预约', content: '确定取消这个时段吗？', success: resolve }),
    );
    if (!res.confirm) return;
    await api.post(`/api/appointments/${id}/cancel`).catch(() => {});
    this.onShow();
  },
});
```

注意：`GET /api/relations` 返回字段名以实际为准（实现时先 `console.log` 确认老师名称字段，再定 `r.teacherName || r.displayName || r.name` 取哪个，删掉多余分支）。

**Step 2: pages/services/services.wxml**

```xml
<view wx:if="{{loading}}">
  <view class="empty">加载中…</view>
</view>

<!-- 学员 -->
<block wx:elif="{{role === 'student'}}">
  <view class="card">
    <view class="sec-title">我的老师</view>
    <view class="row item" wx:for="{{relations}}" wx:key="id" data-id="{{item.id}}" bindtap="onTapBook">
      <text class="name">{{item.teacherName}}</text>
      <text class="link">预约 ›</text>
    </view>
    <view class="empty" wx:if="{{!relations.length}}">购买套餐后建立师生关系</view>
  </view>
  <view class="card">
    <view class="sec-title">我的预约</view>
    <view class="row item" wx:for="{{appointments}}" wx:key="id">
      <text>{{item.date}} {{item.start}}</text>
      <text class="cancel" wx:if="{{item.status === 'booked'}}" data-id="{{item.id}}" catchtap="onTapCancel">取消</text>
      <text class="muted" wx:else>{{item.status}}</text>
    </view>
    <view class="empty" wx:if="{{!appointments.length}}">暂无预约</view>
  </view>
</block>

<!-- 老师 -->
<block wx:else>
  <view class="card">
    <view class="sec-title">预约列表</view>
    <view class="row item" wx:for="{{appointments}}" wx:key="id">
      <text>{{item.date}} {{item.start}}</text>
      <text class="muted">{{item.status}}</text>
    </view>
    <view class="empty" wx:if="{{!appointments.length}}">暂无预约</view>
  </view>
</block>
```

**Step 3: pages/services/services.wxss**

```css
.sec-title {
  font-size: 30rpx;
  font-weight: 600;
  margin-bottom: 12rpx;
}
.item {
  padding: 16rpx 0;
  border-bottom: 1rpx solid #f0f0f0;
}
.item:last-child {
  border-bottom: none;
}
.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.name {
  font-size: 30rpx;
}
.link,
.cancel {
  color: #1677ff;
  font-size: 26rpx;
}
```

**Step 4: app.json pages 追加预约页声明**

```json
[
  "pages/index/index",
  "pages/services/services",
  "pages/profile/profile",
  "pages/login/login",
  "pages/teacher/detail/detail",
  "pages/package/buy/buy",
  "pages/appointment/book/book"
]
```

同时创建 `pages/appointment/book/` 四件套占位（`.js` 只有 `Page({})`，`.wxml` 空视图），Task 6 补全。

**Step 5: 验证**

- 学员（已在 Task 4 建立关系）：服务 tab → 「我的老师」出现测试老师 → 「我的预约」空态文案。
- 老师身份：服务 tab 显示「预约列表」空态。

**Step 6: Commit**

```bash
git add apps/miniprogram
git commit -m "feat(miniprogram): 我的服务（师生关系、预约列表、取消）"
```

---

### Task 6: 预约流程（选日期 → 可约时段 → 下单）

**Files:**
- Modify: `apps/miniprogram/pages/appointment/book/book.*`（占位 → 完整）

**Step 1: pages/appointment/book/book.js**

```js
const api = require('../../../utils/request.js');
const { nextDays } = require('../../../utils/format.js');

Page({
  data: { relationId: 0, name: '', days: [], date: '', slots: [], chosen: '', booking: false },

  onLoad({ relationId, name }) {
    const days = nextDays(7);
    this.setData({ relationId: Number(relationId), name: decodeURIComponent(name), days, date: days[0].date });
    this.loadSlots();
  },

  onTapDay(e) {
    this.setData({ date: e.currentTarget.dataset.d, chosen: '' }, () => this.loadSlots());
  },

  async loadSlots() {
    const slots = await api
      .get(`/api/appointments/slots?relationId=${this.data.relationId}&date=${this.data.date}`, { silent: true })
      .catch(() => []);
    this.setData({ slots });
  },

  onTapSlot(e) {
    this.setData({ chosen: e.currentTarget.dataset.s });
  },

  async onTapBook() {
    if (!this.data.chosen || this.data.booking) return;
    this.setData({ booking: true });
    await api
      .post('/api/appointments', { relationId: this.data.relationId, date: this.data.date, start: this.data.chosen })
      .then(() => {
        wx.showToast({ title: '预约成功', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 800);
      })
      .catch(() => {});
    this.setData({ booking: false });
  },
});
```

**Step 2: pages/appointment/book/book.wxml**

```xml
<view class="card">
  <view class="name">{{name}}</view>
  <view class="days">
    <view
      wx:for="{{days}}"
      wx:key="date"
      class="day {{date === item.date ? 'day-on' : ''}}"
      data-d="{{item.date}}"
      bindtap="onTapDay"
    >{{item.label}}</view>
  </view>
</view>
<view class="card">
  <view class="sec-title">可约时段（{{date}}）</view>
  <view class="slots">
    <view
      wx:for="{{slots}}"
      wx:key="*this"
      class="slot {{chosen === item ? 'slot-on' : ''}}"
      data-s="{{item}}"
      bindtap="onTapSlot"
    >{{item}}</view>
  </view>
  <view class="empty" wx:if="{{!slots.length}}">该日期暂无可约时段</view>
</view>
<button class="btn" disabled="{{!chosen || booking}}" bindtap="onTapBook">
  {{booking ? '预约中…' : chosen ? '预约 ' + date + ' ' + chosen : '请先选择时段'}}
</button>
```

**Step 3: pages/appointment/book/book.wxss**

```css
.days {
  display: flex;
  flex-wrap: wrap;
  margin-top: 16rpx;
}
.day {
  background: #f5f6f8;
  border-radius: 999rpx;
  padding: 12rpx 24rpx;
  margin: 0 16rpx 16rpx 0;
  font-size: 24rpx;
  color: #666;
}
.day-on {
  background: #1677ff;
  color: #fff;
}
.slots {
  display: flex;
  flex-wrap: wrap;
}
.slot {
  background: #f5f6f8;
  border-radius: 8rpx;
  padding: 16rpx 28rpx;
  margin: 0 16rpx 16rpx 0;
  font-size: 26rpx;
}
.slot-on {
  background: #1677ff;
  color: #fff;
}
.sec-title {
  font-size: 30rpx;
  font-weight: 600;
  margin-bottom: 16rpx;
}
```

**Step 4: 验证（ slots 依赖老师周排班，先造排班）**

```bash
# 老师设置每周三 10:00 可约（具体字段以 /api/teacher/schedule 路由的 zod 定义为准，实现时先读该文件）
curl -s -X PUT localhost:8700/api/teacher/schedule -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '<按 routes.ts 的 schema 填>'
```

- 学员：服务 → 我的老师 → 预约 → 选中日期出现可约时段 → 选时段 → 预约成功 → 返回后「我的预约」出现记录；老师端「预约列表」同步可见。
- 冲突路径：约同一时段第二次 → toast 后端错误文案（`时段不可约` 等）。

**Step 5: Commit**

```bash
git add apps/miniprogram
git commit -m "feat(miniprogram): 预约流程（选日期、可约时段、下单）"
```

---

### Task 7: 我的页 + README + 冒烟清单

**Files:**
- Modify: `apps/miniprogram/pages/profile/profile.*`（占位 → 完整）
- Modify: `LiaoYu/README.md`（目录一节加 miniprogram 说明）

**Step 1: pages/profile/profile.js**

```js
const auth = require('../../utils/auth.js');

Page({
  data: { me: null },

  async onShow() {
    try {
      await getApp().ensureLoginReady();
      this.setData({ me: await auth.fetchMe().then((m) => auth.withRole(m)) });
    } catch (e) {
      wx.redirectTo({ url: '/pages/login/login' });
    }
  },

  onTapSwitch() {
    getApp().resetLogin();
    wx.reLaunch({ url: '/pages/login/login' });
  },
});
```

**Step 2: pages/profile/profile.wxml**

```xml
<view class="card" wx:if="{{me}}">
  <view class="name">{{me.user.nickname || '用户' + me.user.id}}</view>
  <view class="muted">
    {{me.role === 'teacher' ? '老师 · Lv' + me.teacher.level + ' · ' + me.teacher.displayName : '学员'}}
  </view>
</view>
<view class="card muted" wx:if="{{me}}">ID: {{me.user.id}}</view>
<button class="btn" bindtap="onTapSwitch">切换账号（重新登录）</button>
```

**Step 3: pages/profile/profile.wxss**：空文件即可（复用全局样式与 `.name` 未定义问题——在 `.js` 无关；`profile.wxml` 用的 `.name` 在 app.wxss 未定义，补到本页 wxss：）

```css
.name {
  font-size: 36rpx;
  font-weight: 700;
  margin-bottom: 8rpx;
}
```

**Step 4: README.md 目录一节追加**

```markdown
- `apps/miniprogram/`：微信原生小程序端（学员/老师双角色），用开发者工具指向该目录打开；接口走 `apps/server`
```

**Step 5: 全链路冒烟（最终验收，全部在开发者工具 + MOCK 后端完成）**

1. 清 storage → 启动 → 自动 MOCK 登录 → 首页学员视图老师列表。
2. 首页 → 老师详情 → 套餐 → 购买 → 支付成功 → 跳服务 tab。
3. 服务 → 我的老师 → 预约 → 选时段 → 成功 → 我的预约可见可取消。
4. 老师身份（换 code 登录的用户经 admin 审核后）：首页今日概览、服务预约列表、我的页显示「老师 · LvX」。
5. 401 路径：手动 `wx.removeStorageSync('liaoyu_token')` 后刷新页面 → 自动重登恢复。

**Step 6: Commit**

```bash
git add apps/miniprogram README.md
git commit -m "feat(miniprogram): 我的页与 README；小程序 MVP 完成"
```

---

## 后续迭代（明确不在本期）

- 正式微信支付（ZPAY JSAPI 下单接口 + `wx.requestPayment`，替换 `realPay` 占位）
- IM 聊天（腾讯云 IM 小程序 SDK + 回复时效展示）、TRTC 通话、通知中心
- 老师端：编辑排班、请假/代班操作、回复时效统计
- 学员端：老师入驻申请页、方向筛选枚举接入
