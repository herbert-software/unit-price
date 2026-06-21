## 新增需求

### 需求:POST /compute 必须按结构化输入确定性计算单价并在所选 cohort 内定位

`apps/api` **必须**提供无状态端点 `POST /compute`，对**结构化**入参做**确定性**单价计算并在所选品类 cohort 内定位。**禁止**调用任何 LLM / AI（输入已结构化，无「理解」环节；本端点是 tier3 确定性计算，符合「AI 只理解不计算」约定）。**禁止**任何持久化 / DB 写 / 众包入库——纯按需无状态计算。

**入参契约** `ComputeRequestSchema`（Zod 单一事实源，定义在 `@unit-price/api-client`、**禁止 DIRECT import** `packages/core`，以保持其可安全打进 weapp）：`{ totalPrice:number>0, quantity?:int>0, unitSize?:{ value:number>0, unit }, totalAmount?:{ value:number>0, unit }, category:string }`，`unit ∈ {ml,L,g,kg}`。服务端**必须**用同一份 schema 校验请求体（信任边界权威校验在服务端）。`unitSize` 与 `totalAmount` 语义上**二选一**：客户端只发其一；服务端用 `.refine` 拒绝**两者同时出现**（避免歧义）。

> **core 依赖边界（澄清）**：约束是 compute schema **不得直接 import core**。响应 `neighbors` 复用既有 `RankingsItemSchema`（在 `@unit-price/api-client`），其经 `rankings.ts` 间接依赖 core 的 `WarningsSchema`——这是 `rankings.ts`/`categories.ts` 已随榜单/分类树**上线进 weapp 的既有状态**、对 compute **footprint-neutral**（compute 不新增任何 core 表面），故不在本约束内。

**计算管线**（服务端，复用 `packages/core`，**零新增计算逻辑**）：
1. **必须**先以 `meetsComputeRequiredSet` 判输入集是否足够（有 `totalAmount` 或 有 `unitSize`+`quantity`）；不足 → `400 invalid-request` 且**必须**指明缺哪类字段。
2. 把 `ComputeRequest` 映射为 core 的 `ParsedSpec`（`{ unitSize, quantity, totalAmount, multipliers:[1], category, confidence:1 }`，`confidence:1` 因结构化输入无解析不确定性），调 `calculate(spec, totalPrice)` 得 `per100ml` XOR `per100g` + 可回放 `formula`。
3. `calculate` 进 uncomputable 终态（价格非正 / 无可识别单位轴 / 规格不自洽，两轴皆 null）时**禁止**静默返回 `200`——**必须** `400` 并回带 core 的 warning 文案（不得让客户端拿到「成功但全空」的歧义结果）。
4. **必须**先把 `category` 对照既有品类 slug 全集（`/rankings` 同款 `CATEGORY_SLUGS`）校验：非该集合成员 → `400 未知品类`（区别于下面的跨 cohort 文案，避免把拼写错误误诊为「跨多口径」）。再用既有 `resolveComparableUnitStatic(category)` 守卫可比性：解析为 `null`（跨 cohort 节点，如 `beverage`/`alcohol`）→ `400`；解析非 null 但与输入轴不一致（如输入按 `g`、cohort 按 `per_100ml`）→ `400` 且文案**必须**指明该品类的比价单位轴（不追求万物可比，核心原则①）。
   - **本期 per_100g cohort 必须显式 `400`「暂不支持按重量（每100g）比价」**：定位读复用的 `/rankings` 查询是 **per100ml-only** 构造（`isNotNull(per100ml)` + 按 per100ml 排序），无法对 per_100g cohort 给出正确总体。故 cohortAxis 解析为 `per100g` 时**禁止**进入定位（否则会拿 per100ml 榜给 g 值定位、返回貌似成功的垃圾 rank/total），**必须** `400`。per_100g 全量支持是本期非目标（待重量轴 backfill 同时扩 `listRankings`/`RankingsItem` 的 per100g 榜后解禁）。客户端 `toCohorts` **同步只派生 per_100ml cohort**，使 UI 根本不提供 per_100g 选项。
