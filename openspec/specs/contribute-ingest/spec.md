# contribute-ingest 规范

## 目的
待定 - 由归档变更 add-contribute-ingest 创建。归档后请更新目的。
## 需求
### 需求:POST /contribute 写入端点

`apps/api` **必须**提供 `POST /contribute`,接收一条上报商品(`RawProduct` 领域字段 + 溯源字段),把它落进中心库(`product_raw` → `product` → `unit_price`),并返回与 `/parse` 同形的解析结果**外加**三个持久化 id。

请求体 schema **必须**用 Zod 定义(types 从中推导,不手写重复 interface),字段为:
- 领域字段(对齐 `RawProductSchema`):`title`(非空 string,**必须**)、`price`(有限 number,**必须**——`finite` 仅挡 `NaN`/`±Inf`)、`categoryHint`(可选 string)。
- 溯源字段(去重/出处,**不属** `RawProductSchema`):`store`(非空 string,**必须**)、`storeSku`(非空 string,**必须**)、`source`(可选)、`sourceUrl`(可选)、`capturedAt`(可选,`int` epoch ms;不接受 ISO 串)。

`price` 校验**禁止**加正值约束(`.positive()`/`.min(0)`):**负价/0 价是合法上报、不返回 `400`**——`product_raw` 忠实存原始观察(含异常价,沿用 persistence 既有事实),负价/0 价由 core 路由到 `per100ml=null`(沿用 parse-api),走 `200` + `per100ml=null` + warning 并照常落库。`400` 仅用于 `title` 空、`price` 非有限(`NaN`/`±Inf`)、或去重键空。

`store`/`storeSku` 为 `product_raw` 去重键 `(store, store_sku)` 的来源,**必须**在请求层即校验非空——请求 schema **必须先 `trim` 再 `min(1)`**,使空串、**纯空白**、缺失一律 → `400 invalid-request`(与 repository `DedupeKeyGate` 的 `trim().min(1)` 对齐),不得把空/空白键传到 repository 导致它落到 `upsertRaw` 抛错的 `500 persistence-error`。该端点**禁止**在 API 层重写任何解析或计算——tier1 正则与 tier3 计算属 `packages/core`、tier2 属现有 `orchestrate`,本端点只编排「落 raw → orchestrate → 落 parse」,价格/单位换算/可比判断仍由确定性程序决定。

成功(`orchestrate` 返回 `ok`)响应 `200`,体为:`spec` / `unitPrice` / `confidence` / `warnings`(即 `/parse` 既有响应契约)**附加** `rawId` / `productId` / `unitPriceId`(均为 app 生成 TEXT id)。响应**必须**在返回前过 Zod 校验。

#### 场景:合法上报落库并返回 id
- **当** 客户端携带合法 key,POST 一条带 `title`/`price`/`store`/`storeSku` 的有效商品
- **那么** 服务**必须** upsert `product_raw`、跑 `orchestrate`、落 `product` + `unit_price`,返回 `200` 与含 `spec`/`unitPrice`/`confidence`/`warnings`/`rawId`/`productId`/`unitPriceId` 的体

#### 场景:缺去重键字段拒绝
- **当** 请求缺 `store` 或 `storeSku`(或为空串)
- **那么** 服务**必须**返回 `400 invalid-request`,**禁止**写任何行、**禁止**进入 orchestrate

#### 场景:请求体非法拒绝
- **当** 请求 `title` 为空或 `price` 非有限数(`NaN`/`±Inf`)
- **那么** 服务**必须**返回 `400 invalid-request`(与 parse-api 既有语义一致)

#### 场景:负价/0 价合法落库
- **当** 请求 `price` 为负数或 0(有限值)、其余字段合法
- **那么** 服务**禁止**返回 `400`;**必须**照常落 raw、跑 orchestrate(core 路由到 `per100ml=null`),返回 `200` + `unitPrice.per100ml=null` 并落库(忠实存原始观察)

### 需求:观测优先的两段落地

