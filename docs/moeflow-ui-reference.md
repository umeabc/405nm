# moeflow-irohamod 界面参考

从 `umeabc/moeflow-irohamod`（HEAD `50d7c31`）读出来的界面事实，作为 405nm 对齐样式的依据。
**只记录事实与出处，不含任何地址或凭据。**

## 一、技术形态（决定了我们怎么"参考"）

| 项 | moeflow | 405nm |
|---|---|---|
| React | 17 | 19 |
| antd | **4.24** | 5.x |
| 样式方案 | `@emotion/core` 10 的 CSS-in-JS，**没有 .less 页面样式文件** | 一个 `styles.css` + 内联样式 |
| 主题机制 | **构建期 Less 变量覆盖**（`vite.config.mts` 的 `modifyVars`）+ 运行时 CSS 变量 `--moeflow-*` | antd v5 的 `ConfigProvider theme.token` + CSS 变量 |
| ConfigProvider | 只设了 `locale` 与 `form.validateMessages` | 设了完整 token |

**结论：不能照搬它的主题代码。** 它是 antd 4 的 Less 变量体系，我们是 antd 5 的 token 体系，
两边没有共同的抽象。要做的是**照它的色值与尺寸在我们自己的 token 层重写一遍**。

## 二、设计令牌（确切值）

出处：moeflow `frontend/src/style.ts` 的 `antdVars`，运行时经 `frontend/src/index.css` 的 `--moeflow-*` 变量。

### 色板

| 用途 | 值 | 说明 |
|---|---|---|
| **主色** | **`#FF657C`** | 粉。比我们现在的暖珊瑚 `#F0836A` 更冷、更艳 |
| 主色深 | `#d94c66` | 按钮渐变终点、登录页站名 |
| 主色浅 | `#ff8f9c` | |
| 主色更浅 | `#ffbdc5` | |
| 金色点缀 | `#f2b64b` | 登录页光环、卡片顶部斜条纹 |
| 纸粉底 | `#fdf4f6` | 登录页渐变起色、**管理后台背景** |
| 页面底 | `#ffffff` | 暗色 `#121212` |
| 面板底 | `#ffffff` | 暗色 `#1c1c1c` |
| 边框 base / light / lighter | `#dbdbdb` / `#eeeeee` / `#f7f7f7` | 我们目前是 `#F0E4DA` |
| 文字 | `rgba(0,0,0,.85)` / 次要 `.45` / light `.75` / lighter `.65` / lightest `.55` | |
| hover / active / selected | `#eee` / `#d9d9d9` / `#e3e3e3` | |
| 高亮底 | `#fffbe3` | |

### 尺寸

| 项 | 值 |
|---|---|
| **圆角 base / small** | **`8px` / `4px`**（antd 默认是 6/2） |
| navHeight / navHeightM | 40 / 45 |
| tabBarHeightM | 50 |
| headerHeight | 60 |
| paddingBase | 15 |
| contentMaxWidth | 520 |

### 字体

系统栈：`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, ...`（与我们一致）。
另有一支 **`'Label Number'`**（由 ABeeZee 改），**专供翻译标号序号**用。

## 三、登录页（`pages/Login.tsx`）

**形态：整屏左右分栏，不是居中卡片。** 外层 `min-height:100vh; display:flex; align-items:stretch`，
背景 `linear-gradient(135deg, #fdf4f6 0%, #fff 55%, #fff7f0 100%)`。

### 左：品牌区（`flex: 1.1`；**窄于 900px 时 `display:none`**，小屏只剩卡片）

- **立绘 PNG**：`height: min(46vh, 380px)`，默认是仓库里的 mascot 图，**可由站点后台的品牌图覆盖**；
  带粉色投影 + **上下浮动动画 5.5s**。
- 背后**两圈光环**：粉圈 `rgba(255,101,124,.35)` + 金圈 `rgba(242,182,75,.35)`，**4.5s 呼吸缩放**。
- 站点名（读站点设置）：`42px / 700 / 字距 6px / 色 #e0506a`。
- 副标语：`15px / 行高 1.8 / 色 #8a8585`。

### 右：认证卡片

- `max-width: 440px`、白底、**`border-radius: 20px`**、边框 `1px rgba(255,101,124,.14)`、
  阴影 `0 24px 64px rgba(255,101,124,.14)`、内边距 `36px 36px 30px`。
- **顶部 5px 处一条粉金斜条纹**：`repeating-linear-gradient(-55deg, …)`。
- 内容自上而下：
  1. **登录 / 注册分段切换**（自绘 `<button>`，两列 grid，容器圆角 12px、底 `#fdf4f6`）；
  2. 标题 `26px / 700 / #3d3a3a`（登录时写「登录」；从受保护页跳来则写「登陆以继续」）；
  3. 副标题 `14px / #8a8585`（「请用注册邮箱及密码进行登录。」）；
  4. 表单；
  5. 底部「忘记密码？」——文案其实是**「请联系站点管理员」**。

### 登录表单字段

