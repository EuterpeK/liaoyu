# LiaoYu 技术栈设计

- 日期：2026-10-25
- 状态：已确认
- 前提：单人长期维护、AI 辅助开发；divination 仅参考 ZPAY 支付逻辑，其余从头选型
- 关联：`2026-10-24-liaoyu-platform-design.md`（本文替代其第 4 节的选型表）

## 1. 选型原则

项目难点在业务而非界面：**钱与状态机**（分段、计提、结算、冻结）、**时间驱动任务**（日计提、48 小时超时、15 分钟爽约、月度等级）、**深度依赖微信与腾讯云**。

1. 前端贴近微信原生能力，不加跨端编译层。
2. 后端强类型 + 关系型数据库，业务不变量尽量下沉为数据库约束。
3. 运维压到一台机器、一条命令可部署、可恢复。

## 2. 方案对比

| 方案 | 结论 |
|---|---|
| 微信云开发全托管 | 否决：文档型库不适合记账结算；定时任务、外部回调（ZPAY）、管理网页受限；迁出成本高 |
| **原生小程序 + 自建 TS 单体 + PostgreSQL** | **采用** |
| uni-app / Taro 跨端 | 否决：不做 App/H5，跨端是无用能力；IM/TRTC 原生组件排障链路变长 |

## 3. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 运行时 | Node.js 24 LTS、TypeScript 5（`strict`） | |
| 小程序 | 原生小程序 + TypeScript（开发者工具 `useCompilerPlugins: ["typescript"]`）+ TDesign 小程序组件库 | 腾讯官方组件库；IM 用 TUIKit，通话用 TRTC 小程序 SDK |
| 管理网页 | Vue 3 + Vite + TDesign Vue Next | 参考 TDesign Starter 精简使用；构建产物由后端静态托管于 `/admin` |
| 后端框架 | Fastify 5 + Zod（`fastify-type-provider-zod`）+ `@fastify/swagger` | Zod 一处定义同时负责校验与类型；自动输出 OpenAPI |
| 接口契约 | `openapi-typescript` 生成类型，`pnpm gen:api` 直接写入 admin 与小程序目录 | 后端改接口，两端 `tsc` 立即报错 |
| 数据库 | PostgreSQL 17 | 见第 5 节 |
| ORM / 迁移 | Drizzle ORM + drizzle-kit | schema 即 TS；迁移 SQL 入库可审阅；复杂约束直接写在迁移 SQL |
| 定时任务 | pg-boss（基于 PostgreSQL 的任务队列） | 取代 `setInterval`；cron 调度、单例键防重、失败重试、执行记录可查；不引入 Redis |
| 鉴权 | 小程序：`code2Session` → 自签 JWT；管理端：HttpOnly Cookie 会话（存 PG）+ `@node-rs/argon2` 密码哈希 | 管理端不用 JWT，便于强制下线 |
| 支付 | `PaymentProvider`：`ZPayProvider`（移植 divination 签名/验签逻辑并改写为 TS）、后续 `WechatPayProvider` | 唯一参考 divination 处 |
| 打款 | `PayoutProvider`：`ManualPayoutProvider` | |
| 消息 / 通话 | 腾讯云 IM + TRTC，后端签发 UserSig、接收回调 | |
| 文件 | 腾讯云 COS 私有桶 + 临时签名 URL | 资质证书等敏感文件不公开 |
| 日志告警 | pino 结构化日志（文件轮转）+ 企业微信群机器人告警 | 告警场景：回调金额不符、危机事件、任务连续失败、备份失败 |
| 代码质量 | Biome（lint + format 一个工具）、Vitest | |
| 部署 | 腾讯云轻量服务器 + Docker Compose（server + postgres）+ Caddy（自动 HTTPS） | 域名需 ICP 备案（小程序合法域名要求） |

## 4. 仓库结构

pnpm workspace 单仓，不引入 Nx/Turborepo。

```
LiaoYu/
├── pnpm-workspace.yaml
├── .npmrc                     # node-linker=hoisted（小程序「构建 npm」不识别 pnpm 软链）
├── apps/
│   ├── server/
│   │   └── src/
│   │       ├── index.ts / app.ts / config.ts   # config 用 Zod 校验环境变量，启动即失败
│   │       ├── db/            # schema/*.ts、client.ts、migrations/
│   │       ├── lib/           # money、dates、clock、errors、tx
│   │       ├── modules/       # 按业务域：auth teachers packages orders relations accrual
│   │       │                  #   settlement leaves appointments im trtc safety tickets
│   │       │                  #   levels admin notify；每域 routes.ts + service.ts + *.test.ts
│   │       ├── domain/        # 纯函数：分段改写、计提拆分、等级计算（无 IO）
│   │       ├── providers/     # payment/ payout/ tencent/ wechat/
│   │       └── jobs/          # pg-boss 任务注册
│   ├── admin/
│   └── miniprogram/
├── deploy/                    # docker-compose.yml、Caddyfile、backup.sh
└── docs/
```

