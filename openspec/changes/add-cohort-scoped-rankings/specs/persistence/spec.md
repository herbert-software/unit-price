## 修改需求

### 需求:repository 必须提供 listRankings 只读榜单查询契约

`@unit-price/db` 的 repository **必须**为榜单消费（`rankings-api` 的 `GET /rankings`）提供按可比单价升序的分页查询：`category` 入参解析为 taxonomy 节点、驱动闭包过滤，并读取 `product.rankable` 作入榜门。

**只读与不重算**：**必须只读**——禁止写库、禁止解析/计算。投影中的 `per100ml`/`formula`/`confidence`/`warnings` **必须直接取 `unit_price` 已存储列**、**禁止**读路径用整数分 `price` 重算。闭包 / `rankable` / cohort 守卫仅作过滤/准入。

**Cohort 守卫与默认节点（P3.5）**：API 层**必须**仅对「**静态**解析单位非空」的**单一 cohort 节点**调用本查询；对解析单位为 `null` 的跨 cohort 节点（root `beverage`、`酒类` 父）**必须**在调用前返回 `400`（不调本查询）——见 `rankings-api` cohort 守卫。**守卫的解析必须用编译期 `CATEGORY_NODES` 静态解析器（`resolveComparableUnitStatic`），不得用 repository 运行期 `resolveComparableUnit`**（运行期版对未 seed 的合法 cohort slug 解析得 `null`、会与「合法但未 seed → `200 []`」冲突）。本查询（listRankings）自身不承担守卫：调用方守卫后才进入，故本查询对未 seed 节点照常闭包零命中返回 `[]`（→ `200`）。**默认节点为 `soft-drink`**（取代 P3 的 `beverage` root）。本查询自身机制（闭包+rankable+per100ml+DISTINCT）不变，但因调用方守卫，只在单一 cohort 节点上执行、结果天然同质。

**入榜过滤与轴**：一行入榜当且仅当**三者皆真**：① 目标节点闭包成员（`product_tag`(kind=category 叶) JOIN `category_closure.ancestor_tag_id = 目标节点`）；② `product.rankable = true`；③ `unit_price.per100ml IS NOT NULL`。**P3.5**：`comparable_unit=per_100ml` 现扩绑到**乳品叶与各酒种叶**，故乳品/酒类商品也 `rankable=true`、在各自 cohort 节点入榜；数据门列由可排名成员轴定、v1 一律 `per100ml`。`category` 下推为闭包过滤；`product.category` 列**仍禁止**用作入榜判别。`per100ml=NULL` 项、`rankable=false`（待细化/待人工）项一律**排除**。

**闭包 JOIN 去重（防御性）**：`category_closure` 仅含 category is-a 边 → JOIN 天然只匹配 category 叶边。单归属（每商品至多一叶）是写时应用层强制、**非** DB 约束。故节点榜查询**必须**对 `unit_price.id` 加 `SELECT DISTINCT` 兜底（对齐 `listProductIdsInCategoryNode`）。

**排序与查询计划口径**：**必须**按 `per100ml` 升序主键、`unit_price.id` 升序次键（**禁用**跨表 `product.id`）。节点路径查询计划契约（驱动表全扫、`category_closure` 与 `unit_price` 经各自唯一键 `SEARCH ... USING INDEX`、允许 temp B-tree、EXPLAIN 先 `ANALYZE` 按表 substring 断言、不加 `category_closure(ancestor_tag_id,tag_id)`）以 `rankings-api`「节点路径的查询计划口径」节为单一事实源、本规范不重述。

**投影形状与校验口径**：返回反规范化只读投影（`unit_price ⋈ product ⋈ product_raw ⋈ product_tag ⋈ category_closure`）。`confidence` **必须**取 `unit_price.confidence`（非 `product.confidence`）。`warnings` 经 `decodeJson` + `WarningsSchema` 还原为 `string[]`、**禁止**透原始串；损坏列 fail-closed 抛错 → handler `500`、不静默丢行。

#### 场景:按品类节点闭包 + rankable + per100ml 升序分页（含酒种/乳品 cohort）

- **当** 调用节点榜查询 `category='carbonated'`（库含碳酸叶 rankable 软饮、其它叶软饮、`rankable=false` 行、`per100ml=NULL` 行）
- **那么** **必须**只返回碳酸节点闭包下 `rankable=true ∧ per100ml` 非空成员、按 `per100ml` 升序、同值按 `unit_price.id`，切片 `[offset,offset+limit)`；非该节点成员/`rankable=false`/`per100ml=NULL` 行**不出现**
- **当** 调用 `category='beer'`（啤酒叶，本期绑 `per_100ml`）
- **那么** **必须**返回啤酒 cohort（葡萄酒/白酒等其它酒种不出现）；乳品叶同理各返回其 cohort

#### 场景:默认节点 soft-drink；跨 cohort 节点不经本查询

