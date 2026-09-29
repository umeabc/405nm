# 405nm（彩翻2.0）

漫画翻译协作与发布平台：**图源采集 → 翻译 → 校对 → 嵌字（离线 PS）→ 成品回传 → 一键导出发布包 → 定时发布**。

## 当前进度

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 仓库骨架、四容器编排、能起来能登录 | ✅ |
| M1 | 身份、团队、角色权限（关联表）、邀请码绑团注册、站点后台、站点品牌（站名/标语/立绘） | ✅ |
| M2 | 作品集 / 作品 / 文件、存储抽象、缩略图与预览图、媒体字节流、团队级 MD5 去重、工作台 | ✅ |
| M3 | 标号（**打点式**，框内/框外）与译文（多候选）、校对、显式状态机、署名台账、下游通知、翻校工作台、图片跨作品移动 | ✅ |
| M4 | 图源采集：7 类图源解析、持久化导入任务（可续跑）、多份具名凭据 | ✅ |
| M5 | 导出（LabelPlus txt / 工程包 / 成品包）与成品回传、状态推进到已嵌字 | ✅（分层 PSD 见下） |
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

`backend/src/sourcing/http.ts` 是**唯一**出网口，所有解析器都必须经它取图。

## 图源导入

把链接粘进作品页即可入库。支持的七类图源：

| source | 链接形态 |
|---|---|
| `pixiv` / `pixiv_user` | `pixiv.net/artworks/<id>` / `pixiv.net/users/<uid>` |
| `twitter` / `twitter_user` | `x.com/<user>/status/<id>` / `x.com/<user>` |
| `bluesky` / `bluesky_user` | `bsky.app/profile/<handle>/post/<rkey>` / `bsky.app/profile/<handle>` |
| `external` | 直链图片，或带 `og:image` 的普通网页 |

几处不显然但必须遵守的点：

- **Pixiv 图片必须带 `Referer: https://www.pixiv.net/`**，否则 `i.pximg.net` 一律 403。
  403 不能一律判成「被墙」——`sourcing/errors.ts` 要看证据（Cloudflare 挑战页特征）
  才归 `BLOCKED`，否则归 `HTTP_STATUS` 并提示补 Referer。
- **X 的原图是 `?name=orig`**，绝不能换成 `format=jpg`（PNG 会 404）。
- **X 的 og:image 兜底与 guest 通道现已失效**，按用户的抓取必须配
  `bearer` + `userMediaQueryId` 两个凭据，缺任一项就直接告诉用户要配什么，不做无效重试。
- **`import_tasks` 的每一步都落库**：解析完写 items，每张图跑完更新那一行。
  重试时**只补跑失败的那几张**，且最终计数会**加上库里已有的部分**而不是从 0 重算 ——
  否则表现成「重试了一下，进度反而变成 0/29」。
- **图片序号接续**：从该作品已有文件的最大数字前缀往后排，否则往同一个作品粘三条链接
  会得到「三个 001」，而列表按自然序排，三组会互相穿插。
- 去重是 **MD5、作用域整个团队**，重复计入 `duplicated` 而不是报错。

导入任务由 **worker** 执行（backend 绝不起这个循环），前端 1.5s 轮询一次进度。

## 导出与成品（离线嵌字闭环）

```
导出工程包（原图 + txt + manifest） → PS 里用 LabelPlus 脚本嵌字 → 回传成品 → 标记「已嵌字」 → 成品包
```

三条导出：

| 接口 | 内容 |
|---|---|
| `GET /projects/:id/exports/labelplus?targetId=` | LabelPlus txt，只有译文清单 |
| `GET /projects/:id/exports/project.zip?targetId=` | 工程包：原图 + txt + `manifest.json` + `说明.txt` |
| `GET /projects/:id/exports/outputs.zip?targetId=` | 成品包：各图在该语言下的**最新**成品 |

成品回传用 `POST /files/:id/outputs`（multipart），版本号按 `(文件, 语言)` 各自从 1 递增，
**最新版本即当前版本**（表里没有 `is_current` 列 —— 少一个需要维护的不变量）。
状态机进 `typeset` 的前置条件就是这张表里有行。

### LabelPlus txt 的格式是反推出来的，不要随手改

这个格式没有正式规范，唯一权威是**消费它的那两样东西**：LabelPlus 本体与官方 PS 脚本。
序列化在 `packages/shared/src/labelplus.ts`，每一处细节的来由都写在注释里。几条硬约束：

- **头部**是 `1.0,1.0` / `-` / 组名若干行 / `-` / 注释 / `-`。官方 `readStartBlocks()`
  把「第一个文件头之前的内容」按 `-` 切开取 `blocks[1]` 当组名 ——
  **组名里绝不能出现 `-`**，否则组被切碎、组号整体错位（表现为「译文全串到别的组」）。
- 官方 `judgeLineType()` 是**前缀匹配**：文件头前 6 字符是 `>`、标号头前 6 字符是 `-`，
  所以 `>`/`<`/`-` 的数量下限是 6。我们统一用 6。
- 组名顺序即组号，**1 = 框内、2 = 框外**，正好对上标号的 `position_type`。
- 坐标是**归一化 0–1、4 位小数**。官方 PS 脚本按「两个分量都 ≤1」判定这是归一化值再乘画布尺寸，
  混入像素值会被当成越界直接丢到画布外。
- **连空译文也要写一行**。官方解析器的收尾规则是「最后一行若是标号头则不收尾」，
  文件以标号头结尾时那个标号会被整条丢掉。
