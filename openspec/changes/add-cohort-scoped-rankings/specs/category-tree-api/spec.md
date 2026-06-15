## 修改需求

### 需求:GET /categories 只读品类树浏览接口

`apps/api` **必须**提供 `GET /categories`，从既有持久化层（`tag` / `category_closure` / `product_tag` / `product` / `unit_price`）读取并返回 **store-agnostic 的 category is-a 树**，供小程序「分类树」Tab 渲染导航。该接口**只读**：禁止写入、禁止调用 LLM、禁止触发任何后台任务、禁止任何出站 fetch；治理豁免（同 `/rankings` 家族）。DB 不可达时**必须**复用既有 `persistence-error`（500）码，**禁止**新增错误码。

**只透 category 轴**：响应**仅**含 `kind=category` 的 is-a 节点，**禁止**透出 `attribute` / `brand` / `product_line` 轴。

**响应 schema（Zod 单一事实源）**：响应体**必须**由 `CategoryTreeResponseSchema`（Zod，居 `@unit-price/api-client`、与客户端共依赖、types 推导）定义，**本变更不改其字段集**（仅 `rankable` 语义收敛、见下）。每个节点**必须**包含：
- `slug`：节点稳定标识（ASCII）；
- `name`：中文展示名（`tag.name`）；
- `parentSlug`：父节点 slug，root 为 `null`；
- `comparableUnit`：经 **is-a 继承解析**后的可比单位（取自身，空则沿 `parent_id` 向上取最近非空祖先，到 root 仍空则 `null`）。**P3.5 起**：软饮全线、**乳品全线**、**各酒种叶**（啤酒/葡萄酒/白酒/洋酒/威士忌/清酒果酒）解析得 `per_100ml`；root `饮料` 与 `酒类` **父**节点解析得 `null`。**禁止**透出未经继承的裸列值。**实现注**：**必须**一次性加载全部 kind=category 节点（单查询）后在**内存**沿 parent map 解析继承，**禁止**逐节点串行 `resolveComparableUnit`。
- `rankable`：布尔，`comparableUnit !== null`。**P3.5 语义收敛**：因 `rankings-api` 的 cohort 守卫规定「榜只对解析单位非空的单一 cohort 节点开放」，`rankable` 现**恰等于「该节点是单一可比 cohort、可点进榜」**——软饮/软饮叶/乳品/乳品叶/各酒种叶 = `true`（各有自己的 per100ml cohort 榜）；root `饮料` 与 `酒类` 父节点 = `false`（跨多 cohort、不可点进、对应 `/rankings` 守卫 `400`）。**注（解析来源差异,post-seed 收敛）**：本字段 `rankable` 由 **DB 已 seed 的 `comparable_unit` 列**经内存继承解析得出，而 `/rankings` cohort 守卫用**编译期 `CATEGORY_NODES` 静态解析**（见 rankings-api）；二者在 seed 落地后必然相等（迁移使 DB 列 = `CATEGORY_NODES`）。未 seed 窗口 `/categories` 返回空树（无节点可点）、`/rankings` 静态守卫仍正确 `400`/`200 []`,无矛盾。
- `rankableCount`：整数，该节点**闭包下可排名成员数**（`product_tag` 叶 JOIN `category_closure.ancestor_tag_id = 该节点` ∧ `product.rankable=true` ∧ `per100ml` 非空）。对 `rankable=true`（可点进）节点，`rankableCount` = 其 `/rankings?category=该节点` 的 cohort 榜基数。对 `rankable=false`（root/酒类父，不可点进、无对应榜）节点，`rankableCount` 为**该分支下可排名后代的信息性计数**（无对应单一榜，仅供导航展示「该分支共 N 个可比商品」），**不**对应任何 `/rankings` 榜。