`/contribute` **必须**先 `upsertRaw` 落地原始观察,**再**跑 `orchestrate` 解析,最后在解析成功时 `saveParsed` 落 `product` + `unit_price`。原始上报是最珍贵的众包资产:即便 `orchestrate` 因 LLM 故障返回非 `ok`,**已落地的 `product_raw` 行必须保留**(供日后重解析),不得回滚。`saveParsed` **仅当** `orchestrate` 返回 `ok` 时执行;此时传给 `saveParsed` 的 `calc` 由 `orchestrate` 响应直接组装(`{ unitPrice, confidence, warnings }`),`spec` 用同一响应的 `spec`,**禁止**在 API 层重算 `per100ml`。

由于 raw 先落地,`orchestrate` 失败(`insufficient`/`config-error`,raw 已落但 parse 未落)的**错误响应体必须附 `rawId`**——告知客户端原始观察已沉淀、重试仅为补解析,而非重新上报。客户端重试**安全**(同 `(store, store_sku)` 经 upsert 幂等收敛到同一 raw 行、不堆叠),但**会重新触发 tier2 LLM**(`/contribute` 无内容级解析缓存),其滥用成本由 `api-governance` 限频兜底。`saveParsed` 抛错留下的「有 raw 无 product」中间态是**有意接受**的(`getProduct` 只查有 product 的行,不受影响),供后续批量重解析补齐。

去重落地沿用 persistence 既有语义:同 `(store, store_sku)` 再次上报为 upsert——`price`/`title`/`captured_at` **无条件覆盖**为最近一次;而 `source`/`sourceUrl`(溯源增列)与 `categoryHint`(领域可空字段,沿用 repository 既有处理、与 `title` 的无条件覆盖策略不同)三者按 **COALESCE** 语义:重报提供新非空值则更新、**重报省略(null)则保留旧值**(不被 null 覆盖、不清空)。不堆叠重复行。

`/contribute` 的**成功响应**过 `ParseResponse` + 三 id 的 Zod 校验;**错误响应**沿用既有 `/parse` 形态(`{ error, message }`,不另设 Zod schema)。rawId 归属判据是 **raw 是否已落地**:raw 已落地后才发生的**业务错误**(`insufficient`/`config-error`,以及 `saveParsed` 失败的 `persistence-error`)在该形态上**附单字段 `rawId`**(即 `{ error, message, rawId }`);raw 未落地的错误(`invalid-request`、DB 不可用/`upsertRaw` 失败的 `persistence-error`)**不含 `rawId`**(无可附之 id)。**一个刻意例外**:`internal`(响应自身校验失败的防御性兜底)虽在 raw 已落地后才可能触发,但它在 `ok` 结果下**实质不可达**(`spec`/`unitPrice` 已由 orchestrate 产出且过 `ParsedSpecSchema`、三 id 均非空),沿用 `/parse` 既有 `{ error, message }` 形态、**不附 `rawId`**——作为例外单列,不纳入上面的「raw 已落 ⇒ 附 rawId」判据。

#### 场景:解析失败时 raw 仍保留且响应附 rawId
- **当** `orchestrate` 返回 `insufficient` 或 `config-error`(如 LLM 不可用)
- **那么** `product_raw` 中本次上报的行**必须**已落地并保留(**禁止**因解析失败而删除或回滚 raw),且错误响应体**必须**含该行的 `rawId`

#### 场景:同款重复上报收敛为一行
- **当** 同一 `(store, store_sku)` 被 `/contribute` 上报两次(价格不同)
- **那么** `product_raw` 只保留一行,`price`/`title`/`captured_at` 更新为最近一次(去重键确定、与价格无关)

#### 场景:重报省略溯源字段时保留旧值
- **当** 同一 `(store, store_sku)` 第二次上报省略了 `sourceUrl`(传 null/缺失),首次曾带 `sourceUrl`
- **那么** 该行 `source_url` 列**必须**保留首次的值(COALESCE 语义,**禁止**被 null 覆盖清空)

### 需求:不可计算商品仍落库

`orchestrate` 返回 `ok` 但判定不可计算(`per100ml = null`、`formula = null`)时,`/contribute` **必须**照常 `saveParsed`(`unit_price.per100ml` 落 NULL、保留 `confidence`/`warnings`)并返回 `200`——「确定不可计算」是有效数据点,与可计算商品同等沉淀,**禁止**因 `per100ml=null` 而拒写或返回错误。

