## 新增需求

### 需求:GET /categories 只读品类树浏览接口

`apps/api` **必须**提供 `GET /categories`，从既有持久化层（`tag` / `category_closure` / `product_tag` / `product` / `unit_price`）读取并返回 **store-agnostic 的 category is-a 树**，供小程序「分类树」Tab 渲染导航。该接口**只读**：禁止写入、禁止调用 LLM、禁止触发任何后台任务、禁止任何出站 fetch；治理豁免（同 `/rankings` 家族）。DB 不可达时**必须**复用既有 `persistence-error`（500）码，**禁止**新增错误码。

**只透 category 轴**：响应**仅**含 `kind=category` 的 is-a 节点，**禁止**透出 `attribute` / `brand` / `product_line` 轴（它们无 is-a 闭包、不参与品类导航）。

**响应 schema（Zod 单一事实源）**：响应体**必须**由新增的 `CategoryTreeResponseSchema`（Zod，types 从中推导）定义，居 `packages/api-client`（`@unit-price/api-client`），`apps/api` 与客户端（小程序等）**共依赖同一份**；**禁止**在 `routes.ts` 手写重复类型。每个节点**必须**包含：
- `slug`：节点稳定标识（ASCII，如 `beverage` / `soft-drink` / `carbonated`）；
- `name`：中文展示名（`tag.name`，如 `饮料` / `软饮` / `碳酸饮料`）；
- `parentSlug`：父节点 slug，root 为 `null`；
- `comparableUnit`：经 **is-a 继承解析**后的可比单位——取节点自身 `comparable_unit`，为空则沿 `parent_id` 向上找最近非空祖先，一路到 root 仍空则 `null`（软饮全线解析得 `per_100ml`，酒类 / root 得 `null`）；**禁止**直接透出未经继承的裸列值。**实现注**：**必须**一次性加载全部 kind=category 节点（单查询）后在**内存**沿 parent map 解析继承，**禁止**逐节点调用按 `parent_id` 串行往返的 `resolveComparableUnit`（树虽小，逐节点 walk 在 D1 上是 O(节点×深度) 次串行往返）。
- `rankable`：布尔，**节点自身是否承载可比单位**（= `comparableUnit !== null`）——表示「该节点本身是否一个排序轴」。soft-drink 全线（含 `soft-drink` 父节点，直接绑 `per_100ml`）为 `true`；root `beverage` 与酒类子树（`comparable_unit=null`）为 `false`。**此标记与「该节点闭包下有无可排名成员」正交、不可互推**（见下）；
- `rankableCount`：整数，该节点**闭包下可排名成员数**，口径与 `GET /rankings?category=<该节点>` 入榜判据**逐字一致**（`product_tag` 叶 JOIN `category_closure.ancestor_tag_id = 该节点` ∧ `product.rankable=true` ∧ `unit_price.per100ml IS NOT NULL`；数据门列由可排名成员轴定、v1 对所有节点一律 per100ml，口径同 `rankings-api` 入榜判据③）。**`rankableCount` 计闭包后代、与节点自身 `rankable` 标记无关**：root `beverage` 虽 `rankable=false`（自身无 `comparable_unit`），其闭包含全部可排名软饮，故 `rankableCount > 0`（**恰等于默认 `/rankings`（无参=root）榜的基数**）；**唯有**闭包下无任何可排名成员的节点（如酒类子树，成员全 `rankable=false`）才 `rankableCount = 0`。**禁止**把「节点 `rankable=false`」推成「`rankableCount=0`」。

**消费方契约——「该节点是否可点进榜」由 `rankableCount > 0` 判定、不用 `rankable`**：客户端（小程序分类树 Tab）判定一个节点**是否展示榜入口 / 可点进**，**必须**用 `rankableCount > 0`，**禁止**用 `rankable`——否则 root `beverage`（`rankable=false` 但 `rankableCount > 0`、且是默认榜）会被误隐藏。`rankable` **仅**供「节点自身有无可比轴」的展示态（如轴标灰显），**不**决定榜入口有无。（miniapp 接通本身是非目标，但此消费契约在本 API 层钉死，防止下游误用把 MAJOR 类回归带到上层。）

