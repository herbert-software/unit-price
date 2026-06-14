## 修改需求

### 需求:GET /rankings 只读榜单接口

`apps/api` 必须提供 `GET /rankings`，从既有持久化层读取已落库的单价计算结果，按真实单价升序分页返回一张**品类节点作用域**的榜单。基础读取为 `unit_price ⋈ product ⋈ product_raw`；当按品类节点取榜时（含默认 root），**必须**追加 `product_tag`(叶 category 边) JOIN `category_closure`(祖先 = 目标节点) 的闭包命中，并读取 `product.rankable` 派生列作入榜门。该接口**只读**：禁止写入、禁止调用 LLM、禁止触发任何后台任务、禁止任何出站 fetch。

**数据源与计算留痕**：响应中每个榜单项的 `per100ml`、`formula`、`confidence`、`warnings` 必须**直接取自 `unit_price` 已存储的列，禁止在读路径重算**——以保证「计算留痕」公式与落库时一致、不漂移。`packages/core` 不得进入读路径。闭包 / `rankable` 仅作**过滤**，不参与任何重算。

**入榜判据（P3 收敛口径）**：一行入榜当且仅当**三者皆真**：① 它是目标品类节点的闭包成员（`product_tag` 叶 JOIN `category_closure.ancestor_tag_id = 目标节点`）；② `product.rankable = true`（资格门：已分类叶 ∧ 该叶解析出非空 `comparable_unit`）；③ `unit_price.per100ml IS NOT NULL`（数据门）。两道门各司其职、**缺一不可**：`rankable` 回答「该不该上可比轴」、数据门回答「是否真有该数」。**数据门的列由「可排名成员（`rankable=true` 的商品）所在轴」决定，而非由被查询节点自身的 `comparable_unit` 决定**——这关键在于：被查询的节点自身可以无 `comparable_unit`（如 root `beverage` 解析为 `null`），但它仍可有可排名后代；v1 唯一可排名轴是 `per_100ml`（仅软饮叶 `rankable`，故 `rankable=true ⟹ 该商品 comparable_unit=per_100ml`），因此**对任一节点（含 root）数据门一律 = `per100ml IS NOT NULL`**（root 的可排名成员全是 per_100ml 软饮、不存在「root 无单位列可用」问题）。spec **禁止**把 `per100ml IS NOT NULL` 当「永久」门：v2 引入 `per_100g` 可排名轴后，**跨多轴的祖先节点**（如同时含 per_100ml 与 per_100g 后代的 root）将含混轴成员、需按成员各自轴分别取列——该多轴节点处置属 **v2、本期非目标**（v1 单轴 per_100ml 下不会出现混轴，故本期 `per100ml IS NOT NULL` 对所有节点成立且无歧义）。分类为可排名但规格不可算者（rankable=true ∧ per100ml=null）**不入榜**。`rankable=false` 的行（酒类叶 `comparable_unit=null`、待细化、待人工软饮）**一律不入榜**——这同时修正了「按容量轴排序酒类」的语义错误。**此口径取代** P2 的「判据基于 `per100ml IS NOT NULL`、禁止改用品类字段」：P2 品类标签体系当时未建、本期已建并 backfill 就位，故 `rankable` + 闭包成为权威入榜门；判据**禁止**改用 `product.category` 列（恒 `beverage`、无区分力）。

**闭包 JOIN 的去重与单 category 轴保证**：`category_closure` 仅含 category is-a 边、attribute/brand/product_line 无闭包行，故 `category_closure.tag_id = product_tag.tag_id` 的 JOIN **天然只匹配 category 叶边**，无需另按 kind 过滤。由单归属不变量（每商品至多一条 category 叶边）+ `category_closure (tag_id, ancestor_tag_id)` 唯一，对给定目标节点每商品至多命中一行。**但该「至多一行」依赖的是写时（`attachTag`/`reconcileCategory`）应用层强制的单归属不变量、而非 DB 约束**（`product_tag` 唯一键是 `(product_id, tag_id)` 全对、并不阻止同商品同时挂叶 + 其非叶祖先）。故节点榜查询**必须**对 `unit_price.id`、`rankableCount` 查询**必须**对 `product.id` 加 `DISTINCT`/`GROUP BY` 作**防御性兜底**（对齐既有 `listProductIdsInCategoryNode` 用 `selectDistinct` 的同款做法），使任一未来写路径/人工改库/backfill 缺陷导致某商品挂双叶时，榜单**仍至多列该商品一次、计数至多计一次**，**禁止**靠「不变量必成立」的乐观假设裸跑无 `DISTINCT` 的投影。

