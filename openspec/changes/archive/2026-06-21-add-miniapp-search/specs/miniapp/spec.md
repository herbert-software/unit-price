## 修改需求

### 需求:miniapp 必须是消费 /rankings 的只读榜单小程序骨架

`apps/miniapp`(`@unit-price/miniapp`)**必须**是一个 Taro(React + TS)微信小程序工程,定位为**只读骨架**:采用 **3 个底部 Tab**——**榜单(首页)/ 分类 / 我的**,其中**榜单为首页 Tab**、承载真实单价榜浏览。`navigationBarTitleText` **必须**为 `会员商店值不值`。

整体仍为**只读浏览**:**禁止**包含录入 / 扫码 / 拍照路径,**禁止**在端上跑 tier1 解析或单价计算(只读已算好的 `/rankings` / `/categories` 派生数据)。顶部搜索入口为**真输入**:用户输入商品名后跳转复用 board 列表页、发起**只读** `GET /rankings?q=<词>`(语义同榜单、仍按已算好的 `per100ml` 升序),**仍不构成录入 / 扫码 / 拍照 / 贡献 / 纠错路径**;`我的` Tab 仅为占位页(见下),**不发起任何网络请求**;`分类` Tab **仅**发起**只读** `GET /categories`(整树浏览),其下钻的 category-scoped 榜**仅**发起**只读** `GET /rankings?category=<slug>`——以上均无写、无录入。榜单/搜索/下钻榜数据**必须**通过 `@unit-price/api-client`(`buildRankingsUrl` + `parseRankingsResponse`)消费 `GET /rankings`,网络层用 `Taro.request`(api-client 传输无关,发请求在本端)。

**构建集成**:`apps/miniapp` 是 pnpm workspace 成员(deps 走 `workspace:*`),但**必须不进**根 `tsconfig.json` 的 `tsc -b` references——由 `@tarojs/cli` 自管构建,消费 `@unit-price/api-client` 的**预构建 dist**。api-client/core **必须**先于 Taro 打包构建(构建顺序)。

#### 场景:只读、不含录入与计算
- **当** 检查 `apps/miniapp` 源码
- **那么** **禁止**出现录入 / 扫码 / 拍照入口,**禁止**引入 `packages/core` 的 tier1/calculator 做端上计算;榜单/搜索数据**必须**来自 `/rankings`(已算好的 per100ml)、品类树来自 `/categories`(已解析的 `comparableUnit` / `rankableCount`)

#### 场景:三个底部 Tab 且只读边界不变
- **当** 进入小程序
- **那么** **必须**有 3 个底部 Tab(榜单 / 分类 / 我的),榜单为首页;切换 Tab 不破坏只读边界——本期 `我的` **禁止**发起**任何**网络请求,顶部搜索入口**仅**发起**只读** `GET /rankings?q=<词>`(经 api-client,语义同榜单),`分类` Tab **仅**发起**只读** `GET /categories`、其下钻榜**仅**发起**只读** `GET /rankings?category=<slug>`;全程**禁止**包含录入 / 扫码 / 拍照 / 贡献 / 纠错入口

#### 场景:经 api-client 消费 /rankings
- **当** 小程序请求榜单
- **那么** **必须**用 `@unit-price/api-client` 的 `buildRankingsUrl` 构造 URL、`Taro.request` 发请求、`parseRankingsResponse` 校验响应;**禁止**在 miniapp 内手写重复的响应类型或绕过校验

#### 场景:miniapp 不进根 tsc -b reference 图
- **当** 检查根 `tsconfig.json` 的 references
- **那么** **必须不含** `apps/miniapp`(Taro 自管构建);miniapp 消费 api-client 的预构建 dist,api-client/core 先于 Taro 打包构建

## 新增需求

### 需求:搜索入口为真输入、跳转复用 board 列表页

顶部搜索入口**必须**为**真输入**(Taro `Input`):用户输入商品名并确认(`confirm`)后,**必须** `navigateTo` 复用既有 board 列表页,路由**只带 `q`**(`board?q=<编码词>`,**不带** `name`——避免第二个自由文本参数也要确定性解码),由 board 经 `@unit-price/api-client` 的 `buildRankingsUrl({ q })` 消费**只读** `GET /rankings?q=<词>`、复用与榜单首页**同一套**三态 / 分页 / page-error 语义、按 `per100ml` 升序展示。搜索**全程只读**:**禁止**在端上做解析 / 单价计算 / 重排,**禁止**构成录入 / 扫码 / 拍照路径。

**board 标题按来源派生(优先级确定)**:`board` 同时服务「搜索(带 `q`)」与「分类下钻(带 `category`+`name`)」两条入口,优先级 `解码后 q (trim 非空) ? 搜索：<解码后的 q> : (name ?? 分类榜)`——判据是**解码后的 `q` 非空**(trim 后),**非** `q` 键是否存在(否则手敲 `?q=` 会出空标题「搜索：」)。二者皆无(手敲路由)→ 既有默认 `分类榜`;二者皆有(将来 `q`+`category`)→ `q` 胜。分类下钻的 `name` 路径**保持不变**(固定 CJK、无 `%`,沿用既有 decode-once-fallback);**仅** `q` 走下面的确定性解码。