5. 定位：在该 cohort 的 **rankable 行**（复用 `/rankings` 同一 cohort 闭包 + rankable 守卫口径，保证「定位」与「榜单」同一总体）中算 `rank`（该轴单价 `<` 用户值的条数 + 1，∈ `[1, total+1]`）、`total`（cohort rankable 总数，≥ 0）、`percentile`（= **严格贵于**用户值的同类占比 × 100，即「比 X% 同类便宜」，∈ `[0,100]`；**`total=0` 时 `percentile` 必须为 `0`**），并取用户值两侧最近的若干 `neighbors`（默认上下各 3，投影同 `RankingsItem`）。

**响应契约** `ComputeResultSchema`：`{ per100ml:number|null, per100g:number|null, formula:string, axis:'per_100ml'|'per_100g', rank:int, total:int, percentile:number, neighbors:RankingsItem[] }`（恰一个 per100 轴非 null）。响应**必须**带 `Cache-Control: no-store`（每次输入不同、几乎不复用，缓存无意义且会无界填充 CDN）。

#### 场景:足够的结构化输入返回单价与定位

- **当** 客户端 `POST /compute` 提交 `{ totalPrice, unitSize:{value,unit:'ml'}, quantity, category:'soft-drink' }`（输入集足够、轴与 cohort 一致）
- **那么** `200` + `per100ml` 与可回放 `formula`（与 core `calculate` 逐字节一致）、`axis='per_100ml'`、`rank`/`total`/`percentile`、两侧最近 `neighbors`；**禁止**任何 LLM 调用、**禁止**任何 DB 写

#### 场景:输入集不足返回 400 并指明缺字段

- **当** 客户端提交既无 `totalAmount` 又无完整 `unitSize`+`quantity`（如只有 `totalPrice`+`category`）
- **那么** `400 invalid-request`，错误**必须**指明需补「总量」或「单件容量+数量」；**禁止**返回 `per100ml=null` 的 `200`

#### 场景:价格非正或不自洽返回 400（uncomputable 不静默 200）

- **当** 客户端提交 `totalPrice<=0` 或负 / 零容量
- **那么** `400`（由 `ComputeRequestSchema` 的 `.positive()` 在信任边界先行拒绝；message 为校验错误）——仍是 `400`，不静默 `200`
- **当** 输入通过 schema 但致 core 进 uncomputable 终态（如 `unitSize`+`totalAmount` 同时给且规格不自洽）
- **那么** `400` + 回带 core 的 warning 文案（如「规格不一致…」）；**禁止**静默返回 `per100ml=null` 的 `200`

#### 场景:跨轴 / 跨 cohort 不可比返回 400

- **当** 客户端提交按 `g` 的输入但 `category` 是 `per_100ml` cohort（如 `soft-drink`），或 `category` 是跨 cohort 节点（`beverage`/`alcohol`，`resolveComparableUnitStatic` 为 null）
- **那么** `400` 不可比，文案**必须**指明该品类的比价单位轴（或该节点不可直接比价）；定位**禁止**发生
- **当** `category` 不是已知品类 slug（拼写错误 / 未知）
- **那么** `400 未知品类`（区别于跨 cohort 文案）

#### 场景:本期 per_100g cohort 返回 400（不静默给错定位）

- **当** `category` 解析出的可比轴为 `per_100g`（重量轴）
- **那么** `400`「暂不支持按重量（每100g）比价」；**禁止**进入定位（**禁止**用 per100ml 榜给 g 值算出貌似成功的 rank/total/neighbors）。待重量轴 backfill 扩 `listRankings`/`RankingsItem` 的 per100g 榜后解禁

#### 场景:该 cohort 无同类时返回空 neighbors 而非报错

- **当** 客户端提交合法输入但该 cohort 当前无 rankable 行（或用户值在边界、无某侧邻居）
- **那么** `200` + `neighbors` 为空（或仅一侧）、`rank`/`total` 仍按现状给出（`total=0` 时 `rank=1`、**`percentile=0`**）；**禁止** `404`

#### 场景:无状态、no-store、schema 客户端安全

- **当** 任意 `POST /compute` 成功响应
- **那么** **必须**带 `Cache-Control: no-store`、**必须**无任何持久化副作用；`ComputeRequestSchema`/`ComputeResultSchema` 是 Zod 单一事实源且**禁止** import `packages/core`（使其可安全打进 weapp），服务端复用同一份做权威校验
