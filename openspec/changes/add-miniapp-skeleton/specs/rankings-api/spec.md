## 修改需求

### 需求:GET /rankings 只读榜单接口

`apps/api` 必须提供 `GET /rankings`，从既有持久化层（`unit_price ⋈ product ⋈ product_raw`）读取已落库的单价计算结果，按真实单价升序分页返回一张榜单。该接口**只读**：禁止写入、禁止调用 LLM、禁止触发任何后台任务。

**数据源与计算留痕**：响应中每个榜单项的 `per100ml`、`formula`、`confidence`、`warnings` 必须**直接取自 `unit_price` 已存储的列，禁止在读路径重算**——以保证「计算留痕」公式与落库时一致、不漂移。`packages/core` 不得进入读路径。

**入榜判据（v1 单轴）**：本期榜单只支持容量轴 per100ml。当且仅当一行的 `per100ml` 非 `null` 时入榜（等价于 `WHERE per100ml IS NOT NULL`）；`per100ml` 为 `null` 的行（含仅有 `per100g` 的重量品、不可计算项）**一律不入榜**。判据必须基于 `per100ml IS NOT NULL`，禁止改用 `category` 字段判定（避免与未建立的品类标签体系耦合）。

**排序**：必须按 `per100ml` **升序**（最便宜真实单价 `rank=1`）。相同 `per100ml` 必须以 **`unit_price` 同表确定列 `unit_price.id` 升序**作次级排序键，保证分页稳定、不重叠不遗漏；次级键**必须取 `unit_price` 同表列**——**禁用跨表的 `product.id`**：它与 `per100ml` 不在同一张表，无法被 `per100ml` 索引覆盖、会迫使临时排序、削弱稳定保证。主排序**必须能走 `per100ml` 列上的数值索引**（schema 既有 `unit_price_per100ml_idx`，REAL 数值序非字典序）满足 `per100ml` 序与 `per100ml IS NOT NULL` 过滤，**禁止全表扫描后把全量行取入应用内存排序**；同值段内按 `unit_price.id` 定序即确定 tiebreak。`unit_price.id` 是 app 生成的 **TEXT** 主键，`ASC` 为**字典序**——对同一数据快照构成**确定全序**（任意两 id 字符串可比、无并列），足以保证 tiebreak 确定，不依赖 id 数值单调。注：本期单列 `per100ml` 索引无法同时覆盖二级键 `unit_price.id`，引擎可能对该二级序做一次轻量临时排序——这是**可接受**的（数据量小、且仍由索引承担主序与过滤，非全表内存排序）；若未来同值段巨大需完全索引覆盖，可由 persistence 增 `(per100ml, id)` 复合索引，非本期必需。

**响应 schema（Zod 单一事实源）**：响应体必须由 `RankingsResponseSchema`（Zod，types 从中推导）定义。该 schema **现居 `packages/api-client`（`@unit-price/api-client`）**，`apps/api` 与客户端（小程序等）**共依赖同一份**；`apps/api` 从该包 import（不再在 `routes.ts` 自持定义）。每个榜单项必须包含：
- `rank`：整数，从 `1` 起，等于 `offset + 该项在结果中的序号`（1-based），**不落库、读时投影赋值**；
- `title`：来自 `product_raw.title`；
- `priceCents`：整数分（来自 `product_raw.price`，原样为分），**禁止**在服务端转元/做浮点货币换算（换算交前端展示）；
- `per100ml`：number（`unit_price.per100ml` 存储值）；
- `formula`：string（`unit_price.formula` 存储值，计算留痕、可回放），**原样透出**——使「每个单价结论带可回放公式」对消费方可见；**非空安全**：入榜行 `per100ml IS NOT NULL`，由 persistence 的 `CalcResultGate` 不变量「`formula` 非空 ⟺ `per100ml`/`per100g` 之一非空」推出 formula 必非空，故为 `string`（非 nullable）；
- `confidence`：number（`unit_price.confidence` 存储值，即**最终权威置信 band**，**非** `product.confidence` 解析中间值）；
- `warnings`：`string[]`（`unit_price.warnings` 存储值，**原样透出**）；该列以 JSON-text 存储，读端**必须**用 codec 的 `decodeJson`（`encodeJson` 的对称解码，`packages/db` 既有）还原、并经 `WarningsSchema` 校验确得 `string[]` 后再进响应（**禁止**透出原始 JSON 串；`decodeJson` 返回 `unknown`，故 `string[]` 的类型保证由该 `WarningsSchema` 校验闭合，而非裸 `decodeJson`）；
- `store`、`storeSku`、`sourceUrl`：取自 `product_raw`（`sourceUrl` 可为 `null`）。

