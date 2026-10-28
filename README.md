# LiaoYu

陪伴咨询平台。后端位于 `apps/server`（Node 24 + TypeScript + Fastify + PostgreSQL）。

## 本地开发

```bash
source ~/.nvm/nvm.sh && nvm use 24
corepack enable pnpm
pnpm install
pnpm db:up                                    # 启动开发 PostgreSQL（端口 54329，含 liaoyu_test 测试库）
pnpm -F @liaoyu/server create-admin boss 'password-123456'   # 可加第三个参数 super|ops|finance，默认 super
pnpm -F @liaoyu/server dev                    # http://localhost:8700
pnpm -F @liaoyu/admin dev                     # 管理台 http://localhost:5173/admin/（/api 代理到 8700）
```

管理台生产形态由后端托管：`pnpm -F @liaoyu/admin build` 后访问 `http://localhost:8700/admin/`（未构建时 `/admin` 不挂载）。

### 管理员角色

| 角色               | 能做什么                                          |
| ------------------ | ------------------------------------------------- |
| `super` 超级管理员 | 全部功能，含管理员账号、审计日志、修改佣金        |
| `ops` 运营         | 概览、老师审核定级、订单只读（不可导出）          |
| `finance` 财务     | 概览、订单只读及导出、结算（生成/打款）、佣金只读 |

首个账号必须用脚本以 `super` 创建；其余账号由超级管理员在管理台「管理员账号」页创建。角色权限以后端为准（前端只控制显示），两边的权限表由 `apps/server/tests/admin-drift.test.ts` 守护。

- 未配置 `ZPAY_PID/ZPAY_KEY` 时支付走本地模拟收银台；未配置 `WX_APPID/WX_APPSECRET` 时微信登录走 MOCK。
- 未配置 `TENCENT_SDKAPPID/TENCENT_SECRETKEY` 时 IM / TRTC 走 MOCK：`userSig` 为 `mock`，调用进入通话接口即记为已进房，由分钟级任务自动完成通话。
- 接口文档（非生产环境）：`GET /api/openapi.json`。
- 环境变量见 `apps/server/src/config.ts`，可写在 `apps/server/.env`。

## 质量门禁

```bash
pnpm fix      # 格式化 + 整理 import
pnpm check    # Biome + tsc + Vitest（需先 pnpm db:up）
```

## 目录

- `apps/server/src/modules/*`：按业务域划分，`routes.ts` 只做校验与调用，`service.ts` 负责事务与 IO
- `apps/admin/`：管理台（Vue3 + TDesign Vue Next），构建产物由 `apps/server` 托管于 `/admin/`
- `apps/miniprogram/`：微信原生小程序端（学员/老师双角色），用开发者工具指向该目录打开；接口走 `apps/server`（开发环境勾选「不校验合法域名」直连 `http://localhost:8700`）
- `apps/server/src/domain/*`：纯函数（分段改写等），不碰数据库
- `apps/server/src/jobs/*`：pg-boss 定时任务
- `deploy/`：开发与生产的 Docker Compose、Caddy、备份脚本

## 生产部署（腾讯云轻量服务器）

前置：域名已 ICP 备案并解析到服务器；安装 Docker 与 [coscli](https://cloud.tencent.com/document/product/436/63143)。

```bash
git clone <repo> /opt/liaoyu && cd /opt/liaoyu/deploy
cp .env.example .env && vi .env          # 填写全部变量
docker compose up -d --build
docker compose exec server node src/scripts/create-admin.ts boss '<至少10位强密码>' super   # 首个账号必须是 super
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