#### 场景:确定不可计算也落一行
- **当** `orchestrate` 对某上报算出 `per100ml=null`(如非体积单位)且为 `ok`
- **那么** 服务**必须**落 `product` + `unit_price`(`per100ml` 列为 NULL),返回 `200`,体内 `unitPrice.per100ml` 为 `null`

### 需求:错误状态码可区分

`/contribute` 的失败**必须**用与 `parse-api`/`api-governance` **两两不同**的 error code 表达,使各类失败可断言:

| 情形 | HTTP | error code |
|---|---|---|
| 请求体/去重键不合法 | `400` | `invalid-request`(复用 parse-api) |
| LLM 运行期配置错误(如缺 `OPENROUTER_API_KEY`) | `500` | `config-error`(复用 parse-api) |
| 信息不足无法判定(tier2 传输失败且 tier1 无任何 shape;此时 raw 已落,503 体附 `rawId`,见「观测优先」需求) | `503` | `insufficient-information`(复用 parse-api) |
| DB binding 缺失/不可用,或落库写失败 | `500` | `persistence-error`(本能力新增,与上面**两两不同**) |
| 响应体未过校验 | `500` | `internal`(复用 parse-api) |

`persistence-error` **必须**与 `config-error` 区分:前者是「持久层不可用/写失败」(DB 未绑定、`makeRepo` 工厂内 `createDb`/`createRepository` 抛错、`upsertRaw`/`saveParsed` 抛错——实现**必须** try/catch 工厂调用与写入,使这些路径**确定**落 `persistence-error`,**禁止**让异常冒泡成框架默认 500/`internal`),后者是「LLM 配置错误」——二者同为 `500` 但 error code 不同,可断言。

`persistence-error` 亦**必须**与 `api-governance` 的治理码 `auth-missing`/`auth-malformed`/`auth-forbidden`/`rate-limited` **两两不同**(`/contribute` 已纳入受保护端点集合,会实发这些码);鉴权/限频失败的状态与码由 `api-governance` 决定。

**`config-error` 双源说明**:`config-error` 在系统中**同码双源**——治理环(`api-governance` 真实治理初始化时 `API_KEYS` 缺失)与业务环(本端点 LLM `OPENROUTER_API_KEY` 缺失)都产 `500 config-error`。二者**不靠 error code 区分**,而靠中间件顺序(鉴权环先于业务环:缺客户端 key 先得 `401`,治理侧 `config-error` 不被前置遮蔽、业务侧 `config-error` 被遮蔽),与 `api-governance` 既有「两个 config-error 来源不同、同码」结论一致。断言两两不同的**全集**为 `{invalid-request, config-error, insufficient-information, internal, persistence-error}` ∪ `{auth-missing, auth-malformed, auth-forbidden, rate-limited}`,其中 `config-error` 作为双源同码项不要求自身可区分来源。(注:`api-governance` 的治理码枚举里 `config-error` 是第 5 项——即治理侧 `API_KEYS` 缺失的双源项,已并入上面业务码集合,故治理子集只列 4 个不重复 `config-error`。)

#### 场景:DB 未绑定时报 persistence-error
- **当** 运行环境未注入 D1 binding(如本地 Node dev 无 `DB`),客户端 POST `/contribute`
- **那么** 服务**必须**返回 `500 persistence-error`,与 LLM 缺失的 `config-error` 在 error code 层面可区分

#### 场景:落库写失败报 persistence-error
- **当** `upsertRaw` 或 `saveParsed` 在写入时抛错
- **那么** 服务**必须**返回 `500 persistence-error`(而非 `config-error`/`internal`)

### 需求:本能力不含读出与对比

`contribute-ingest`（写入路径能力）**仅做写入路径**。`/contribute`/`/ingest`/`/ingest/batch` 等写入端点**禁止**内联实现榜单读出、`/corrections`(人工纠错)、`/compare`(多商品对比)或任何 core `comparability` 能力——读出/对比不由写入路径承载。其中 `/rankings`(榜单读出)已由变更 `add-rankings-endpoint`（能力 `rankings-api`）作为**独立只读端点**提供：它不属写入路径、不由本能力实现，与本需求「写入端点不内联读出」并不冲突。`/corrections`/`/compare` 仍**不存在**，留给后续变更，待需求明确后再做。`product_raw`/`product`/`unit_price` 之外、由本能力**禁止**新建表或品类结构（榜单只读查询不新建表，见 `persistence` 的 `listRankings` 契约）。