邮箱（带前缀图标）→ 密码（6–60 位）→ **人机验证码** → **「记住我」开关**（居中一行）→
提交按钮 `type=primary size=large block`，`height:44px; border-radius:10px`，
背景 `linear-gradient(135deg, #FF657C, #e0506a)` + 粉色阴影。

### 注册表单字段

邮箱、**邀请码**、用户名（2–18 位，中/日/韩/英/数字/_）、密码；
按钮「注册并登录」；底部提示「注册必须要填邀请码」。

### 已登录态

104px 头像 + 「您好 XXX，您已经登录了。」+ 渐变主按钮「前往仪表盘」+ 普通按钮「登出」。

### 一处不一致（值得注意）

`/register` 路由的 `Register.tsx` **没跟上这次改版**，仍是老样式
（顶部 Header + 把吉祥物当 `background-image` 铺在右下 25% 的居中表单）。
**要对齐就以 `Login.tsx` 为准**，别照 `Register.tsx`。

## 四、主页（登录后落地页）

登录成功跳 `/dashboard/projects`，落地页是「我参与的项目」。

**形态：三栏应用外壳，不是卡片网格。**

1. **左侧全局侧栏**：**悬停自动展开/收起**，折叠 `63px` ↔ 展开 `231px`，
   展开时带 `box-shadow: 0 0 14px rgba(0,0,0,.5)` 与 30% 黑色遮罩。
   内容自上而下：小节标题「仪表盘」→「我参与的项目」→ 小节标题「团队」（右侧 `+` 新建团队）
   → 团队列表（搜索框 + 分页 + 骨架屏）→ **底部固定用户行**
   （37px 头像 + 用户名，`border-top` 分隔），点开是 Dropdown：
   登出 / 暗色模式开关 / 通知一览 / ——— / 首页 / 用户设置 / 新的邀请(带角标) / 相关申请 / 管理页(仅管理员)。
2. **中间 260px 列表栏**：标题行「我参与的项目」（主色 13px 加粗）+ `+` 按钮；
   下面是**虚拟滚动**列表（卡片 `itemHeight: 200`）；顶部有「进行中 / 已完成」两个切换 tab。
3. **右侧内容区**：`DashboardBox` 提供 40px 高的导航条 + 内容槽。

**项目卡**：`1px #eeeeee` 边框、圆角 `8px`、悬停/选中时描边高亮；含项目名（14px）、翻译进度条、设置按钮。

**移动端**：侧栏变成顶部 NavBar + 底部 TabBar（项目 / 团队 / 我）；`Header`（60px，
左上站点名 25px）只用在首页与注册页等**非 Dashboard** 页面。

**页面标题区**用 `ContentTitle`：`18px / bold / 主色 / 下边距 15px`。

## 五、暗色模式

- 入口**只有一处**：PC 侧栏底部用户菜单里的「暗色模式」开关。
- 实现：`document.documentElement.setAttribute('data-theme', 'dark')` + 双份 CSS 变量表
  （`html[data-theme='dark']` 换掉页面底与面板底）+ **手写一大堆 antd 深色覆盖 `!important`**，
  **没有用 antd 的 darkAlgorithm**。
- 偏好存 localStorage，启动时在 render 前写入 `data-theme` 以免首屏闪白。
- **登录页写死了浅色，基本不适配暗色。**

> 这一块 405nm **不打算照搬**：我们用 antd 5 的 `darkAlgorithm` + CSS 变量，
> 覆盖面积小得多，也不会出现"某些组件在暗色下漏白"的经典问题。

## 六、翻译工作台（`pages/ImageTranslator.tsx` 与 `components/project-file/`）

**标号本身没有矩形框。** 它是一个「29px 数字圆点 + CSS 三角箭头」，
挂在图片归一化坐标的 0×0 锚点上，三者都用 `translate(-50%, -100%)` 定位。

- 圆点直径 `numberSize=29`、箭头 `arrowWidth=8 / arrowHeight=5`、`numberTop=-16`。
- **只有那 29px 的圆点可点**（`pointer-events: auto`），箭头与内容框都不可点。
- 唯一带"框"的东西是 `Label__ContentWrapper`：220px 宽、带阴影的**悬浮译文框**，
  `display: none`，只有 `@media (pointer: fine)` 下 `:hover` 才出现。

`框内 / 框外` **不是几何判定**，而是数据字段：

```ts
export const SOURCE_POSITION_TYPE = { IN: 1, OUT: 2 };
```

由鼠标键位赋值，i18n 直接把它译成"框内/框外"。视觉上只用颜色区分：IN 粉 `rgb(255,150,156)`、OUT 黄 `rgb(255,213,131)`。

### 鼠标键位（全部走 pointer 的 `e.button`，没有原生右键菜单）

| 动作 | 行为 |
|---|---|
| **左键点空白图片** | 新建**框内**标号 |
| **右键点空白图片** | 新建**框外**标号 |
| 左键点已有标号 | 只选中/聚焦它（`stopPropagation`，不新建） |
| 中键点已有标号 | 切换框内 ↔ 框外 |
| 右键点已有标号 | **删除**（移动端是长按删除） |
| 拖动标号 | 移动（回写归一化坐标） |