**计数与节点榜共用同一过滤源（防漂移）+ 基于 unit_price 1:1 前提**：`rankableCount` 的过滤谓词（闭包成员 ∧ `rankable=true` ∧ `per100ml` 非空）**必须**与 `GET /rankings` 节点榜查询取自**同一份可复用 builder 片段**（对齐既有 `buildRankingsQuery` 单一来源约定），`rankableCount` = 在该片段上做 `COUNT(DISTINCT product.id)`、节点榜 = 在该片段上 `SELECT DISTINCT unit_price.id ... ORDER BY ... LIMIT`；**禁止**两处各自手写谓词导致日后漂移。**`COUNT(DISTINCT product.id)` 与节点榜（去重于 `unit_price.id`）基数相等，依赖既有不变量 `unit_price` 与 `product` 1:1（`unit_price_product_id_unique`）**——此前提是「逐字一致」的唯一承重条件，**必须**显式成立；若未来放松 `unit_price` 为对 `product` 多行，两计数将分歧，须改为两侧都 `COUNT(DISTINCT product.id)` 口径。

**计数口径一致性**：`rankableCount` **必须**与 `GET /rankings?category=<slug>` 的入榜全集基数相等（同一数据快照），即「树里说有 N 个」与「点进去榜里有 N 个」**禁止**不一致——对**所有**节点成立，含 root（= 默认榜基数）。

**未 seed / 部分缺失的退化态**：DB 已连但 taxonomy 尚未 seed（`tag` 无 category 行）时，接口**必须**返回 `200 { nodes: [] }`（自然空树），**禁止**报错——避免「prod 迁移先于 seed」窗口产混淆错误。（生产经 `wrangler d1 migrations apply` 自动 migrate+seed，此态仅为窗口期保护。）

#### 场景:返回完整 category is-a 树、不含其它标签轴

- **当** 客户端 `GET /categories`
- **那么** 接口**必须**返回 `200` + 全部 `kind=category` 节点（root 饮料 + 软饮 + 软饮叶 + 酒类子树），每节点含 `slug / name / parentSlug / comparableUnit / rankable / rankableCount`；响应**禁止**含任何 `attribute` / `brand` / `product_line` 轴的标签

#### 场景:comparableUnit 经继承解析、节点 rankable 随之派生（含 soft-drink 父节点）

- **当** 检查响应中的 `soft-drink` 父节点（直接绑 `per_100ml`）、软饮叶（如 `carbonated`，经继承）、酒类**父节点** `alcohol`、酒类**叶节点**（如 `wine` / `baijiu`，经继承到 null 父）与 root（`beverage`）
- **那么** `soft-drink` 父节点与软饮全线叶 `comparableUnit` **必须**为 `per_100ml`、节点 `rankable=true`；酒类**父节点 `alcohol` 与酒类各叶（`wine`/`baijiu`/…，继承自 null 父）** 及 root 的 `comparableUnit` **必须**为 `null`、节点 `rankable=false`（酒类叶走「叶自身 null → 沿 parent 继承仍 null」路径，与软饮叶的「继承得 per_100ml」路径不同，须各自覆盖）

#### 场景:rankableCount 计闭包后代、与节点 rankable 正交（root 非零、酒类为零）

- **当** 检查 root `beverage`（`rankable=false`）、`soft-drink` 父节点、与酒类节点 `alcohol`（`rankable=false`）的 `rankableCount`
- **那么** root `beverage` 的 `rankableCount` **必须** `> 0` 且**恰等于**默认 `/rankings`（无参）榜基数（其闭包含全部可排名软饮）；`soft-drink` 父节点 `rankableCount` **必须**等于其下各软饮叶可排名成员之并集计数；酒类 `alcohol` 的 `rankableCount` **必须**为 `0`；**禁止**因 root/酒类 `rankable=false` 就把 `rankableCount` 记 `0`（root 不可为 0）

#### 场景:rankableCount 与节点榜基数一致（所有节点含 root）

- **当** 某节点 `GET /categories` 报 `rankableCount = N`，随后客户端 `GET /rankings?category=<该节点 slug>` 拉全（同一数据快照）
- **那么** 该节点榜的入榜项总数**必须**等于 `N`（对 root / 父节点 / 叶 / 酒类一律成立）；酒类节点 `rankableCount=0` 且其节点榜**必须**返回空数组

#### 场景:某节点闭包下无可排名成员时计数为 0、不报错

- **当** 库中某 category 节点闭包下无 `rankable=true ∧ per100ml` 非空的成员
- **那么** 该节点**必须**照常出现在树中、`rankableCount=0`，**禁止**因计数为 0 而省略该节点或返回错误

#### 场景:taxonomy 未 seed 时返回空树而非报错

- **当** DB 已连但 `tag` 表无任何 kind=category 行（迁移先于 seed 的窗口期）
- **那么** `GET /categories` **必须**返回 `200 { nodes: [] }`，**禁止**返回错误
