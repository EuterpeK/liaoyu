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