- **txt 里的文件名与压缩包里的条目名必须逐字一致**（都由 `dedupeLpFilenames` 算一次）。
  两边分叉的后果是 PS 脚本一个标号都嵌不上，**而且不报错**。

`tests/shared-verify.mjs` 里有一节专门做这件事：它**照官方脚本的算法重实现了一遍解析器**，
用那个解析器去读我们的输出。自洽只能证明自己跟自己一致，这样才拦得住格式漂移。

### 关于 PS 脚本

**本仓库不附带 PS 脚本。** 嵌字用 LabelPlus 官方的 `LabelPlus_Ps_Script.jsx`，
从 LabelPlus 项目自行获取（它以 GPLv2 发布，是否收进本仓库由仓库所有者决定）。
工程包的 `说明.txt` 里写了获取方式、安装步骤，以及 txt 格式说明 ——
不想用官方脚本、想自己写工具的话，照着那份说明和 `manifest.json` 就够。

### 还没做的：分层 PSD 导出

原计划里 M5 还有一项「服务端直接生成分层 PSD」（用 ag-psd 写原生 TypeTool 文本图层，
配一层底图）。它需要把图片解成**裸 RGBA** 喂给 ag-psd，而 Node 侧没有 canvas 时
只能靠 libvips 命令行吐裸数据 —— 这条路还没验证过，所以没有先写代码。
当前 txt + 官方脚本的组合已经能完整走通离线嵌字，PSD 由 PS 自己另存即可。

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

`tests/` 下六个脚本：

| 脚本 | 覆盖 |
|---|---|
| `m1-verify.mjs` | 身份 / 团队 / 权限 / 邀请码 / 站点后台 / 站点品牌与立绘 |
| `m2-verify.mjs` | 作品 / 文件 / 媒体字节流 / 去重 / 团队动态 |
| `m3-verify.mjs` | 标号（含框内/框外与只读历史列）/ 译文 / 状态机 / 署名台账 / 通知 / 图片跨作品移动 |
| `m4-verify.mjs` | 抓取客户端（浏览器指纹 JA4 回归护栏、失败分类、代理）+ 七类解析器 + 导入任务。加 `-e M4_LIVE=1` 才会真的出网 |
| `m5-verify.mjs` | 导出体检 / LabelPlus txt 的逐字节格式 / 工程包与成品包（解包校验条目名与 txt 一致）/ 成品版本与删除 / 跨作品越权 / 状态机进 `typeset` 的前置条件 |
| `shared-verify.mjs` | 排版算法 + LabelPlus 往返（纯函数，`npm run test:shared` 本机可跑） |

每个脚本都会打印「通过 N 项」并**在失败时以非零码退出**，脚本自带数据搭建、可反复执行，跑完留下的数据可当联调样本。造图用 `tests/lib/png.mjs` 里的最小 PNG 编码器（零依赖，共用一份）。

`m4-verify.mjs` 不带 `M4_LIVE=1` 时只跑不碰网络的那部分（指纹与失败分类），拿不到出网报告时会**明确变红而不是跳过** —— 静默跳过等于给自己发一张假的通行证。

## 角色权限：代码声明 vs 落库快照

作品角色是建作品时从**团队模板**复制的一份快照，而团队模板又只在第一次用到时
按当时的代码建一次。于是「代码里给某个默认角色加了新权限」之后，老团队会一直缺它 ——
**连它以后新建的作品也一样缺**，症状是功能上线了、用户一点却报「需要 xxx」，
界面上看不出哪里配错了。这是真实发生过的事：

- M1 时期建的团队，模板是在项目域权限码**还不存在**时建的，几乎全空；
- M2 时期的团队缺 M3 才加的 `tra.check`。

处理方式与 `syncProjectRoleDefaults` 一致，**只增不减**：

- `ensureProjectRoleTemplates()` 现在对**已存在**的模板也补齐缺失的默认权限
  （早先是「已存在就跳过」，只补行不补权限 —— 那是这个 bug 的根因）；
- 想真正**减掉**某个权限，请建**自定义角色**：只有系统角色会走这条同步路径，
  自定义角色永远不会被碰。

存量数据用一次运维命令补齐（同时补团队模板与该团队下所有已有作品）：

```bash
docker compose -f deploy/docker-compose.yml run --rm --entrypoint node   backend backend/dist/cli/admin.js sync-roles        # 全部团队
docker compose -f deploy/docker-compose.yml run --rm --entrypoint node   backend backend/dist/cli/admin.js sync-roles 团队名  # 只补一个团队
```

命令是幂等的：没事可补时报「共补 0 项」。

## 注意

- 生产环境**必须 HTTPS**：会话 Cookie 带 `Secure`，纯 HTTP 下登录不上。
- 调度器与抓取**只能在 worker 容器里跑**，backend 绝不能起调度循环，否则会重复发布。
- `CREDENTIAL_KEY` 不设时会从 `SESSION_SECRET` 派生：单机够用，但**轮换 `SESSION_SECRET` 会让已存的图源凭据全部解不开**（要重新录）。想独立轮换就显式设一个。
- 凭据（抓取 token / B 站 Cookie / AI key）加密落库、输出掩码，不进 git、不打日志。
- 行尾一律 LF（见 `.gitattributes`）：仓库在 Windows 上开发、在 Linux 上构建镜像，CRLF 的 `Dockerfile` 会让 `RUN ... \` 续行在 Linux 上直接报错。
