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
