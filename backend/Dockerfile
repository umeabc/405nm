# 构建上下文是仓库根目录（workspaces 需要根 package.json 与 lockfile）：
#   docker build -f backend/Dockerfile -t 405nm-backend:dev .
#
# 重要：依赖必须在 Linux 容器内安装（`npm ci` 就在这里跑）。
# 绝不要把 Windows 上装好的 node_modules 传上来 —— win32 二进制在 Linux 上会直接崩。
#
# 图片处理走的是 Debian 的 libvips **命令行**而非 sharp，原因见 runtime 阶段的注释。

FROM node:24-slim AS build
WORKDIR /repo
ENV npm_config_update_notifier=false

# 仓库默认走官方源；在访问 npmjs 较慢的主机上构建时用
#   --build-arg NPM_REGISTRY=https://registry.npmmirror.com
# 覆盖即可，不必改仓库文件。
ARG NPM_REGISTRY=https://registry.npmjs.org/
RUN npm config set registry "$NPM_REGISTRY"

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY backend/package.json backend/
# frontend/package.json 只是为了让 lockfile 校验能对上，**不安装它的依赖** ——
# 后端镜像不该背上 React / antd / vite 这一整棵树（体积、构建时间、镜像源缺包都会中招）。
COPY frontend/package.json frontend/
RUN npm ci --workspace backend --workspace packages/shared --include-workspace-root

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY backend backend

RUN npm run build -w packages/shared && npm run build -w backend
# 裁掉 devDependencies，让运行镜像小一圈。
RUN npm prune --omit=dev

FROM node:24-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production

# ── libvips 命令行 ───────────────────────────────────────────
#
# 图片缩放与缩略图靠它（见 src/lib/image.ts 的说明）。**刻意不用 sharp**：
# sharp 的预编译产物要求 CPU 支持 x86-64-v2，而被虚拟化的机器经常只暴露
# 最基础的 x86-64（测试机就是「Common KVM processor」，没有 SSSE3/SSE4.2），
# 结果是容器启动即崩，且现场极难定位。Debian 打包的 libvips 按基线 ABI 编译，
# 任何 x86-64 机器都能跑 —— 可移植性比 sharp 更好，底下还是同一个引擎。
#
# `--no-install-recommends` 是为了别把整个 ImageMagick/文档工具链拖进来。
RUN apt-get update \
 && apt-get install -y --no-install-recommends libvips-tools \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/package.json package.json
COPY --from=build /repo/packages/shared/package.json packages/shared/package.json
COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/backend/package.json backend/package.json
COPY --from=build /repo/backend/dist backend/dist
COPY --from=build /repo/backend/drizzle backend/drizzle
COPY --from=build /repo/backend/drizzle.config.ts backend/drizzle.config.ts

# 图片落盘目录（local 存储驱动），compose 里挂成数据卷。
RUN mkdir -p /data/uploads
ENV STORAGE_DIR=/data/uploads

EXPOSE 3000

# worker 服务用 command 覆盖成 node backend/dist/worker/index.js
CMD ["node", "backend/dist/index.js"]