**`priceCents` 与 `per100ml` 口径不同、不可互推**：`priceCents` 是整件总价（分），`per100ml` 是按**总容量**摊算的可比单价（分母是总 ml、非整件）。二者分母不同，前端**禁止**用 `priceCents/100` 反推或校验 `per100ml`；展示可比单价**一律用 `per100ml`**，`priceCents` 仅作整件标价展示。

**价格口径与潜在漂移（v1 已知约定）**：`priceCents` 取自 `product_raw.price`（**最近一次观察价**，同 SKU 再上报会 upsert 刷新）；而 `per100ml`/`formula` 取自 `unit_price`，是**首次落库时按当时价**算的（`saveParsed` 对既有 `(rawId+spec)` 为 first-write-wins、调价不刷新派生行）。故商品调价后，`priceCents`（最新）与 `per100ml`（旧价算）**可能漂移**。v1 **接受**此降级：榜单权威可比量是 `per100ml`，`priceCents` 为参考标价；派生行刷新属未来 backfill 迁移、非本期。`confidence` 本期为 tier1 落库存储值（生产现状恒约 0.95、无区分力），可信度区分**当前来自 `warnings` 而非 `confidence`**。

**warnings 原样透出、可疑项不静默剔除**：带 `warnings`（尤其「数量按单件推断为 1」）的项必须照常入榜并把 warning 带进响应，**禁止**因含单件推断或高单价而静默过滤——单件推断可能高估 per100ml，但榜单选择「带 warning 透出、由前端标注可信度」而非隐藏，符合「每个结论都能解释」。

#### 场景:返回按 per100ml 升序的饮料榜单

- **当** 客户端 `GET /rankings`（不带参数）且库中有多条 `per100ml` 非空的饮料
- **那么** 接口必须返回 `200`、一个按 `per100ml` 升序的数组，首项 `rank=1` 为最低 per100ml 项；每项含 `title / priceCents / per100ml / formula / confidence / warnings / store / storeSku / sourceUrl`，且 `per100ml`、`formula`、`confidence`、`warnings` 与 `unit_price` 存储值逐一相等（未重算）

#### 场景:per100ml 为 null 的项不入榜

- **当** 库中存在 `per100ml = null` 的行（如重量品仅有 `per100g`，或酒类单瓶不可计算）
- **那么** 这些行**禁止**出现在 `/rankings` 响应中，响应仅含 `per100ml` 非空的项

#### 场景:单件推断项带 warning 入榜而非被剔除

- **当** 某入榜项的 `unit_price.warnings` 含「数量按单件推断为 1」
- **那么** 该项必须照常出现在榜单中，其 `warnings` 数组必须原样包含该提示，**禁止**因含单件推断而将其从榜单剔除或清空其 warnings

#### 场景:formula/per100ml 取存储值不重算

- **当** 某项落库时 `unit_price.formula = "40 / (330 * 24 * 1) * 100"`、`per100ml ≈ 0.505`
- **那么** 响应中该项的 `per100ml` 必须等于存储的 `0.505`、`formula` 必须等于存储的 `"40 / (330 * 24 * 1) * 100"`（均为同一数值/同一串），**禁止**由服务端用 `priceCents` 重新计算覆盖存储值
