# 405nm（彩翻2.0）

漫画翻译协作与发布平台：**图源采集 → 翻译 → 校对 → 嵌字（离线 PS）→ 成品回传 → 一键导出发布包 → 定时发布**。

## 当前进度

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 仓库骨架、四容器编排、能起来能登录 | ✅ |
| M1 | 身份、团队、角色权限（关联表）、邀请码绑团注册、站点后台、站点品牌（站名/标语/立绘） | ✅ |
| M2 | 作品集 / 作品 / 文件、存储抽象、缩略图与预览图、媒体字节流、团队级 MD5 去重、工作台 | ✅ |
| M3 | 标号（**打点式**，框内/框外）与译文（多候选）、校对、显式状态机、署名台账、下游通知、翻校工作台、图片跨作品移动 | ✅ |
| M4 | 图源采集（X / Pixiv / Bluesky / 外链） | 未开始 |
| M5 | 导出（LabelPlus / 分层 PSD / PS 脚本）与成品回传 | 未开始 |
| M6 | 发布（B 站，Postgres 队列 + 幂等 + 租约） | 未开始 |
| M7 | 从旧站迁移（含图片与署名台账） | 未开始 |
| M8 | AI 机翻（OCR + 自动标号 + 大模型回填） | 未开始 |

## 技术栈

| 层 | 选择 |
|---|---|
| 前端 | Vite + React 19 + TypeScript + antd（色板与登录页/首页版式对齐**彩翻 moeflow-irohamod**，见 `docs/moeflow-ui-reference.md`） |
| 后端 | Fastify + TypeScript + zod |
| 数据 | PostgreSQL 16 + Drizzle ORM |
| Worker | 同后端镜像、不同入口（调度器 / 抓取 / AI 批量） |
| 存储 | 抽象层，v1 只实现 local 驱动 |
| 图源抓取 | `impit`（Rust，真 Chrome 的 TLS + HTTP/2 指纹）；**必须配出口代理**，见下 |
| 图像处理 | **Debian 的 libvips 命令行**（见下方说明） |

### 为什么图像处理用 libvips 命令行而不是 sharp

sharp 的预编译产物要求 CPU 支持 **x86-64-v2**（SSE4.2 / POPCNT 等），而被虚拟化的机器经常只暴露最基础的 x86-64 —— 测试机上 `/proc/cpuinfo` 的 model name 就是「Common KVM processor」，容器一启动就报 `Unsupported CPU: Prebuilt binaries for Linux x64 require v2 microarchitecture`。sharp 自带的 WebAssembly 兜底也走不通（V8 在缺指令集的 CPU 上会禁用 Wasm SIMD）。

改成 `apt-get install libvips-tools` 后，发行版二进制按基线 x86-64 编译，任何机器都能跑 —— 可移植性反而比 sharp 更好，而且底下是同一个引擎（sharp 就是 libvips 的绑定）。代价只是每张图多一次进程启动，相对于解码本身可以忽略。

### 图源抓取为什么要走代理

内网出口到 Pixiv / X / 图床的**直连是不通的**：那几个域名的 DNS 应答会被污染成
无关地址（`www.pixiv.net` 与 `www.google.com` 会解析到同一个第三方网段），
与客户端无关。所以内网部署必须在 `deploy/.env` 里配上 `SOURCING_PROXY`，
留空则直连。

客户端固定用 `impit`，不做「用哪个客户端」的开关 —— 指纹只有在单一入口上才不会
被某条支路悄悄绕过。选它的依据、以及「为什么 Node 原生的 fetch 与 http2 都不够」
见 `docs/m4-sourcing-spike.md`。

## 部署拓扑

四个容器，与彩翻一致：

```
frontend (nginx: 静态产物 + /api 反代)  ← 唯一对外端口
backend  (Fastify API)
worker   (调度器 + 抓取 + AI 批量)
db       (PostgreSQL 16)
```

## 开发

```bash
npm install                 # 安装全部 workspace 依赖
cp .env.example .env        # 填数据库连接与会话密钥

npm run migrate             # 建表 / 迁移
npm run dev:backend         # 后端 API
npm run dev:worker          # worker（另开一个终端）
npm run dev:frontend        # 前端（Vite dev server，/api 已代理到后端）
```

## 构建与交付

本机（Windows）没有 Docker，所以**构建与打包走远程**：

1. 本地 `npm run build:frontend` 产出静态文件（本地内存充足，远程构建会 OOM）；
2. 把 `frontend/build` 与后端源码上传到有 Docker 的机器；
3. 在那边 `docker build` 出 `frontend` / `backend` 两个镜像；
4. 用 `deploy/docker-compose.yml` 起服。

## 目录

```
packages/shared/   前后端共用（标注坐标、禁则换行、竖排、标点检查 —— 同一份实现）
frontend/          Vite + React 静态产物 → nginx 镜像
backend/           Fastify API 与 worker（共用镜像，command 区分）
deploy/            docker-compose 与 nginx 配置
tests/             回归脚本
```

`packages/shared/` 是关键：标注坐标与文字换行的逻辑**前端画布与后端导出必须一致**，否则换行会漂移、坐标会错位，因此单独抽成共享包而不是各写一遍。

## 验证

```bash
npm run test:shared         # 断行 / 禁则 / 竖排 / 标点（纯算法，本机可跑）
```

端到端回归脚本在测试机上跑（要连数据库，脚本有意做成了自带数据、可反复执行）：

```bash
docker compose -f deploy/docker-compose.yml run --rm \
  -v "$PWD/tests:/repo/tests:ro" \
  -e M3_ADMIN_PASSWORD=... backend node /repo/tests/m3-verify.mjs
```

`tests/` 下四个脚本：

| 脚本 | 覆盖 |
|---|---|
| `m1-verify.mjs` | 身份 / 团队 / 权限 / 邀请码 / 站点后台 / 站点品牌与立绘 |
| `m2-verify.mjs` | 作品 / 文件 / 媒体字节流 / 去重 / 团队动态 |
| `m3-verify.mjs` | 标号（含框内/框外与只读历史列）/ 译文 / 状态机 / 署名台账 / 通知 / 图片跨作品移动 |
| `m4-verify.mjs` | 抓取客户端：浏览器指纹（JA4 回归护栏）、失败分类、代理是否生效 |
| `shared-verify.mjs` | 排版算法（纯函数，`npm run test:shared` 本机可跑，42 项） |

前三个各自会打印「通过 N 项」并**在失败时以非零码退出**，脚本自带数据搭建、可反复执行，跑完留下的数据可当联调样本。造图用 `tests/lib/png.mjs` 里的最小 PNG 编码器（零依赖，三个脚本共用一份）。

## 注意

- 生产环境**必须 HTTPS**：会话 Cookie 带 `Secure`，纯 HTTP 下登录不上。
- 调度器与抓取**只能在 worker 容器里跑**，backend 绝不能起调度循环，否则会重复发布。
- 凭据（抓取 token / B 站 Cookie / AI key）加密落库、输出掩码，不进 git、不打日志。
- 行尾一律 LF（见 `.gitattributes`）：仓库在 Windows 上开发、在 Linux 上构建镜像，CRLF 的 `Dockerfile` 会让 `RUN ... \` 续行在 Linux 上直接报错。
