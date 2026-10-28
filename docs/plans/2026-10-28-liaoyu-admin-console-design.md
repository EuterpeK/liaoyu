# LiaoYu 管理台重做 设计文档

- 日期：2026-10-28
- 状态：已确认
- 范围：方案 C（先重做框架，再逐步补功能）+ 角色体系

## 1. 目标与范围

把单文件 `public/admin.html` 换成 Vue3 + TDesign Vue Next 工程，带路由、布局、角色权限；迁移现有 5 个页面，新增「管理员账号」页。

**不在本轮**：用户管理、套餐/服务关系/预约查询、危机与风险事件、工单、评价、等级建议、数据看板、分等级抽成。框架稳定后按页面逐个加。

## 2. 架构

独立工程 `apps/admin`（`@liaoyu/admin`）：Vue3 + Vite + TS + TDesign Vue Next + Pinia + vue-router。构建产物由 Fastify 托管于 `/admin/`，同源，Cookie 策略不变（HttpOnly、SameSite=strict、path `/api/admin`）。

```
apps/admin/src/
  main.ts, App.vue
  router/        路由表（meta.roles）+ beforeEach 守卫
  stores/        auth（当前管理员/角色）
  permissions.ts 动作表与 can()
  api/           fetch 封装 + 各域接口
  layouts/       侧栏 + 顶栏 + 内容区
  views/         login overview teachers orders settlements audit admins 403
  components/    PageTable FilterBar MoneyText
```

后端：`@fastify/static` 托管 `apps/admin/dist` 于 `/admin/`，SPA 回退 `index.html`；删除 `public/admin.html` 与旧 `/admin` 路由；CSP 去掉 `script-src 'unsafe-inline'`（style 保留，TDesign 注入内联样式）。Dockerfile 加前端构建阶段。

## 3. 角色权限（后端）

- 枚举 `admin_role`：`super | ops | finance`。`admins` 加 `role`（默认 `super`，旧账号自动为超管）与 `disabled_at`。
- `adminGuard(deps, ...roles)`：不传 roles 表示任何已登录管理员；传了而 role 不在列表内返回 403「无权限」；`super` 始终放行。写入 `req.adminRole`。改为路由级 preHandler。
- 停用账号：拒绝登录；`resolveSession` 校验未停用；停用时删除其全部会话。
- `create-admin` 脚本增加可选 `[role]` 参数。

| 接口 | super | ops | finance |
|---|---|---|---|
| `GET /me`、`POST /logout` | ✓ | ✓ | ✓ |
| `GET /orders/summary`、`GET /orders`、`GET /orders/count` | ✓ | ✓ | ✓ |
| `GET /orders.csv` | ✓ | ✗ | ✓ |
| `GET /teachers`、`POST /teachers/:id/review` | ✓ | ✓ | ✗ |
| `GET /settings/commission-bps` | ✓ | ✗ | ✓ |
| `PUT /settings/commission-bps` | ✓ | ✗ | ✗ |
| `GET /settlements`、`generate`、`:id/pay` | ✓ | ✗ | ✓ |
| `GET /audit-logs` | ✓ | ✗ | ✗ |
| 管理员账号管理 | ✓ | ✗ | ✗ |

### 管理员账号管理（仅 super）

- `GET /api/admin/admins`：列表，不含密码哈希。
- `POST /api/admin/admins`：用户名、至少 10 位初始密码、角色；重名 409。
- `PATCH /api/admin/admins/:id`：改角色、停用/启用。
- `POST /api/admin/admins/:id/reset-password`：重置密码并清除会话。
- 护栏：不能停用自己、不能降级自己、不能使系统没有启用的 super。
- 全部写审计日志（`admin.create/update/reset_password`），详情不含密码。
- `/me` 返回 `{ id, username, role }`。

### 新增订单计数

`GET /api/admin/orders/count`（同筛选参数）用于真分页。

## 4. 前端

- 启动调 `/me`：成功写 store，失败跳 `/login`。fetch 封装：401 清 store 并跳登录（带 redirect）；403 提示「无权限」；其他错误取后端 `error` 字段 toast。
- 权限只做体验，真正拦截在后端。路由 `meta.roles` + `beforeEach`；`can(action)` 动作表集中在 `permissions.ts`（`orders.export`、`settlement.pay`、`commission.edit`、`teacher.review` 等）；菜单按 `meta.roles` 过滤。

| 路由 | 页面 | 角色 |
|---|---|---|
| `/overview` | 概览：4 统计卡 + 最近订单 | 全部 |
| `/teachers` | 待审/全部页签；批准对话框选等级 1~3；驳回二次确认 | super、ops |
| `/orders` | 状态/用户/老师/日期筛选，服务端分页，筛选汇总；导出仅 super、finance | 全部 |
| `/settlements` | 佣金卡（仅 super 可编辑）、生成结算单、列表、打款对话框（凭证必填） | super、finance |
| `/audit` | 按操作类型筛选，详情可展开 | super |
| `/admins` | 新建、改角色、停用/启用、重置密码 | super |
| `/login`、`/403` | 辅助页 | 公开 |

通用组件仅 `PageTable`、`FilterBar`、`MoneyText`。

## 5. 测试

- 后端：角色矩阵（200/403 参数化）、停用与会话失效、护栏、迁移默认 `super`、`orders/count`。`helpers.adminCookie(ctx, role?)` 默认 super。
- 前端：Vitest + Vue Test Utils：`can()`、路由守卫、fetch 封装、老师审核与打款对话框。另加测试对照后端角色归属表，防止漂移。
- 冒烟：起后端 + 构建产物，curl 三种角色验证 403；深层路径刷新回退 `index.html`。

## 6. 风险

- TDesign 体积大：按需引入。
- 本机 glibc 2.28：Vite 的原生依赖可能不兼容，实现计划第一个任务先验证构建，必要时按 Biome 的 musl 覆盖方式处理。