- **当** API 处理无参 `/rankings`
- **那么** 解析默认节点 `soft-drink` 调本查询、返回软饮 cohort（取代 P3 默认 root）
- **当** API 收到 `category=beverage`(root) 或 `category=alcohol`(酒类父)（解析单位 `null`）
- **那么** API **必须** cohort 守卫 `400`、**不调用**本查询（不产生混排了不同酒种或软饮+酒类的结果）；酒类商品仅在**各酒种叶** cohort 查询里 `rankable=true` 出现

#### 场景:违反单归属（同商品双叶）仍至多一行

- **当** 某商品违反单归属、挂两条 category 叶边且都命中目标节点
- **那么** 结果中**必须**至多出现一次（`SELECT DISTINCT unit_price.id` 兜底）

#### 场景:per100ml/formula/confidence 取存储值不重算且 confidence 取权威列

- **当** 某行 `unit_price.per100ml=0.505`、`formula="40 / (330 * 24 * 1) * 100"`、`unit_price.confidence=0.95`，其 `product.confidence=0.5`
- **那么** 投影 `per100ml`/`formula` 等于 `unit_price` 存储值（未重算）、`confidence` 等于 `0.95`，**禁止**返回 `0.5`

#### 场景:同 per100ml 分页稳定且计划走有效护栏

- **当** 多行 `per100ml` 相同，分两次取同一节点榜（`offset=0` 与 `offset=N`，数据不变）
- **那么** 两次按 `unit_price.id` 升序不重叠不遗漏覆盖；EXPLAIN（先 `ANALYZE`）中 `category_closure` 与 `unit_price` **必须** `SEARCH ... USING INDEX`，**允许** temp B-tree 与驱动表全扫

### 需求:repository 必须提供品类树 + 每节点可排名计数的只读查询

`@unit-price/db` 的 repository **必须**提供只读方法（供 `category-tree-api` 的 `GET /categories`）返回 category is-a 树及每节点可排名计数。**必须只读**、不写库、不解析/计算。

- **节点集与继承**：返回全部 `kind=category` 节点（`slug`/`name`/`parentSlug`）+ 经 is-a 继承解析的 `comparableUnit`。继承解析**必须**一次性加载全部 category 节点后在**内存**沿 parent map 求解，**禁止**逐节点串行 `resolveComparableUnit`。**P3.5**：软饮全线、**乳品全线**、**各酒种叶**解析得 `per_100ml`；`酒类` **父**与 root 解析得 `null`。
- **rankableCount 与节点榜同源**：每节点 `rankableCount` 过滤谓词（闭包成员 ∧ `rankable=true` ∧ `per100ml` 非空）**必须**与 listRankings 取自**同一份可复用 builder 片段**，`rankableCount` = `COUNT(DISTINCT product.id)`；两者基数相等依赖 `unit_price` 与 `product` 1:1（`unit_price_product_id_unique`）、须显式成立。
- **`rankable` 语义（P3.5 收敛）**：节点 `rankable` = `comparableUnit !== null`，现等价于「该节点是单一 cohort、可点进榜」——软饮/软饮叶/乳品/乳品叶/各酒种叶 = `true`；`酒类` 父与 root = `false`。
- **rankableCount 与 rankable 正交、但口径分可点进/不可点进**：`rankableCount` = 闭包后代可排名数。对 `rankable=true`（可点进）节点，等于其 `/rankings?category=该节点` cohort 榜基数。对 `rankable=false` 节点（root / `酒类` 父），`rankableCount` 为**分支信息性计数**（**P3.5 起 `酒类` 父 `rankableCount>0`**，因其后代各酒种叶 rankable；不再为 0），但该节点**无对应单一榜**（API cohort 守卫拒榜）。**禁止**把 `rankable=false` 推成 `rankableCount=0`；亦**禁止**把 `rankableCount>0` 推成「可点进」。
- **未 seed 退化**：`tag` 无 category 行时返回空节点集（不报错）。

#### 场景:返回全 category 节点 + 继承单位 + 每节点可排名计数（含乳品/酒种叶 per_100ml）

- **当** 调用品类树查询，库已 seed P3.5 树且有可排名软饮/乳品/酒类商品
- **那么** **必须**返回全部 kind=category 节点（root/软饮子树/乳品子树/酒类子树），每节点带继承解析 `comparableUnit`（软饮线/乳品线/各酒种叶 `per_100ml`；`酒类` 父/root `null`）与 `rankableCount`

#### 场景:rankableCount 与节点榜基数逐节点相等（限可点进节点）

- **当** 对每个 `rankable=true` 节点比较其 `rankableCount` 与对应节点榜（同片段、同快照）行数
- **那么** 二者**必须**逐节点相等（软饮/乳品/各酒种叶）；`rankable=false` 节点（root/酒类父）无对应榜、不适用该一致性，其 `rankableCount` 为分支信息计数（酒类父 `>0`）

#### 场景:未 seed 时返回空节点集

- **当** `tag` 表无任何 kind=category 行
- **那么** 查询**必须**返回空节点集，**禁止**报错