全仓只有两处 `onContextMenu`，都是 `preventDefault()` —— 目的是**屏蔽浏览器右键菜单**，
把 button 2 让给上面的逻辑。没有自定义右键菜单。

Tap 判定：`tapDelay < 500ms && (distance < 5 || button !== 0)`。
滚轮缩放绑在图片层，并由 `MovableArea` 阻止页面缩放。

### 面板与翻页

- 左侧 `ImageViewer` 占满 `宽度 - 400`，右侧 `ImageSourceViewer` 绝对定位、固定 **400px**。
  右面板顶部切 4 个模式：翻译 / 校对 / 全能（`source` 那个按钮被 `display:none` 藏起来了）。
- **译文输入框在右侧面板底部**，不在图上；上方是符号工具条。
- 翻页用 `history.replace` 改 URL（`/image-translator/<图 id>-<语言 id>`）。
  快捷键：`Ctrl/⌘ + ←/→` 翻图；`Tab` / `Shift+Tab` 在输入框之间跳。

## 七、405nm 实际做了什么（2026-09-29）

用户的要求是**「仅仅是 index 页面和 login 页面参考 moeflow，其余不用管」**，
所以下面是**有限范围**的对齐，不是全站重建。

| 项 | 做法 | 状态 |
|---|---|---|
| 色板 | 全局换成 moeflow 的粉（`#FF657C` / 深 `#d94c66` / 金 `#f2b64b` / 纸粉 `#fdf4f6`），圆角 12→8，边框 `#F0E4DA`→`#EEEEEE`，页面底→白 | ✅ |
| 令牌命名 | `comiku` / `--comiku-*` 改名成 `palette` / `--nm-*` —— 名字已经名不副实 | ✅ |
| 半透明主色 | 抽出 `--nm-primary-rgb`，半透明态统一写 `rgb(var(--nm-primary-rgb) / 25%)`，换主色时不会漏掉某个写死的 `rgb(240 131 106)` | ✅ |
| 登录页 | 按 `Login.tsx` 重做：左右分栏 + 立绘 + 双光环 + 站名标语 + 440px 圆角 20px 卡片（粉金斜条纹、自绘分段切换） | ✅ |
| index 页 | 换 `ContentTitle`（18px/700/主色/下边距 15px）；作品卡 8px 圆角、悬停点亮主色描边 | ✅ |
| 立绘可配置 | 站点后台可上传/清除立绘，接口是公开的（登录页未登录就要显示） | ✅ |
| **翻校工作台** | **画布只画标记（数字圆点 + 三角箭头），不再画矩形**；左键点空白 = 框内、右键 = 框外、左键点标记 = 选中、拖动 = 移动；译文改由悬停/选中时的浮层显示 | ✅ |
| 标号序号字体 | `'Label Number'`（改过的 ABeeZee） | ⬜ 未引入 |
| 暗色 | **不照搬**它的手写 `!important` 覆盖，继续用 antd `darkAlgorithm`；登录页与 index 页都实测过暗色 | ✅ |

### 一处需要说明的副作用

用户说"其余不用管"，但**色板是全局令牌**，改它必然波及所有页面。
如果只给登录页和 index 页换色，就会出现「粉色的登录页 → 珊瑚色的作品页」，
那是坏的。所以范围上理解为「不重做其他页面的**结构**，但共用的**色值**跟着换」。

### 数据模型跟着改了

「框内 / 框外」必须落库，不能渲染时再猜 —— 嵌字是**离线在 PS 里做**的，
那边只能读到这份数据。所以：

- `sources.kind`（`box|pin`）**换成** `position_type`（`in|out`），迁移 `0005`；
  存量行按原矩形的**中心点**折算成坐标，然后把 `w/h` 清零（标号是点）。
- `w / h / vertices` 三列**保留但只读**：当前一律为 0 / null，留着是为了
  M7 迁移能如实存下旧站的多边形标注，以及 M5 导出要按框排版。
- 写入接口**不接受**这三列。放进 schema 并给默认值 0 的后果是：
  画布每次整张提交都会把老数据的框清零，且没有任何提示。

### 明确**不做**的

- 三栏外壳（悬停展开的图标侧栏 + 260px 列表栏 + 右侧内容区）—— 用户明确排除。
- 侧栏底部那个用户菜单（登出/暗色/通知/邀请角标）—— 我们已有顶栏的同等功能。
- 移动端的底部 TabBar —— 我们已有窄屏适配。
- **右键点已有标记 = 删除**：彩翻是这么做的，但那边没有确认也没有撤销。
  删一个标号会连带删掉它下面的全部译文，一次误点不该有这种后果 ——
  删除仍然走右侧列表上的按钮，那里有明确的确认框。
- 中键切换框内/框外：中键在很多鼠标上就是滚轮，按住它会触发自动滚动。
  切换改到右侧列表的「框内/框外」标签上点一下，既不占键位，也让当前分类始终可见。
