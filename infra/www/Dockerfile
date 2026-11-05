# 纯静态 marketing 镜像：Astro 站点（含 /docs）+ 自带轻量静态服务器。
# 不烘 monolith 二进制、不依赖 Postgres/compose 网络，独立可跑。
#
# 构建:
#   docker build -f infra/www/Dockerfile -t doitx-www:local .
# 启动:
#   docker run --rm -p 8080:80 doitx-www:local
#   curl http://localhost:8080/
#   curl 'http://localhost:8080/api/download?platform=windows'
#
# /api/download 在线时调 GitHub API 取最新 release；不可达时用构建时写死的
# FALLBACK_RELEASE_URL（默认 LATEST_RELEASE_URL）兜底。
#
# 依赖说明：www 通过 workspace 引用 @rakazo/core、@rakazo/ui-web、@rakazo/ui-tokens、
# @rakazo/contracts（exports 直接指 src/*.ts，vite 内联编译 TS，无需单独 build）。
# 构建上下文必须包含这些包的 manifest 与源码；安装全量依赖（含 devDeps）以保证
# astro/vite/tailwind 在容器内可解析。约定同 infra/compose/Dockerfile。

# 基础镜像与 pnpm 版本同 monolith（infra/compose/Dockerfile）：node 24.22.1 +
# corepack 锁定 pnpm@9.15.0（package.json 的 packageManager 字段），保证 lockfile 解析一致。
ARG NODE_IMAGE=node:24.22.1-bookworm@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a
FROM ${NODE_IMAGE}
ENV COREPACK_HOME=/usr/local/share/corepack \
    NPM_CONFIG_UPDATE_NOTIFIER=0 \
    NPM_CONFIG_PROGRESS=false \
    RAKAZO_APP_ENV=production \
    NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable
WORKDIR /app

# 根 lockfile + 全部 workspace manifest（缓存键：任一 manifest 变更即重跑 install）
# .npmrc 必须随 lockfile 进入，frozen-lockfile 校验会读其中的 pnpm 配置。
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json .npmrc ./
COPY patches/ ./patches/

# corepack install 需要 package.json 里的 packageManager 字段才能锁定 pnpm 版本
RUN corepack install && chmod -R a+rX "${COREPACK_HOME}"
COPY infra/sandboxes/supervisor/package.json ./infra/sandboxes/supervisor/package.json
COPY infra/updater/package.json ./infra/updater/
COPY apps/web/package.json ./apps/web/
COPY apps/www/package.json ./apps/www/
COPY apps/api/package.json ./apps/api/
COPY apps/mobile/package.json ./apps/mobile/
COPY apps/worker/package.json ./apps/worker/
COPY apps/desktop/package.json ./apps/desktop/
COPY packages/*/package.json ./packages/

# www 依赖的 workspace 包源码（exports 直指 src，vite 内联编译）
# 先拷源码再 install：pnpm 的 workspace 链接把包指回源码目录，install 后 node_modules
# 指向 /app/packages/*，必须保证这些目录在 install 前就位（monolith 的 install 层
# 在全部源码 COPY 之前，但 monolith 烘的是二进制、不经 astro/vite 解析；这里烘静态
# 产物，vite 会在 install 后直接解析源码里的 CSS @import，故顺序与 monolith 相反）。
COPY packages/core/ ./packages/core/
COPY packages/ui-web/ ./packages/ui-web/
COPY packages/ui-tokens/ ./packages/ui-tokens/
COPY packages/contracts/ ./packages/contracts/

# 安装全量依赖（含 devDeps：www 构建需要 @tailwindcss/vite 等；与本地一致）
# 不加 filter = 整仓 install：按 lockfile importers 记录为各包建软链（含 tw-animate-css
# 等 ui-web 依赖）。装完即烘 dist，运行层只保留产物，node_modules 不会进最终镜像层。
RUN pnpm install --frozen-lockfile --prod=false \
    && pnpm store prune \
    && chown -R node:node /app

# 站点源码（缓存键）
COPY apps/www/ ./apps/www/

# 烘静态产物（含 /docs）。/docs 由 www 的 content loader 在构建期直接读仓库根 docs/，
# 故 docs/ 必须进入构建上下文。api/download 的 runtime 兜底由 server.mjs 自实现。
COPY docs/ ./docs/
RUN pnpm --filter @rakazo/www build

# 运行层：静态产物 + 自定义静态服务器 + /api/download
COPY --chown=node:node infra/www/server.mjs ./server.mjs
COPY --chown=node:node infra/www/redirects.json ./redirects.json
# 下载按钮的离线兜底：烘构建期的 LATEST_RELEASE_URL，运行期可用 env 覆盖
ARG FALLBACK_RELEASE_URL=https://github.com/iishows/doitx/releases/latest
ENV FALLBACK_RELEASE_URL=${FALLBACK_RELEASE_URL}

EXPOSE 80
USER node
ENV WWW_ROOT=/app/apps/www/dist
CMD ["node", "server.mjs"]