**端上词长校验按 Unicode 码点**(`[...s]`,与服务端同口径,**禁止** UTF-16 `length`):`trim` 后长度 `0`(空 / 纯空白)→ 不跳转、不发请求;长度 `1`(单字过宽,与服务端 `400` 口径一致)→ 不跳转、不发请求、给行内轻提示(如「至少输入 2 个字」);长度 `≥ 2` 才跳转——避免明知会被服务端 `400` 的请求空跑一次往返。端上**必须**先按码点截断到 `≤ 64`(与服务端同口径),使 URL、board 标题、服务端实际过滤的词**一致**(否则 >64 粘贴会出现「显示词 ≠ 实际过滤词」)。

**路由参数必须 URL 编码 + 确定性解码(端到端恰好 1 次解码)**:`q` 是自由文本,可含字面 `%` / `&` / `=`(**不同于**固定 CJK 品类 taxonomy)。`navigateTo` 处**必须** `encodeURIComponent(q)`(把字面 `%` 编成 `%25`)。**不变量**:从源端编码到 board 读到的 `q`,**端到端解码次数必须恰好为 `1`**——源端编码一次,故正好一次解码还原;`0` 次留下编码态、`2` 次会把 `100%20纯` 误折成 `100 纯`(字面有效转义被二次解码)。`readBoardParams` 对 `q` **禁止**复用 `name` 的 try-decode-catch-raw 兜底(只在 `decodeURIComponent` **抛错**时触发,对「成功但解错」无效)。**必须**先实测该 Taro 版本 `onLoad` 是否已对 query 解码:已解(=1)→ `readBoardParams` 对 `q` **不再解码**;未解(=0)→ `readBoardParams` 解码一次。解码层是纯 JS(`decodeURIComponent` / Taro router),非原生桥,故 devtools 与真机一致;但鉴于本项目有过 devtools/真机 分歧史,验收**必须**含真机 `100%20纯` 往返校验(见 tasks 5.3)。同步更新 `params.ts` 里「固定 taxonomy 无 `%`」的注释(`q` 现承载自由文本、走确定性解码;`name` 仍是固定 CJK 走兜底)。

本期**不做**:相关性 / 模糊 / 拼音 / 分词搜索、跨 cohort 混合单位同列、搜索历史 / 联想 / 热词(均见提案非目标)。

#### 场景:输入商品名后跳转复用 board 列表页搜索
- **当** 用户在顶部搜索入口输入「可乐」并确认
- **那么** **必须** `navigateTo` 至 `board?q=<encodeURIComponent(可乐)>`(**不带** `name`),board 确定性解码 `q`、`buildRankingsUrl({ q })` 发起**只读** `GET /rankings?q=可乐`、按 `per100ml` 升序复用三态 / 分页渲染结果,**禁止**端上计算或重排

#### 场景:board 标题按来源派生
- **当** board 带解码后非空的 `q`(搜索入口)进入
- **那么** 标题为 `搜索：<解码后的 q>`(用解码后的词、非编码态)
- **当** board 带 `category`+`name`(分类下钻)进入、无 `q`
- **那么** 标题为 `name`(品类名),分类下钻路径与现状**完全不变**
- **当** board 同时带非空 `q` 与 `name`(将来的 cohort 内搜索)
- **那么** `q` 胜,标题为 `搜索：<解码后的 q>`
- **当** board 既无 `q` 也无 `name`(手敲路由),或 `q` 解码后为空
- **那么** 标题为既有默认 `分类榜`(不出空「搜索：」)

#### 场景:含 % / & 的搜索词逐字节往返不变
- **当** 用户输入含字面 `%`/`&` 的词,含会被误判为有效转义的 `100%20纯`/`a%20b` 与不完整转义的 `100%`,并确认
- **那么** 经 `encodeURIComponent` + board 侧确定性解码,board 实际过滤的 `q` 与用户输入**逐字节一致**(`100%20纯` 不得被解成 `100 纯`),参数解析不破裂

#### 场景:空输入或单字不发起请求
- **当** 用户点击搜索入口但未输入(或仅空白,trim 后长度 0)即确认
- **那么** **禁止**发起任何网络请求、**禁止**跳转空查询页;搜索**禁止**构成录入 / 扫码 / 拍照路径
- **当** 用户仅输入单字(trim 后长度 1 码点,如「水」)即确认
- **那么** **禁止**跳转、**禁止**发起请求,**必须**给行内轻提示(至少 2 个字),与服务端 `400` 口径一致

## 移除需求

### 需求:搜索入口本期为占位、不发起任何请求

**Reason**: 本期把搜索从占位升级为真搜索——顶部搜索入口改为真输入并发起**只读** `GET /rankings?q=<词>`,与本要求「占位、禁止发起任何网络请求」直接冲突。保留会使同步后的主 spec 自相矛盾。
**Migration**: 由本变更新增的「搜索入口为真输入、跳转复用 board 列表页」取代;只读边界(禁止录入/扫码/拍照)由该新需求与「miniapp 只读榜单小程序骨架」修改后的条款共同维持。