#### 场景:写入端点不内联读出/对比，/rankings 由独立只读端点承载
- **当** 应用本变更后检查 `apps/api` 路由
- **那么** `apps/api` 路由的**完整集合**为 `{/health, /parse, /contribute, /ingest, /ingest/batch, /rankings}`：其中 `/contribute`/`/ingest`/`/ingest/batch` 为写入路径端点、**本身不内联**榜单读出/对比，`/rankings` 为**独立只读端点**（由 `rankings-api` 提供、公开只读、治理豁免），`/health`/`/parse` 为探活/解析端点；**不存在** `/corrections`/`/compare` 或任何其它读出/对比端点

### 需求:POST /ingest 异步采集端点

`apps/api` **必须**提供 `POST /ingest`,用于「只管快速上报、不需要实时解析结果」的众包采集(如 Surge 插件)。它**同步**落 `product_raw` 后**立即**返回,把 tier2 解析与单价计算移出请求路径(见「后台异步解析」需求)。`/contribute`(同步返回完整解析结果)**保持不变**,两端点**并存**、服务两类客户端。

请求体**必须**复用 `/contribute` 既有的 `ContributeRequestSchema`(同一份 Zod SOT,**不**新增重复 schema):领域 `title`/`price`(`finite`,负价/0 价合法)/`categoryHint?`,溯源 `store`/`storeSku`(均 `trim().min(1)`)/`source?`/`sourceUrl?`/`capturedAt?`(int epoch ms)。`/ingest` 为**单条**上报;**批量**上报由 `POST /ingest/batch` 提供(见「POST /ingest/batch 批量异步采集端点」需求),两者并存、复用同一单条 schema 与同一落地/后台解析 helper。

编排顺序**必须**为:校验请求体 → 取 repository → `upsertRaw` 落 `product_raw` → **立即** `202` 返回 → 排程后台解析。`upsertRaw` 成功**即**返回 `202`,体为 `{ rawId }`(app 生成 TEXT id),过最小 `IngestResponseSchema`(`z.object({ rawId: z.string().min(1) })`)校验,失败 → `500 internal`。该端点**禁止**在 API 层重写任何解析或计算(tier 边界同 `/contribute`)。受 `api-governance` 治理(已纳入受保护端点集合)。

`/ingest` 请求路径的错误码集合**必须**为 `{ invalid-request(400), persistence-error(500), internal(500), accepted(202) }` 加治理码,**不含** `insufficient-information`/`config-error`——因为 `upsertRaw` 成功即 `202`,其后的 `orchestrate`/`saveParsed` 失败发生在**后台**、**不影响** HTTP 状态。raw 落地判据:`202` 体含 `rawId`(raw 已落);raw 未落的错误(`invalid-request`、DB 不可用/`upsertRaw` 抛错的 `persistence-error`)**不含** `rawId`;`internal`(响应自身校验失败的防御性兜底,`rawId` 恒非空故实质不可达)沿用 `/contribute` 既有「不附 rawId」例外。

#### 场景:合法上报秒返 202
- **当** 客户端携带合法 key,POST 一条带 `title`/`price`/`store`/`storeSku` 的有效商品到 `/ingest`
- **那么** 服务**必须** `upsertRaw` 落 `product_raw`、**立即**返回 `202` 与体 `{ rawId }`,**不**在响应里返回 `spec`/`unitPrice`/`confidence`/`warnings`(解析尚未完成)

#### 场景:缺去重键/请求体非法拒绝
- **当** 请求缺 `store`/`storeSku`(空串/纯空白/缺失)、或 `title` 空、或 `price` 非有限数
- **那么** 服务**必须**返回 `400 invalid-request`,**禁止**写任何行、**禁止**排程后台解析