**排序**：必须按 `per100ml` **升序**（最便宜真实单价 `rank=1`）。相同 `per100ml` 必须以 **`unit_price` 同表确定列 `unit_price.id` 升序**作次级排序键，保证分页稳定、不重叠不遗漏；次级键**必须取 `unit_price` 同表列**——**禁用跨表的 `product.id`**。`unit_price.id` 是 app 生成的 **TEXT** 主键，`ASC` 为**字典序**——对同一数据快照构成**确定全序**，足以保证 tiebreak 确定。

**节点路径的查询计划口径（取代 P2 扁平榜的「主序必走 per100ml 索引」要求；下述形状已对实际 schema EXPLAIN 实测）**：本期 `/rankings` **每次调用都是节点作用域**（默认 root），查询带 `category_closure.ancestor_tag_id = :node` 与 `product.rankable=1` 两个等值过滤。在 D1/SQLite 既有索引下（`category_closure` 唯一键以 `tag_id` 领衔——按 `ancestor_tag_id` 单列过滤**用不上**该前缀；`product.rankable` **无索引**），实测计划为：**驱动表 = `product_tag` 全 `SCAN`（无 `ANALYZE` 统计时，走覆盖索引扫）或 `product` 全 `SCAN`（有 `ANALYZE` 统计时）**；`category_closure` 与 `unit_price` 是**被探（`SEARCH ... USING INDEX`）**——`category_closure` 经其唯一键 `(tag_id, ancestor_tag_id)`、`unit_price` 经 `unit_price_product_id_unique`；`ORDER BY` 与 `DISTINCT` 各用一次 `USE TEMP B-TREE`。**注意**：`unit_price` 在此 join 形状下**只能**经其 `product_id` 唯一键到达、规划器**结构上不会**对它 `SCAN`，故「不出现 `SCAN unit_price`」是近乎恒真、**非**有效护栏。在 v1 规模（~445 product、闭包 ~35 行、~13 节点）该计划**可接受**（sub-ms）。因此：
- 节点路径**允许** `USE TEMP B-TREE FOR ORDER BY` 与 `FOR DISTINCT`（明确放行；主序不再要求走 per100ml 索引——节点路径本就不由 `unit_price` 驱动）；
- 驱动表是 `product_tag`/`product` 的**全扫**属本期**有意接受**（小表）、**非**硬失败；
- **有效硬失败线 = `category_closure` 或 `unit_price` 退化为 `SCAN`（即被探表丢失索引路径）**——EXPLAIN 计划测试**必须**断言这两张表均为 `SEARCH ... USING INDEX`（`category_closure_tag_id_ancestor_tag_id_unique` / `unit_price_product_id_unique`），而**非**断言「从 closure/product_tag 驱动」（该断言随 `ANALYZE` 与否在 `SCAN pt` ↔ `SCAN p` 间漂移、不稳定）或「不出现 `SCAN unit_price`」（近乎恒真、无效）；
- 测试**必须钉死 `ANALYZE` 状态**（与既有 P2 测试一致先 `ANALYZE`，并对有统计下的 `SCAN product` 驱动写断言），否则会在本地（无统计）与已 `ANALYZE` 环境间 flaky；
- 「可接受」**限于当前数据量、非永久契约**——目录显著增长时须重评；届时真正的成本杠杆是**驱动表全扫（`product`/`product_tag`）**、可考虑对 `product.rankable` 或 `product_tag.tag_id` 加索引，**而非** `category_closure(ancestor_tag_id, tag_id)`：实测加该索引规划器**会**用它做 closure 探查（非「被忽略」），但**不改驱动表、无实质收益**，且会令本 EXPLAIN 测试「`category_closure` 经 `category_closure_tag_id_ancestor_tag_id_unique` 探」的命名索引断言**失败**——故 v1 **不加**（不加也是保持该断言绿的前提）；本期均**非必需**。

