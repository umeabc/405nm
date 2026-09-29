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
| M5 | 导出（原图 + LabelPlus txt / 工程包 / 成品包）与成品回传、状态推进到已嵌字 | ✅ |
| M6 | 发布：B 站适配器、Postgres 队列（原子认领 + 幂等键 + 租约 + 两阶段标记）、账号库与署名、一键生成草稿与定时发布 | ✅（真实发布待人工验一次） |
| M7 | 从旧站迁移（含图片与署名台账）：只读导出快照、盘点 / 迁移 / 核验三条命令、逐行逐字段的无损报告 | ✅（真机演练通过，正式切换另约窗口） |
| M8 | AI 机翻：自动标号（视觉模型直接给框 + 原文）、按页机翻（术语优先）、团队术语库、按用户配置的 OpenAI 兼容接入 | ✅ |

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

导出内容就是「图片 + LabelPlus txt」两样，**不做分层 PSD**（见下）。

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

### 不做分层 PSD 导出（已明确的决定）

原计划里 M5 有一项「服务端直接生成分层 PSD」。**已决定不做** —— 导出就这么两样：

- **原图**（工程包里的图片本身）
- **LabelPlus 兼容格式的 txt**（标号坐标 + 译文）

理由是它解决的不是真问题：PSD 由 PS 自己另存即可，而服务端生成需要把图片解成
裸 RGBA 喂给 ag-psd（Node 侧没 canvas 时只能靠 libvips 吐裸数据），引入一条
没必要的依赖链与验证成本。**不要在导出里再加第三种格式。**

## 发布

```
生成草稿（作品页）→ 人工确认 → 立即发 / 排期 → worker 认领并发布 → 已发布
```

| 接口 | 用途 |
|---|---|
| `GET /projects/:id/publish/prepare` | 素材：可发语言、建议署名、可用账号、模板、还有几张没到「已嵌字」 |
| `POST /projects/:id/publish/drafts` | 生成草稿（图片在这一步**快照**进任务） |
| `POST /publish/jobs/:jobId/schedule` | 排期或立即发；不给时间就是现在 |
| `POST /publish/jobs/:jobId/resolve` | 处置「不确定发出去了没有」的任务 |
| `GET /teams/:id/publish/jobs` | 队列 |

权限要**两层都过**：项目域 `publish.approve`（这条内容可以发）+ 团队域
`publish.schedule`（可以用团队的官方号对外发声）。只查项目域的话，
一个作品的监理就能把内容发到团队官方号上 —— 那是把「团队对外发声」
这件更大的事，交给了一个作品级授权。

### ⚠️ 这个子系统里最要紧的一件事：失败怎么分类

发布链路上有两段会产生**站外可见的副作用**的地方，重试语义完全不同：

- **图片上传**：失败可以随便重试。最坏是 B 站图床上多几张没人引用的图，
  没有粉丝看得见。`upload_id` 由任务派生（确定性），重试用的是同一个。
- **`createDynamic`**：**没有幂等参数**。请求一旦发出去，我们就不再能确定
  它有没有成功 —— 超时、连接被掐、进程被杀，全都会留下「可能已经发出去了」
  的状态。这时候**重试就是可能发出第二条动态**。

所以 `PlatformError` 带两个分开的标志位：`retryable`（确定没副作用，可重试）
与 `ambiguous`（不确定）。**只有服务器明确回了业务错误码才算确定失败**，
网络层抛出的一律歧义。

`createDynamic` **之前**先落一条 `publish_attempts(phase='publish', status='in_flight')`；
worker 启动时（以及每次 tick）凡看到这种记录，就把任务标成 `needs_review`
交人工，**绝不自动重发**。界面上这件事必须显眼：只有两个动作
「确实发出去了 / 确实没发出去」，点之前要把后果写清楚。

### 修掉了旧实现（380nm）的三个缺陷

| 缺陷 | 旧实现 | 现在 |
|---|---|---|
| 非原子认领 | `tick()` 先把任务读进内存过滤，再逐条改状态 —— 读与写之间有窗口，两个进程会拿到同一条 | 单条 `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)` |
| 无幂等键 | 没有；重复入队就重复发 | `idempotency_key` 唯一列 + 由它派生确定性 `upload_id` |
| 单进程标志位 | `this._busy`，多实例部署形同虚设 | `claimed_at` + `lease_expires_at`，认领状态在数据库里 |
| **静默重发** | `recover()` 把卡在 `publishing` 的任务一律改回 `pending` | 有 in-flight 发布尝试的一律 `needs_review`；只有**没有**悬空尝试的才回收重排 |

### @ 提及：能点与不能点是两件事

`{{translator}}` 这类模板变量与署名槽位会把 `@handle` 直接拼进正文，
但它们**不会进 mentions**。而 B 站只有 `type=2` 且带 `biz_id` 的节点才是
可点击的 @ —— 所以「模板里配了 @」和「@ 能点」是两回事。

`mergeLibraryMentions` 在**保存草稿与发布时各做一次**（发布时那次是权威的，
覆盖重新入队与历史数据）。判据用**账号库**而不是全文扫描：作者署名里的
X handle 不在账号库中，因此不会被误判成 B 站用户。正则**含日文假名**。

账号库里 `platform_uid` 为空的成员，只当文字用、不进 mentions ——
进了也点不动，不如老实不填。