#### 场景:DB 不可用报 persistence-error
- **当** 运行环境未注入 D1 binding,或 `makeRepo` 工厂/`upsertRaw` 抛错
- **那么** 服务**必须**返回 `500 persistence-error`(raw 未落,**不含** `rawId`),**禁止**排程后台解析

#### 场景:错误码不含 503
- **当** 检查 `/ingest` 请求路径可能返回的状态码
- **那么** **不存在** `503 insufficient-information` 或业务 `500 config-error`(这些是后台解析结果,不进 HTTP 响应)

### 需求:后台异步解析必须经可注入端口执行

`/ingest` 的 `orchestrate`(tier1+tier2+tier3)+ `saveParsed` **必须**在响应返回后于**后台**异步执行,且**必须**经一个**可注入的「后台执行端口」**调度(与 `makeLlm`/`makeRepo`/`governance` 同范式),路由**禁止**直接裸调 `c.executionCtx`。后台工作单元 `run` **必须**为 `async` 函数且**自包 try/catch**——使其同步与异步异常都被收敛在后台(包成 rejected promise 交 `waitUntil`),**禁止**任何后台异常传播回**已决定的 `202` 响应路径**(否则 `run` 的同步抛错会污染本应秒返的 202)。

- **生产**(Cloudflare Workers)注入的实现**必须**用 `c.executionCtx.waitUntil(run())`,使后台解析在响应发出后于同一次调用内继续(事件驱动、每条上报**只触发一次**后台解析,**禁止**轮询/重扫导致反复触发 LLM)。
- **Node dev** 无执行上下文(`c.executionCtx` getter 会 throw),注入的实现(或缺省)**必须**为**同步** `await run()`,使本地/测试行为**确定**(`202` 在后台解析完成后返回);路由对生产/dev **统一** `await scheduleBackground(c, run)` 后再返回 `202`,不感知运行时差异。

#### 场景:生产后台落库
- **当** 生产环境注入 `waitUntil` 版后台端口,一条 `ok` 可解析的上报到达 `/ingest`
- **那么** 服务**必须**先 `202` 返回,再于后台 `saveParsed` 落 `product` + `unit_price`(响应不等待解析完成)

#### 场景:dev/测试同步可断言
- **当** 测试注入同步版后台端口,POST 一条 `ok` 上报
- **那么** 后台解析**必须**在 `202` 返回前同步跑完,使测试可断言 `product`/`unit_price` 已落库

#### 场景:路由不裸调 executionCtx
- **当** 检查 `/ingest` 路由实现
- **那么** 它**禁止**直接引用 `c.executionCtx`(避免 Node dev getter 抛错),后台调度**必须**经注入端口

### 需求:后台解析失败只记日志且不重试

后台 `orchestrate` 按三态分流,**禁止**反复重试或反复消耗 LLM:

- `ok` → `saveParsed` 落 `product` + `unit_price`(`calc` 由 `orchestrate` 响应直接组装 `{ unitPrice, confidence, warnings }`,**禁止**在 API 层重算 `per100ml`;不可计算 `per100ml=null` 照常落库)。
- `insufficient`(tier2 传输失败且 tier1 无 shape,如「饮用天然水」无规格标题)→ **只**打结构化日志(含 `rawId`/`store`/`storeSku`),**不** `saveParsed`、**不**自动重试、**不**重发 LLM。
- `config-error`(运行期配置错误)→ 只打日志,**不**重试。
- `saveParsed` 抛错 → 只打日志,**不**重试。

后台失败留下的「有 raw 无 product」中间态是**有意接受**的(与本能力既有中间态同质,`getProduct` 只查有 product 的行,不受影响)。客户端重试**安全**且不堆叠(同 `(store, store_sku)` 经 `upsertRaw` 幂等收敛同一行;每次上报仍只触发一次后台解析,总量由 `api-governance` 限频在入口兜住)。本期**不**做后台瞬态失败的有界重试(留作后续 Queues/cron 独立变更)。

#### 场景:不可解析标题只解析一次
- **当** 一条标题无规格(`orchestrate` 后台返回 `insufficient`)的上报经 `/ingest` 处理
- **那么** 服务**必须**只跑一次后台 tier2、打日志、保留 `product_raw` 行,**禁止**把它再次喂给 LLM(无重扫/重试机制)

