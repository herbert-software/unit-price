## 新增需求

### 需求:分类 Tab 必须以只读品类树呈现并可下钻到 category-scoped 榜

`分类` Tab **必须**渲染 store-agnostic 品类 is-a 树:进入时**经 `@unit-price/api-client`**(`buildCategoriesUrl` 构造 URL、`Taro.request` 发请求、`parseCategoryTreeResponse` 校验响应)**一次性**消费 `GET /categories`(整树单次小负载、**无分页**;**禁止**手写响应类型或绕过校验、**禁止**端上单价计算);按 `parentSlug` 把扁平节点构建为**稳定 pre-order 缩进列表**(兄弟保持服务端返回序)。节点 `comparableUnit`(is-a 继承后)与 `rankableCount` 由服务端解析,端**只渲染**。

节点可点性**必须**由 `node.rankable` 决定:`rankable=true` 节点(单一可比 cohort)可点、下钻到 category-scoped 榜;`rankable=false` 节点(root `饮料` / `酒类` parent)**必须**为**不可点分组头**(点击会撞服务端 cohort `400`,故由端上 `rankable` 闸口、**禁止**对其发起 `/rankings`)。

点击 `rankable` 节点**必须** `navigateTo` 一个**非 tab 的 category-scoped 榜页**:把品类 `slug` 与 `name` 经路由参数传入,`setNavigationBarTitle` 为品类名;该榜**必须**复用与榜单首页**同一套**消费契约与三态 / 分页 / page-error 语义,经 `buildRankingsUrl({ category })` 消费 `GET /rankings?category=<slug>`、按 `per100ml` 升序展示,仅去掉品牌头 / 搜索 / scope / chips / 广告位 chrome。

四态**必须**明确:loading、error(整屏错误 + 重试)、空(`nodes` 为 `[]` 的未播种 taxonomy 窗口——**必须**显式空态、**禁止**白屏或报错)、就绪。

#### 场景:经 api-client 只读消费 /categories
- **当** 进入 `分类` Tab
- **那么** **必须**用 `buildCategoriesUrl` + `Taro.request` + `parseCategoryTreeResponse` 一次性取整树并渲染稳定 pre-order 缩进树;**禁止**手写响应类型、绕过校验或在端上做单价计算

#### 场景:可点性由 rankable 闸口
- **当** 树中存在 `rankable=false` 的 root / parent 节点(如 `饮料` / `酒类`)
- **那么** 这些节点**必须**为不可点分组头、**禁止**对其发起 `/rankings`;仅 `rankable=true` 节点可点下钻

#### 场景:下钻 category-scoped 榜
- **当** 点击一个 `rankable=true` 品类节点
- **那么** **必须** `navigateTo` 非 tab 榜页、标题为品类名,经 `buildRankingsUrl({ category })` 消费 `GET /rankings?category=<slug>` 并按 `per100ml` 升序展示,沿用榜单首页的三态 / 分页 / page-error 语义

#### 场景:未播种 taxonomy 的空态
- **当** `GET /categories` 返回 `{ nodes: [] }`
- **那么** **必须**显示显式空态(非白屏、非报错)

### 需求:我的为带设计的占位 Tab

`我的` Tab 在本期**必须**为**带设计的占位页**(套用 P0 设计语言、显示「敬请期待」一类占位内容),**禁止**白屏。`我的` 占位页本期**禁止**出现贡献 / 录入 / 纠错的可用入口(保持只读边界;贡献入口留待 P6)。

#### 场景:占位页非白屏
- **当** 切换到 `我的` Tab
- **那么** **必须**显示带 P0 设计的占位内容(非白屏、非报错)

#### 场景:我的占位不含贡献/录入/纠错
- **当** 检查 `我的` 占位页
- **那么** 本期**禁止**包含可用的贡献 / 录入 / 纠错(`/corrections`)/ 扫码 / 拍照入口

