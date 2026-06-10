## 新增需求

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

本变更**仅做写入路径**。`/contribute` **禁止**附带实现 `/rankings`(榜单读出)、`/corrections`(人工纠错)、`/compare`(多商品对比)或任何 core `comparability` 能力——这些留给后续变更,待小程序需求明确后再做。`product_raw`/`product`/`unit_price` 之外**禁止**新建表或品类结构。

#### 场景:不引入读出/对比端点
- **当** 应用本变更后检查 `apps/api` 路由
- **那么** 仅存在 `/health`、`/parse`、`/contribute`,**不存在** `/rankings`/`/corrections`/`/compare`
