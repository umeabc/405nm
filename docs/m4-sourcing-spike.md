# M4 指纹 spike：结论与证据

2026-09-29。路线图把这件事列为 M4 的开工第一步，因为它是整条图源链路上**不确定性最大**的一环：
抓取代码写完了才发现在目标站点上过不去，返工的成本远大于先花半小时验证。

## 问题

旧站用 Python 的 `curl_cffi` 配 `impersonate="chrome"` 绕 Cloudflare。Node 侧没有等价物。
候选按代价排序：

1. 复用 380nm 已有的纯 Node HTTP/2 客户端（设了 Chrome 风格的密码套件、曲线、签名算法与 ALPN）；
2. 引入 Rust 实现的 fetch 形状客户端 `impit`（真正的浏览器 TLS 指纹 + HTTP/2）；
3. 最坏情况上 `curl-impersonate` 二进制做 sidecar —— 那会破坏「单一语言」的前提。

## 判据

**不是「谁返回 200」** —— 不设防的站点谁都返回 200，拿它当判据等于没测。
要看的是**服务端实际读到的指纹**：只有它和真 Chrome 对得上，「过 Cloudflare」才是能力而不是运气。

## 实测

打 `tls.peet.ws/api/all`（会把自己的指纹回显出来）：

| 客户端 | JA4 | Akamai HTTP/2 指纹 |
|---|---|---|
| `fetch`（undici） | `t13d5212h1_b262b3658495_…` | 无 |
| Node `http2` + Chrome TLS 选项（候选 1） | `t13d1512h2_a5e1f07b32e3_…` | `4:33554432\|00\|0\|m,p,a,s` |
| **impit（候选 2）** | **`t13d1516h2_8daaf6152771_…`** | `2:0;4:6291456;5:16384;6:262144\|15597570\|0\|m,a,s,p` |

**`8daaf6152771` 就是真 Chrome 的 JA4 cipher hash。**

候选 1 虽然把密码套件、椭圆曲线、签名算法都设成了 Chrome 的样子，但 JA4 的第二个字段
（扩展列表的哈希）是 `a5e1f07b32e3` —— 那是 Node 自己的扩展顺序。它也没法伪造 HTTP/2 的
SETTINGS 帧：那个 32MB 的初始窗口一眼就不是浏览器。

Cloudflare 这类防护**两层都看**。所以候选 1 只能算「运气好时能过」，不能当能力依赖。

> JA3 的哈希在两次 impit 运行之间会变（GREASE 值每次都不同，这是设计如此）。
> 判断同源要看 **JA4** —— 它把 GREASE 归一化掉了。这是很容易踩的坑：
> 拿 JA3 比对会得出「两个客户端指纹不同」的错误结论。

## 决定

**用 impit，不做「用哪个客户端」的开关。** 图源抓取只有一个出网口
（`backend/src/sourcing/http.ts`），单一入口才能保证指纹不会被某条支路悄悄绕过。

顺带验证了两个必须确认的前提：

- **`impit-linux-x64-gnu` 在缺 x86-64-v2 的机器上加载正常。**
  这和 sharp 是同一类风险（见 README 里那段），必须单独验，不能想当然。
- **代理不会破坏伪装。** 经代理前后 JA4 完全相同 —— 也就是出口用的是
  普通 CONNECT 隧道，而不是会终结 TLS 的 MITM 代理。如果是后者，impit 就白装了。

## 一个路线图没写、但更要命的前提：必须能出网

spike 一开始三个真实目标全部连不上。查下来不是指纹问题：

- 部署环境的 DNS 把 `www.pixiv.net` 与 `www.google.com` 都解析到**同一个无关的
  第三方网段**（污染应答），`cdn.syndication.twimg.com`、`i.pximg.net` 同理；
- 直连 Pixiv / X / Google **在内网里根本不通**，与客户端无关；
- 同机的 380nm 能抓 Pixiv/X，是因为它配了 `importProxy`。

**结论：「支持代理」对 M4 不是可选项，是前提条件。** 配置项是 `SOURCING_PROXY`
（留空 = 直连）。经代理复测：

| 目标 | 直连 | 经代理 |
|---|---|---|
| Pixiv ajax | 超时 | 404（= 到达源站） |
| X syndication | 连接重置 | 404 |
| i.pximg.net | 超时 | 404 |
| Google | 超时 | 200 |

> 判读方式：打**不存在的作品 id**，`404` 表示请求穿过去了、只是路径不对；
> `403` / `503` 才是被拦。这一条让「网络不通」与「被拦截」不再混为一谈。

### 地址为什么不进仓库

仓库是**公开**的，而代理地址属于内网拓扑。所以：

- 代码与文档只描述**机制**（可配、留空即直连、内网部署必须配）；
- 具体地址只写在各部署机的 `deploy/.env`（已被 gitignore）；
- `.env.example` 与 compose 里留空占位。

## 回归

`tests/m4-verify.mjs` 会重新拉一次指纹报告并断言 JA4 的 cipher hash 是
`8daaf6152771`。这条断言的价值在于：**impit 升级、或者有人改了客户端的构造参数**，
伪装会静默退化 —— 届时不报错，只是某天开始被某些站点拦。指纹断言能在那之前拦住。

## 复现方式

```bash
# 在 backend 容器里（需要出网；内网环境要先配好 SOURCING_PROXY）
docker compose -f deploy/docker-compose.yml run --rm \
  -v /opt/405nm/tests:/repo/tests:ro \
  -e SOURCING_PROXY=... backend node /repo/tests/m4-verify.mjs
```