**消费方契约——「该节点是否可点进榜」由 `node.rankable` 判定（P3.5 取代 P3 的 `rankableCount>0`）**：客户端（小程序分类树 Tab）判定一个节点**是否展示榜入口 / 可点进**，**必须**用 `node.rankable`（= 单一 cohort、`/rankings` 守卫放行）。**禁止**用 `rankableCount>0` 判可点进——因为 `酒类` 父节点 `rankableCount>0`（其下有可排名酒类叶）但 `rankable=false`、**不可点进**（`/rankings?category=alcohol` 被 cohort 守卫 `400`），用 `rankableCount>0` 会误判它可点。`rankableCount` 仅用于：可点进节点上展示榜规模 / 隐藏空 cohort（`rankable=true ∧ rankableCount=0`），及非可点进父节点的分支信息计数。（P3 当时因「默认榜=root、root rankable=false 却可点」才要求用 `rankableCount>0`；P3.5 默认榜改软饮 + cohort 守卫后，`rankable` 恰好 = 可点进，契约简化回 `rankable`。）

**计数与节点榜共用同一过滤源 + unit_price 1:1 前提**：`rankableCount` 过滤谓词（闭包成员 ∧ `rankable=true` ∧ `per100ml` 非空）**必须**与 `GET /rankings` 节点榜查询取自**同一份可复用 builder 片段**，`rankableCount` = `COUNT(DISTINCT product.id)`、节点榜 = `SELECT DISTINCT unit_price.id ... ORDER BY ... LIMIT`；两者基数相等依赖 `unit_price` 与 `product` 1:1（`unit_price_product_id_unique`）——此前提**必须**显式成立。

**计数口径一致性（限可点进节点）**：对每个 `rankable=true` 节点，`rankableCount` **必须**与 `GET /rankings?category=<该节点>` 的入榜全集基数相等（同一数据快照）；对 `rankable=false` 节点 `/rankings` 不开榜（`400`），不适用该一致性（其 `rankableCount` 为分支信息计数）。

**未 seed 退化态**：DB 已连但 taxonomy 未 seed（`tag` 无 category 行）时**必须**返回 `200 { nodes: [] }`，**禁止**报错。

#### 场景:返回完整 category is-a 树（含乳品子树）、不含其它标签轴

- **当** 客户端 `GET /categories`
- **那么** 接口**必须**返回 `200` + 全部 `kind=category` 节点（root 饮料 + 软饮子树 + **乳品子树** + 酒类子树），每节点含 `slug / name / parentSlug / comparableUnit / rankable / rankableCount`；**禁止**含任何 attribute/brand/product_line 标签

#### 场景:comparableUnit 继承 + rankable 收敛（软饮/乳品/酒种叶可点进，root/酒类父不可点进）

- **当** 检查 `软饮`/`软饮叶`、`乳品`/`乳品叶`、`各酒种叶`(啤酒/葡萄酒/…)、`酒类` 父、root `饮料`
- **那么** 软饮全线、乳品全线、各酒种叶 `comparableUnit=per_100ml`、`rankable=true`（可点进、各有 cohort 榜）；`酒类` 父与 root `comparableUnit=null`、`rankable=false`（不可点进）

#### 场景:消费契约用 rankable 判榜入口（酒类父 rankableCount>0 但不可点进）

- **当** 检查 `酒类` 父节点：其 `rankableCount > 0`（其下有可排名酒类叶）但 `rankable=false`
- **那么** 客户端**必须**据 `rankable=false` 判它**不可点进**（与 `/rankings?category=alcohol` 守卫 `400` 一致）；**禁止**据 `rankableCount>0` 误判可点进

#### 场景:可点进节点 rankableCount 与其 cohort 榜基数一致

- **当** 某 `rankable=true` 节点（如 `啤酒`/`软饮`/`乳品`）`GET /categories` 报 `rankableCount=N`，随后 `GET /rankings?category=<该节点>` 拉全（同快照）
- **那么** 该 cohort 榜入榜项总数**必须**等于 `N`

#### 场景:可点进节点闭包下无可排名成员时计数为 0、不报错

- **当** 某 `rankable=true` 节点闭包下暂无 `rankable=true ∧ per100ml` 非空成员
- **那么** 该节点**必须**照常出现、`rankableCount=0`（可点进但空榜），**禁止**省略该节点或报错

#### 场景:taxonomy 未 seed 时返回空树而非报错

- **当** DB 已连但 `tag` 表无任何 kind=category 行
- **那么** **必须**返回 `200 { nodes: [] }`，**禁止**报错