**响应 schema（Zod 单一事实源）**：响应体必须由 `RankingsResponseSchema`（Zod，types 从中推导）定义，**本变更不改该 schema**。该 schema 居 `packages/api-client`（`@unit-price/api-client`），`apps/api` 与客户端共依赖同一份。每个榜单项必须包含：
- `rank`：整数，从 `1` 起，等于 `offset + 该项在结果中的序号`（1-based），**不落库、读时投影赋值**；
- `title`：来自 `product_raw.title`；
- `priceCents`：整数分（来自 `product_raw.price`，原样为分），**禁止**在服务端转元/做浮点货币换算；
- `per100ml`：number（`unit_price.per100ml` 存储值）；
- `formula`：string（`unit_price.formula` 存储值，计算留痕、可回放），**原样透出**；**非空安全**：入榜行 `per100ml IS NOT NULL`，由 `CalcResultGate` 不变量推出 formula 必非空，故为 `string`（非 nullable）；
- `confidence`：number（`unit_price.confidence` 存储值，即最终权威置信 band，**非** `product.confidence` 解析中间值）；
- `warnings`：`string[]`（`unit_price.warnings` 存储值，**原样透出**）；该列以 JSON-text 存储，读端**必须**用 codec 的 `decodeJson` 还原、并经 `WarningsSchema` 校验确得 `string[]` 后再进响应（**禁止**透出原始 JSON 串）；
- `store`、`storeSku`、`sourceUrl`：取自 `product_raw`（`sourceUrl` 可为 `null`）。

**`priceCents` 与 `per100ml` 口径不同、不可互推**：`priceCents` 是整件总价（分），`per100ml` 是按**总容量**摊算的可比单价（分母是总 ml）。二者分母不同，前端**禁止**用 `priceCents/100` 反推或校验 `per100ml`；展示可比单价**一律用 `per100ml`**，`priceCents` 仅作整件标价展示。

**价格口径与潜在漂移（已知约定）**：`priceCents` 取自 `product_raw.price`（最近一次观察价，upsert 刷新）；`per100ml`/`formula` 取自 `unit_price`（首次落库时按当时价算、first-write-wins、调价不刷新派生行）。故商品调价后 `priceCents`（最新）与 `per100ml`（旧价算）**可能漂移**，本期**接受**此降级：榜单权威可比量是 `per100ml`，`priceCents` 为参考标价。`confidence` 本期为 tier1 落库存储值（生产现状恒约 0.95、无区分力），可信度区分**当前来自 `warnings`**。

**warnings 原样透出、可疑项不静默剔除**：带 `warnings`（尤其「数量按单件推断为 1」）的项必须照常入榜并把 warning 带进响应，**禁止**因含单件推断或高单价而静默过滤。

#### 场景:无参默认 ≡ category=beverage ≡ taxonomy root 节点闭包榜（含收敛后的破坏性收紧）

- **当** 客户端 `GET /rankings`（不带参数）
- **那么** 它**必须**严格等价于 `category=beverage`，且 `beverage` **解析为 taxonomy `tag.slug='beverage'` 的 root 节点**（经 `category_closure` 闭包过滤），**禁止**改读 `product.category` 列（恒 `beverage`、与 taxonomy tag 空间无关）
- **那么** 接口必须返回 `200`、一个按 `per100ml` 升序的数组，首项 `rank=1` 为最低 per100ml 项；每项含 `title / priceCents / per100ml / formula / confidence / warnings / store / storeSku / sourceUrl`，且 `per100ml`、`formula`、`confidence`、`warnings` 与 `unit_price` 存储值逐一相等（未重算）
- **那么（收敛后破坏性收紧，须可断言）** 该默认榜是 P2 旧扁平榜（仅 `per100ml IS NOT NULL`）的**真子集**：一条 P2 旧默认榜里出现过的、`per100ml` 非空但 `rankable=false` 的行（如有 per100ml 的葡萄酒、或待人工软饮）**禁止**再出现在新默认榜中

#### 场景:rankable=false 的项不入榜（酒类 / 待人工软饮）

- **当** 库中存在 `product.rankable = false` 的行（酒类叶 `comparable_unit=null`，或待细化 / 待人工软饮）——其中酒类可能仍有非空 `per100ml`
- **那么** 这些行**禁止**出现在 `/rankings` 任一品类节点榜中（包括默认 root）；按容量轴排序酒类的语义错误经 `rankable` 门被消除

#### 场景:无叶（待人工/待细化）软饮即便 per100ml 非空也不入任何节点榜

- **当** 某软饮 `per100ml` 非空但处「待人工」（无叶 `product_tag` ∧ `pending_category_tag_id` 为空）或「待细化」（无叶 ∧ `pending` 非空）态——它经 backfill 仍未拿到 kind=category 叶
- **那么** 该行**禁止**出现在**任一**节点榜（含默认 root）：它**无 category 叶**故不是任何节点的闭包成员（连 root 闭包都不命中——此为「无叶 → 非成员」机制，独立于 `rankable` 门与 `per100ml` 数据门）；这正是默认榜相对 P2 旧扁平榜「真子集」收紧的非酒类来源

#### 场景:per100ml 为 null 的项不入榜