## AI 机翻

```
工作台点「AI」→ 生成提案 → 表格里改一改、勾掉不要的 → 应用
```

| 动作 | 接口 | 落库后是什么 |
|---|---|---|
| 自动标号 | `POST /files/:id/ai/markers/propose` → `POST /files/:id/ai/markers` | `sources` 行（坐标已归一化，与已有标号按中心点距离去重） |
| 机翻本页 | `POST /files/:id/ai/translations/propose` → `POST /files/:id/ai/translations` | `translations` 里的**候选**（`machineTranslated = true`、不选中） |
| 术语库 | `/teams/:id/term-banks`、`/term-banks/:id/terms` | `term_banks` / `terms`（团队资产，按目标语言隔离） |

三条不能破的规矩：

- **模型给的东西一定先摊在桌子上**。`propose` 与 `apply` 是两次独立请求，中间必须有人过目 —— 没有「一键静默写入」。
- **机翻进的是候选位，不是最终稿**。它 `machineTranslated = true` 且**不选中**；你自己写过、已选中、已校对的行一律不动（判断依据是行自己的状态，所以换个人来跑也不会踩到别人的稿子）。这样「AI 帮了多少忙」可度量，也随时退得回人工。
- **术语表只带这一批原文里真的出现过的词**（子串命中、长词优先、封顶 150 条）。整库塞进 prompt 既贵又会让模型走神。

模型接入**按用户各配各的**（`个人资料 → AI 机翻模型`）：OpenAI 兼容的地址 + Key + 识图模型 + 对话模型，可选出口代理（**留空 = 直连**，自建模型多在内网）。Key 加密落库、接口只回末 4 位。

刻意不做：**本机 OCR sidecar**（要装 tesseract 之类，而模型的看图能力够用；一页一次调用，比「先检测框再逐框裁剪识别」省几十次往返）与 **AI 去字修图**（从来不在范围内）。

## 迁移（彩翻 → 405nm）

三条命令，操作手册见 `docs/m7-migration.md`：

```bash
./deploy/moeflow-export.sh <输出目录> [mongo 容器名]      # 只读导出旧库快照
node backend/dist/cli/migrate-moeflow.js inventory --export <目录>   # 只算不写：先看清单与有损点
node backend/dist/cli/migrate-moeflow.js migrate  --export <目录> --images-dir <旧存储>   # 写库 + 就地核验
node backend/dist/cli/migrate-moeflow.js verify   --export <目录>    # 只核验
```

三件必须知道的事：

- **ID 由旧库 ObjectId 派生**（`uuidv5`），所以重跑幂等、可续跑，不依赖映射表；写库只增不改。
- **核验不是自己跟自己比**：它用同一份计划重算一遍期望值，再与库里的行**逐字段**比，图片还会把字节重新读一遍算摘要。
- **报告里认不出的东西一律判失败**：导出里出现没登记去向的集合、行数与 manifest 不符、邀请码与站内撞码 —— 都不允许「悄悄过去」。

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

`tests/` 下九个脚本：

| 脚本 | 覆盖 |
|---|---|
| `m1-verify.mjs` | 身份 / 团队 / 权限 / 邀请码 / 站点后台 / 站点品牌与立绘 |
| `m2-verify.mjs` | 作品 / 文件 / 媒体字节流 / 去重 / 团队动态 |
| `m3-verify.mjs` | 标号（含框内/框外与只读历史列）/ 译文 / 状态机 / 署名台账 / 通知 / 图片跨作品移动 |
| `m4-verify.mjs` | 抓取客户端（浏览器指纹 JA4 回归护栏、失败分类、代理）+ 七类解析器 + 导入任务。加 `-e M4_LIVE=1` 才会真的出网 |
| `m5-verify.mjs` | 导出体检 / LabelPlus txt 的逐字节格式 / 工程包与成品包（解包校验条目名与 txt 一致）/ 成品版本与删除 / 跨作品越权 / 状态机进 `typeset` 的前置条件 |
| `m6-verify.mjs` | 正文渲染与署名片段 / @ 提及（含日文假名、含大小写不敏感）/ 发布账号与掩码 / 账号库 / 草稿与幂等键 / **队列语义**（原子认领、租约回收、两阶段标记 → `needs_review`、人工处置）/ 权限矩阵 |
| `m7-verify.mjs` | 迁移：纯函数映射（uuidv5 / 权限码 / 署名拆分 / 坐标包围盒 / 进度推定 / 用户名规整 / 译文候选挑选）+ **一份自造的旧库快照**走完盘点→迁移→核验，并验证**幂等**（重跑零写入）与**核验确实会失败**（删行、改字段都判失败，重跑能补回）+ 迁来的账号能用原密码登录并升级哈希 |
| `m8-verify.mjs` | 机翻：模型配置（掩码、默认唯一、越权取不到）/ 术语库（批量解析、按语言隔离、覆盖导入）/ **自动标号**（归一化按实际送出去的预览图算、与既有标号去重、空文本丢弃、提案阶段不落库）/ **机翻**（术语命中且长词在前、重跑是刷新不是新增、人工稿与已选中行不被覆盖、跨页标号写不进去）/ 模型错误分类（看不懂的回复、key 被拒）。模型调用走**脚本内置的假服务**，不碰外网 |
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