## 修改需求

### 需求:miniapp 必须是消费 /rankings 的只读榜单小程序骨架

`apps/miniapp`(`@unit-price/miniapp`)**必须**是一个 Taro(React + TS)微信小程序工程,定位为**只读骨架**:采用 **3 个底部 Tab**——**榜单(首页)/ 分类 / 我的**,其中**榜单为首页 Tab**、承载真实单价榜浏览。`navigationBarTitleText` **必须**为 `Sams值不值`。

整体仍为**只读浏览**:**禁止**包含录入 / 扫码 / 拍照路径,**禁止**在端上跑 tier1 解析或单价计算(只读已算好的 `/rankings` / `/categories` 派生数据)。本期顶部搜索入口仅为**点击 toast 占位提示(不跳页)**、`我的` Tab 仅为占位页(见下),二者**均不构成录入路径、且不发起任何网络请求**;`分类` Tab **仅**发起**只读** `GET /categories`(整树浏览),其下钻的 category-scoped 榜**仅**发起**只读** `GET /rankings?category=<slug>`——二者均无写、无录入。榜单数据**必须**通过 `@unit-price/api-client`(`buildRankingsUrl` + `parseRankingsResponse`)消费 `GET /rankings`,网络层用 `Taro.request`(api-client 传输无关,发请求在本端)。

**构建集成**:`apps/miniapp` 是 pnpm workspace 成员(deps 走 `workspace:*`),但**必须不进**根 `tsconfig.json` 的 `tsc -b` references——由 `@tarojs/cli` 自管构建,消费 `@unit-price/api-client` 的**预构建 dist**。api-client/core **必须**先于 Taro 打包构建(构建顺序)。

#### 场景:只读、不含录入与计算
- **当** 检查 `apps/miniapp` 源码
- **那么** **禁止**出现录入 / 扫码 / 拍照入口,**禁止**引入 `packages/core` 的 tier1/calculator 做端上计算;榜单数据**必须**来自 `/rankings`(已算好的 per100ml)、品类树来自 `/categories`(已解析的 `comparableUnit` / `rankableCount`)

#### 场景:三个底部 Tab 且只读边界不变
- **当** 进入小程序
- **那么** **必须**有 3 个底部 Tab(榜单 / 分类 / 我的),榜单为首页;切换 Tab 不破坏只读边界——本期 `我的` / 顶部搜索入口 / attribute chips **禁止**发起**任何**网络请求,`分类` Tab **仅**发起**只读** `GET /categories`、其下钻榜**仅**发起**只读** `GET /rankings?category=<slug>`(经 api-client,语义同榜单首页);全程**禁止**包含录入 / 扫码 / 拍照 / 贡献 / 纠错入口

#### 场景:经 api-client 消费 /rankings
- **当** 小程序请求榜单
- **那么** **必须**用 `@unit-price/api-client` 的 `buildRankingsUrl` 构造 URL、`Taro.request` 发请求、`parseRankingsResponse` 校验响应;**禁止**在 miniapp 内手写重复的响应类型或绕过校验

#### 场景:miniapp 不进根 tsc -b reference 图
- **当** 检查根 `tsconfig.json` 的 references
- **那么** **必须不含** `apps/miniapp`(Taro 自管构建);miniapp 消费 api-client 的预构建 dist,api-client/core 先于 Taro 打包构建

## 移除需求

### 需求:分类与我的为带设计的占位 Tab
**Reason**: `分类` Tab 本期接通真实品类树(`GET /categories`)并支持下钻 category-scoped 榜,不再是占位页;`我的` 的占位约束由新需求「我的为带设计的占位 Tab」原样承接(只读边界不变)。
**Migration**: `分类` Tab 行为见新需求「分类 Tab 必须以只读品类树呈现并可下钻到 category-scoped 榜」;`我的` 占位约束见新需求「我的为带设计的占位 Tab」。