- **当** 库中存在 `per100ml = null` 的行（如 rankable=true 软饮但规格不可算）
- **那么** 这些行**禁止**出现在响应中（数据门 `per100ml IS NOT NULL` 兜住）；响应仅含 `per100ml` 非空且 `rankable=true` 的闭包成员

#### 场景:单件推断项带 warning 入榜而非被剔除

- **当** 某入榜项的 `unit_price.warnings` 含「数量按单件推断为 1」
- **那么** 该项必须照常出现在榜单中，其 `warnings` 数组必须原样包含该提示，**禁止**因含单件推断而将其从榜单剔除或清空其 warnings

#### 场景:formula/per100ml 取存储值不重算

- **当** 某项落库时 `unit_price.formula = "40 / (330 * 24 * 1) * 100"`、`per100ml ≈ 0.505`
- **那么** 响应中该项的 `per100ml` 必须等于存储的 `0.505`、`formula` 必须等于存储的 `"40 / (330 * 24 * 1) * 100"`，**禁止**由服务端用 `priceCents` 重新计算覆盖存储值

#### 场景:违反单归属（同商品双叶）时仍至多列一次（DISTINCT 兜底）

- **当** 某商品因数据漂移/缺陷违反单归属、同时挂有两条 `kind=category` 叶 `product_tag` 边（且其闭包都命中目标节点）
- **那么** 该商品在节点榜中**必须**至多出现一次（由 `DISTINCT unit_price.id` 兜底）、`rank` 不重复，**禁止**因双叶导致跨闭包重复列出同一商品两次

### 需求:分页与查询参数边界

`GET /rankings` 必须支持 `limit` / `offset` 分页与 `category` 品类节点过滤，并对非法参数返回**确定**的 HTTP 状态：

- `limit`：缺省为 `50`（键缺失时）；present 时**仅接受十进制非负整数串**（正则 `^\d+$`），其中 `> 200` 必须 **clamp 到 200**（不报错）、`= 0` 或不匹配该正则者（空串、十六进制如 `0x10`、含前后空白、负号、小数点、`NaN`/`Infinity` 等）一律返回 `400` + error code `invalid-request`。**禁止**用宽松强转把非规范输入悄悄接受。
- `offset`：缺省为 `0`（键缺失时）；present 时**仅接受十进制非负整数串**（正则 `^\d+$`），不匹配者一律返回 `400` + `invalid-request`——**与 `limit` 同口径、对称**；`offset` 超出结果总数时返回 `200` + 空数组（**不是** `404`）。
- `category`（P3 升级）：缺省为 `beverage`（饮料 root 节点）；present 时**必须**精确匹配一个 **seed 的 kind=category 节点 slug**（大小写敏感，ASCII slug 如 `beverage` / `soft-drink` / `carbonated` / `drinking-water` / `alcohol` 等）。其值驱动闭包过滤（`category_closure.ancestor_tag_id = 该节点`）。
  - **校验集单一来源、且必须编译期派生（取代部署中的 `z.enum(['beverage'])`）**：本期**必须**移除现 `RankingsQuerySchema` 里的 `category: z.enum(['beverage'])`，改为校验「**seed 品类树的 kind=category slug 全集**」。该全集**必须**单一来源、**编译期**派生自 `packages/db` 的 `CATEGORY_NODES`（seed 真理源），做纯同步 parse；**禁止**在 `apps/api` 再手写一份 slug 枚举（会与 seed 漂移，违反「schema 单一事实源/禁手写重复」）。**禁止改用运行期查 `tag` 表来校验 slug 合法性**——运行期查表对「合法但未 seed 的 slug」与「拼写错误 slug」都查无行、**无法区分二者**，会违反下条「拼写错误 vs 未 seed 必须可区分」要求；编译期 `CATEGORY_NODES` 集是唯一能同时满足「单一来源」与「可区分」的方案，且保持参数校验为纯函数、不引入校验期 DB 往返与新 500 分支。
  - **未知 slug、空串、或非 category 的 slug**（attribute/brand/product_line slug，如 `sugar-free`）一律返回 `400` + `invalid-request`（确定拼写防护）。
  - **已知但不可排名的节点**（如酒类子树，其闭包下成员 `rankable=false`）**不报错**：经 `rankable` 门**自然返回 `200` + 空数组**。
  - **「拼写错误」与「合法 slug 但 DB 缺该 tag 行（未 seed 窗口）」必须可区分**：一个**属于 seed 全集**的 slug 即便当前 DB 尚无对应 `tag`/`category_closure` 行（迁移先于 seed 的窗口期），**必须**返回 `200` + 空数组（闭包零命中），**禁止**误判为未知 slug 报 `400`；仅**不属于** seed 全集的 slug 才 `400`。
  - **此口径取代** P2 的「`category` 仅接受 `beverage`、为占位 no-op、不承担入榜判别」。