#### 场景:后台 config-error 不影响已返回的 202
- **当** 后台 `orchestrate` 返回 `config-error`(运行期配置错误)
- **那么** 客户端**已**收到的 `202`/`rawId` **不**受影响(失败只进日志、不 `saveParsed`、不重试),`product_raw` 行保留、`product` 不落

#### 场景:后台 saveParsed 抛错保留 raw 且不影响 202
- **当** 后台 `orchestrate` 返回 `ok` 但 `saveParsed` 写入时抛错
- **那么** 客户端**已**收到的 `202`/`rawId` **不**受影响(失败只进日志、不重试),`product_raw` 行**保留**、`product`/`unit_price` **不落**(「有 raw 无 product」中间态),后台**禁止**重发 LLM 或重扫

### 需求:/contribute 同步契约不受 /ingest 影响

引入 `/ingest` **禁止**改动 `/contribute` 的既有同步契约——`/contribute` 仍**必须**同步 `upsertRaw → orchestrate → saveParsed` 并返回含 `spec`/`unitPrice`/`confidence`/`warnings`/`rawId`/`productId`/`unitPriceId` 的 `200`(或既有 `400`/`500`/`503` 错误语义),其 spec 既有场景与响应体**保持不变**。

#### 场景:/contribute 行为不变
- **当** 客户端 POST 一条有效商品到 `/contribute`
- **那么** 服务**必须**按既有语义同步返回 `200` + 完整解析结果 + 三 id(与本变更前完全一致)

### 需求:POST /ingest/batch 批量异步采集端点

`apps/api` **必须**提供 `POST /ingest/batch`,用于一次上报**多条**商品的众包采集(降低逐条 HTTPS 握手开销,服务客户端在受限执行窗口内的批量 backfill)。它沿用 `/ingest` 的**异步**语义:逐条**同步**落 `product_raw` 后**立即**返回 `202`,把每条的 tier2 解析与单价计算移出请求路径(后台 `ctx.waitUntil`)。`/ingest`、`/contribute` **保持不变**,三端点并存。

请求体**必须**为 `BatchIngestRequestSchema = z.object({ items: z.array(ContributeRequestSchema).min(1).max(MAX_BATCH) })`——`items` 是**单条** `ContributeRequestSchema`(同一份 Zod SOT,**不**新增重复单条 schema)的数组,长度 `1..MAX_BATCH`。**`MAX_BATCH` 默认取 `40`**(免费计划 Worker 子请求上限 50 留余量——见下「子请求预算」);**调高到 100+ 须先确认生产 Worker 为付费计划(1000 子请求上限),作为显式部署前置、不得 defer**。校验**严格**:非 JSON / 非 `{ items: [...] }` / 空数组 / 超 `MAX_BATCH` / **任一条目不合 `ContributeRequestSchema`** → `400 invalid-request`,**禁止**写任何行、**禁止**排程任何后台解析。

编排顺序**必须**为:校验信封 → 取 repository → **同步逐条** `upsertRaw` 落 `product_raw`(经**强制共享**的落地映射 helper,与 `/ingest` **同一**份字段映射,**禁止**在 handler 内联复制)→ 对落地成功的条目排程**单个有界并发**后台解析单元 → `accepted≥1` 时**立即** `202`。后台单元**必须**用固定并发池(`BG_POOL`,如 5)消费落地条目,每条跑与 `/ingest` 后台 `run` 同逻辑(`orchestrate` → `ok` 则 `saveParsed`,自包 try/catch、失败仅 log、一条**不连累**其余)。**禁止**对每条各排程一个 `waitUntil`——那会瞬间派 `MAX_BATCH` 个并发后台单元、对 LLM/D1 形成**无界并发**;**必须**收敛为单个 `waitUntil(后台池)`、并发钉在 `BG_POOL` 以内。该端点**禁止**在 API 层重写任何解析或计算(tier 边界同 `/ingest`)。受 `api-governance` 治理(纳入受保护端点集合,须**自行**挂治理中间件——Hono 精确路径匹配,`/ingest` 的中间件不套住 `/ingest/batch`)。