规则：`domain/` 只放纯函数，单元测试不碰数据库；`service` 负责事务与 IO；`routes` 只做校验与调用。

## 5. 数据库关键设计

- **金额**：一律 `bigint` 存「分」；抽成比例存基点（`bps`）；结算批次快照当期比例。
- **日期**：业务日用 `date`（北京时间），时刻用 `timestamptz`；业务日换算集中在 `lib/dates`。全部"现在"取自注入的 `clock`，测试可固定时钟。
- **计提拆分**：日额向下取整，余数分摊到前几天，保证合计等于实付金额（单测守护）。
- **分段不重叠**：启用 `btree_gist`，在 `service_segments` 加
  `EXCLUDE USING gist (relation_id WITH =, daterange(start_date, end_date, '[]') WITH &&)`。
- **幂等**：`orders.out_trade_no` 唯一；`accruals (relation_id, date)` 唯一；回调与任务写入统一 `ON CONFLICT DO NOTHING`。
- **审计日志**：`audit_logs` 只追加，应用账号收回 `UPDATE/DELETE` 权限。
- **敏感字段**：实名、证件号用 AES-256-GCM 字段级加密，密钥只在环境变量。

## 6. 并发与事务（评审重点）

PostgreSQL 事务是异步、真并发的，不能假设单写者串行。统一约定：

- 所有写操作经 `withTx(fn)`；涉及服务关系的改动先 `SELECT ... FOR UPDATE` 锁住 `service_relations` 行。
- 跨表规则（请假与已同意代班时段冲突、代班邀请排除请假重叠者）无法用单个约束表达：在事务内先锁老师行再校验。
- 支付回调：锁订单行 → 校验状态与金额 → 开通，重复回调直接返回成功。
- 定时任务用 pg-boss 单例键（如 `accrual:2026-11-01`），同一业务日只会执行一次。

## 7. 定时任务清单

| 任务 | 调度 | 说明 |
|---|---|---|
| 日计提 | 每日 00:10 | 计提前一业务日；冻结中的关系跳过 |
| 周结算 | 每周一 02:00 | 生成上周结算清单 |
| 代班选择超时 | 每分钟 | 超 48 小时未选保持暂停 |
| 通话爽约 / 自动完成 | 每分钟 | 超 15 分钟未上线记爽约；单次套餐 48 小时无异议计提 |
| 月度等级建议 | 每月 1 日 03:00 | 生成建议，待负责人确认 |
| 数据库备份 | 每日 04:00（宿主机 cron） | `pg_dump` 上传 COS，保留 30 天；每月做一次恢复演练 |

## 8. 测试与质量门禁

- 纯函数（分段、计提、等级、结算金额）：Vitest 单测。
- service 与接口：连 Docker Compose 中的测试 PG，每个测试文件独立 schema 或事务回滚；Fastify `inject` 打接口。
- 一条命令 `pnpm check` = typecheck + biome + test，挂 git `pre-push` 钩子；不强制建 CI 流水线。

## 9. 风险与前置确认

| 风险 | 处理 |
|---|---|
| TRTC 依赖 `live-pusher/live-player` 权限，需小程序类目支持，**体验版也受限** | 第二阶段开工前先确认类目与接口权限；不满足则内测通话降级（如先只做 IM + 线下约定通话） |
| IM 发送前回调有超时限制 | 回调内只做本地关键词匹配（危机词、私下交易），微信内容安全检测异步执行并事后处置 |
| 小程序无法主动推送 | 请假、代班邀请等通知依赖订阅消息，需提前申请模板并在关键操作点引导授权；站内通知兜底 |
| 小程序内引导外部支付 | 仅限体验版内测；上线切微信支付 |

## 10. 对已有实施计划的影响

`2026-10-24-liaoyu-phase1-backend-core.md`、`2026-10-24-liaoyu-phase2-service-delivery.md` 基于 Express + SQLite + JS，业务拆解与测试用例可复用，代码需按本文技术栈重写；尤其同步事务、`setInterval` 调度需改为第 6、7 节方案。