`invalid-request`（400）必须与既有码（`auth-*`/`rate-limited`/`config-error`/`persistence-error`/`internal` 等）一致复用、语义不冲突，**不新增错误码**；`/rankings` 节点查询的 DB 失败**必须**沿用既有 `persistence-error`（500）。

#### 场景:按品类节点过滤命中闭包成员

- **当** 客户端 `GET /rankings?category=carbonated`（碳酸饮料叶）且库中有归属碳酸叶的 rankable 软饮
- **那么** 接口必须返回 `200`，结果**仅含**碳酸节点闭包下 `rankable=true ∧ per100ml` 非空的成员，按 per100ml 升序；归属其它软饮叶（如 `drinking-water`）的商品**禁止**出现

#### 场景:父节点闭包含子叶成员

- **当** 客户端 `GET /rankings?category=soft-drink`（软饮父节点），库中有归属 `carbonated` / `drinking-water` 等子叶的商品
- **那么** 经 `category_closure` 闭包，响应**必须**含全部这些子叶的 rankable 成员（闭包到该节点）；按 per100ml 升序混排

#### 场景:不可排名节点返回空数组而非报错

- **当** 客户端 `GET /rankings?category=alcohol`（酒类，子树 `rankable=false`）
- **那么** 接口必须返回 `200` + 空数组 `[]`（资格门自然产出空榜），**禁止**返回 `400` 或 `404`

#### 场景:未知 / 非 category / 大小写不符 / 空串 category 返回 400

- **当** 客户端 `GET /rankings?category=nope`（不存在）、或 `?category=sugar-free`（attribute 非 category）、或 `?category=Beverage`（大小写不符）、或 `?category=`（空串）
- **那么** 接口必须返回 `400` + error code `invalid-request`（仅精确匹配 seed 的 kind=category 节点 slug 或缺省才放行）

#### 场景:合法 slug 但 DB 尚未 seed 该 tag 行时返回空数组而非 400

- **当** 客户端 `GET /rankings?category=carbonated`（属 seed 全集的合法 slug），但当前 DB 因迁移先于 seed 的窗口期尚无对应 `tag`/`category_closure` 行
- **那么** 接口必须返回 `200` + 空数组 `[]`（闭包零命中），**禁止**因 DB 缺该行而误报 `400`（合法 slug 与拼写错误必须可区分）

#### 场景:limit 超上限时 clamp

- **当** 客户端 `GET /rankings?limit=1000`
- **那么** 接口必须返回 `200`，最多返回 `200` 条（按 200 截断），**禁止**返回超过 200 条

#### 场景:非法/非规范 limit/offset 返回 400

- **当** 客户端 `GET /rankings?limit=-5`、`?limit=0`（零）、`?offset=abc`、`?limit=`（空串）、`?offset=`（空串）、`?limit=0x10`、`?limit=%20%205`（含 URL 编码空白）、`?offset=1.5` 等非十进制正整数/非负整数串（`limit` 须正整数、`offset` 须非负整数，均严格 `^\d+$` 且 `limit=0` 亦拒）
- **那么** 接口必须返回 `400` + error code `invalid-request`，**禁止**返回 `200` 或静默用缺省值/宽松强转结果

#### 场景:offset 越界返回空数组

- **当** 客户端 `GET /rankings?offset=100000`（超过入榜项总数）
- **那么** 接口必须返回 `200` + 空数组 `[]`，**禁止**返回 `404`

#### 场景:空库返回空数组

- **当** 库中没有任何 `rankable=true ∧ per100ml` 非空的入榜项
- **那么** 接口必须返回 `200` + 空数组 `[]`，**禁止**返回错误

#### 场景:相同 per100ml 分页稳定（同一数据快照内）

- **当** 多个项 `per100ml` 相同，**且两次请求间底层数据不变**，客户端分两页（`limit=N&offset=0` 与 `limit=N&offset=N`）取同一品类节点榜
- **那么** 两页必须按确定的次级排序键 `unit_price.id` 升序拼接、不重叠不遗漏地覆盖这些同值项，**禁止**因排序非确定导致跨页重复或丢项
- **并发写降级说明**：本期为 `limit/offset` 分页，跨页期间若有写入可能造成翻页轻微漂移（offset 分页固有）。本期**接受**此降级；游标分页留作未来、不在本期。