**子请求预算**:单次请求后台 LLM fetch 总数 = 落地条目中触达 tier2 的条数 ≤ `MAX_BATCH`,计入该 Worker invocation 的子请求上限;`BG_POOL` 限**并发**、不减**总量**,故子请求总量由 `MAX_BATCH` 守、并发风暴由 `BG_POOL` 守(两个独立约束)。

响应**必须**为 `BatchIngestResponseSchema = z.object({ accepted: int≥0, failed: Array<{ index: int≥0, store: string, storeSku: string }> })`:`accepted` = 成功 `upsertRaw` 落地并纳入后台解析的条数;`failed` = 失败条目的 `{ index, store, storeSku }` 列表(`index` = 该条在请求 `items` 数组中的**原始下标**,供客户端**精确定位**失败条、选择性重试)。**不变量**:`accepted + failed.length === items.length`(逐条一一对应、**不去重**)。**失败条目必须用 `index` 标识、不可仅返裸 `storeSku`**:同批「跨 store 同 `storeSku`」或「同 `(store,storeSku)` 重复」时裸 `storeSku` 列表无法定位;`index` 在原数组唯一、消歧(`store`/`storeSku` 一并返供客户端键/日志)。

`/ingest/batch` 请求路径错误码集合**必须**为 `{ invalid-request(400), persistence-error(500), internal(500), accepted(202) }` 加治理码,**不含** `insufficient-information`/`config-error`(解析在后台、不影响 HTTP 状态)。状态判据:
- 信封非法 → `400`(无 raw 落地)。
- repo 未绑定/`resolveRepo` 抛错 → `500 persistence-error`(整批,无 raw 落地)。
- 信封合法、repo 解析成功但**全部**条目 `upsertRaw` 失败(`accepted=0`)→ **`500 persistence-error`**:`accepted=0` = 未落任何 raw,**禁止**返 2xx 把整批写失败伪装成已受理(与单条 `/ingest` 的 `upsertRaw` 失败→500 一致)。
- 信封合法、repo 解析成功、**`accepted≥1`** → `202`(**部分失败**即 `failed.length≥1` 仍 202,逐条失败由 body `failed: [{index,store,storeSku}]` 报告、不改 HTTP 状态、不回滚已落地条目)。
- `internal(500)`:响应自身校验失败的防御兜底(实质不可达)。
- raw 落地判据:`202` ⟺ `accepted≥1`;`accepted=0` 一律走 `500`、不返结果体。

**`config-error` 说明(同 `/ingest`)**:上面「不含 `config-error`」指**业务侧** config-error(LLM `OPENROUTER_API_KEY` 缺失)——它在**后台** `orchestrate` 才触发、不入请求路径码集。**治理侧** config-error(`api-governance` 的 `API_KEYS` 缺失,`500 config-error`)属上面「加治理码」的一部分、可在请求路径出现(治理中间件前置),与既有 `/ingest` 的「config-error 双源」框架(见 contribute-ingest §错误状态码可区分)一致——批量端点继承同一治理行为,不另立。

#### 场景:一批合法商品秒返 202 并逐条落地
- **当** 客户端携带合法 key,POST `{ items: [3 条合法商品] }` 到 `/ingest/batch`
- **那么** 服务**必须**对每条 `upsertRaw` 落 `product_raw`、排程**单个有界并发**后台解析单元、**立即**返回 `202` 与体 `{ accepted: 3, failed: [] }`,**不**在响应里返回解析结果(`spec`/`unitPrice` 等,后台尚未完成)

#### 场景:信封非法整批拒绝
- **当** 请求体非 JSON、或非 `{ items: [...] }`、或 `items` 为空数组、或长度超 `MAX_BATCH`、或**任一**条目缺 `store`/`storeSku`/`title` 或 `price` 非有限数
- **那么** 服务**必须**返回 `400 invalid-request`,**禁止**写任何行、**禁止**排程任何后台解析(整批拒,无部分落地)

#### 场景:单条落地失败不连累整批(accepted≥1 仍 202)
- **当** 一批 N 条(`N≥2`)信封合法、repo 已解析,其中某条 `upsertRaw` 抛错(偶发)、其余成功
- **那么** 服务**必须**仍对其余条目落地+纳入后台、返回 `202`,体 `accepted` 为成功条数(≥1)、`failed` 含该条 `{ index, store, storeSku }`(整批**不** 5xx、**不**回滚已落地条目);且 `accepted + failed.length === N`

#### 场景:全部条目落地失败报 persistence-error
- **当** 信封合法、repo 解析成功,但**全部** N 条 `upsertRaw` 失败(`accepted=0`,如 DB 写中途全失败)
- **那么** 服务**必须**返回 `500 persistence-error`(未落任何 raw,**禁止** 2xx 伪装成功),**不**返 `{accepted, failed}` 结果体

#### 场景:DB 未绑定整批报 persistence-error
- **当** 运行环境未注入 D1 binding,客户端 POST `/ingest/batch`
- **那么** 服务**必须**返回 `500 persistence-error`(整批,无 raw 落地),体**不含** `accepted`/`failed` 结果(走错误形态)

#### 场景:批量端点缺 key 被治理拒绝
- **当** 客户端**不带** key POST `/ingest/batch`
- **那么** `api-governance` **必须**拦截返回 `401`(确认批量端点确已自挂治理中间件、未因路径而漏挂),**禁止**进入业务、**禁止**落任何行

### 需求:ingest/contribute 必须采集门店 native category id 作专用 provenance

`/ingest`、`/ingest/batch`、`/contribute` 的请求体**必须**支持一个**可空、专用**的门店原生品类字段 `nativeCategoryId`(山姆 `categoryIdList` 路径末端**叶 id** 字符串),作为**门店来源 provenance**(与 `store`/`storeSku`/`source`/`sourceUrl`/`capturedAt` 同层),用于打标签管线经 `store_category_map` 命中门店自身的叶级分类。

- **禁止复用 `categoryHint`**:`categoryHint` 是 `product.category`(粗 `'beverage'`)的透传源,塞 native-id 会污染领域列。`nativeCategoryId` **必须**是**独立字段**。
- **禁止进 core 领域 `RawProductSchema`**:native-id 是门店来源、非领域规格;领域 raw 仍只认 `title`/`price`/`categoryHint`。该字段在请求 envelope 的 provenance 层、随 `upsertRaw` 落 `product_raw.native_category_id`(见 `persistence`)。
- 校验语义:**显式 JSON `null` / 空串 / 纯空白均等同于省略** → 落 `null`、请求照常成功(**禁止**报 400);仅当传入**有意义的非空值**时 trim 后存储;非字符串(如数字)→ 400。即 schema **必须**先 preprocess 把 `null`/空白归为「省略」再 `min(1)`(裸 `z.string().trim().min(1).optional()` 会让空串/`null` 触发 400,与下方场景冲突,**禁止**)。
- 不改 `/contribute` 同步 200 契约、`/ingest` 202 异步契约、错误码集与现有 provenance COALESCE 语义;`nativeCategoryId` 只是**新增可空入参**,旧客户端不带它行为不变(**非** BREAKING)。

#### 场景:ingest 带 nativeCategoryId 落库供 store-map
- **当** 客户端 `POST /ingest`(或 `/contribute`/`/ingest/batch`)body 带 `nativeCategoryId: "10012164"`(山姆白酒叶 native id)
- **那么** 该值**必须**经 `upsertRaw` 写入 `product_raw.native_category_id`,**不得**写入 `categoryHint` 或 `product.category`;后台打标签时经 `store_category_map` 命中对应叶

#### 场景:省略 nativeCategoryId 退化为 tier1、不报错
- **当** 客户端不带 `nativeCategoryId`(或传空串 / 纯空白 / 显式 JSON `null`)
- **那么** `product_raw.native_category_id` 落 `null`,请求**必须**照常成功(契约不变,**不得**报 400);该商品分类仅走 tier1 关键词(store-map 不点火)

#### 场景:nativeCategoryId 不污染领域 category 列
- **当** 任意带 `nativeCategoryId` 的上报落库
- **那么** `product.category` **仍**由 `categoryHint` 透传(`'beverage'`),`nativeCategoryId` **禁止**改变 `product.category` 或 `categoryHint`

