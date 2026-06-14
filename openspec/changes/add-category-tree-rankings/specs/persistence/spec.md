## 修改需求

### 需求:repository 必须提供 listRankings 只读榜单查询契约

`@unit-price/db` 的 repository **必须**提供只读方法为榜单消费（`rankings-api` 的 `GET /rankings`）提供按可比单价升序的分页查询。**P3 升级**：该查询由 P2 的「全局扁平、`category` 不下推」改为**品类节点作用域**——`category` 入参解析为 taxonomy 节点、驱动闭包过滤，并读取 `product.rankable` 作入榜门。方法是既有「至少 `upsertRaw`/`saveParsed`/`getProduct`/`saveCorrection`」契约的**扩充**（既有方法语义不变）。

**只读与不重算**：**必须只读**——禁止写库、禁止触发解析/计算。投影中的 `per100ml`、`formula`、`confidence`、`warnings` **必须直接取 `unit_price` 已存储列**，**禁止**在读路径用库内整数分 `price` 重算（与既有「`per100ml` 必须从 `CalcResult` 直存、禁止 repo 重算」同口径，保证留痕一致）。闭包 / `rankable` 仅作**过滤**，不参与重算。

**入榜过滤与轴（P3 收敛，取代 P2「per100ml 唯一判据、category 不下推、不读 rankable」）**：一行入榜当且仅当**三者皆真**：① 它是目标品类节点的闭包成员（`product_tag`(kind=category 叶) JOIN `category_closure.ancestor_tag_id = 目标节点`）；② `product.rankable = true`；③ `unit_price.per100ml IS NOT NULL`。数据门列由可排名成员轴决定、v1 一律 per100ml（`rankable=true ⟹ 成员 comparable_unit=per_100ml`，故对任一节点含 root 一律 `per100ml IS NOT NULL`；详见 `rankings-api`）。**`category` 现下推为闭包过滤**（非 P2 的 no-op）；`product.category` 列（恒 `beverage`）**仍禁止**用作入榜判别。`per100ml`/`per100g` 仅有 per100g 的重量品、确定不可计算项、`rankable=false`（酒类叶/待细化/待人工）一律**排除**。

**闭包 JOIN 去重（防御性，单归属是应用层不变量非 DB 约束）**：`category_closure` 仅含 category is-a 边，故 `category_closure.tag_id = product_tag.tag_id` 的 JOIN 天然只匹配 category 叶边。单归属（每商品至多一叶）是写时（`attachTag`/`reconcileCategory`）应用层强制、**非** DB 约束（`product_tag` 唯一键是 `(product_id, tag_id)` 全对，不阻止叶+祖先并存）。故节点榜查询**必须**对 `unit_price.id` 加 `SELECT DISTINCT` 兜底（对齐既有 `listProductIdsInCategoryNode` 的 `selectDistinct`），使任一未来双叶缺陷不致重复列出同一商品。

**排序与查询计划口径（P3 节点路径；取代 P2「主序必走 unit_price_per100ml_idx」要求）**：**必须**按 `unit_price.per100ml` 升序为主排序键、`unit_price.id` 升序为次级键（同表确定全序、分页稳定；**禁用**跨表 `product.id`）。**节点路径的查询计划契约（驱动表全扫、`category_closure` 与 `unit_price` 经各自唯一键 `SEARCH ... USING INDEX`、允许 temp B-tree、EXPLAIN 护栏按表 substring 断言并先 `ANALYZE`、不加 `category_closure(ancestor_tag_id, tag_id)`）以 `rankings-api`「节点路径的查询计划口径」节为单一事实源——本规范不重述、以免双写漂移**；持久层只额外固定：① 该计划契约是 repository 这条查询的实现约束；② 节点查询带 `category_closure.ancestor_tag_id=:node` 与 `product.rankable=1` 两等值过滤，配 `SELECT DISTINCT unit_price.id`（见上去重段）。v1 规模（~445 product、闭包 ~35 行、~13 节点）下整体 sub-ms、**可接受**。

**投影形状与校验口径**：返回**反规范化只读投影**（join `unit_price ⋈ product ⋈ product_raw ⋈ product_tag ⋈ category_closure` 后取展示列：`unit_price` 的 `per100ml`/`formula`/`confidence`/`warnings`、`product_raw` 的 `title`/`price`(整数分)/`store`/`store_sku`/`source_url`），**不是**领域对象。榜单投影契约校验由消费端 `rankings-api` 的 `RankingsResponseSchema` 在 API 层承担。`confidence` **必须**取 `unit_price.confidence`（最终权威 band）、**禁止**误取 `product.confidence`。`warnings` 以 JSON-text 存储、投影**必须**经 `decodeJson` 还原并经 `WarningsSchema` 校验为 `string[]`、**禁止**透出原始串；损坏列**必须** fail-closed 抛错（致整体抛 → handler `500`），不静默丢行/返回部分结果。「读出领域对象必须经 Zod 再校验」对 `getProduct`/`saveCorrection` 等**仍有效**；本榜单投影是非领域投影、校验落 API 层、并存不冲突。

#### 场景:按品类节点闭包 + rankable + per100ml 升序分页

- **当** 调用节点榜查询（`category='carbonated'`，库中含碳酸叶 rankable 软饮、其它叶软饮、`rankable=false` 行、`per100ml=NULL` 行）
- **那么** **必须**只返回碳酸节点闭包下 `rankable=true ∧ per100ml` 非空的成员、按 `per100ml` 升序、同值按 `unit_price.id` 升序，切片 `[offset, offset+limit)`；非该节点成员、`rankable=false`、`per100ml=NULL` 的行**必须不出现**

#### 场景:默认 root（beverage）= 全部可排名软饮、酒类经 rankable 门排除

- **当** 调用 `category='beverage'`（root），库中含可排名软饮与有 per100ml 的酒类（`rankable=false`）
- **那么** 结果**必须**含全部可排名软饮（闭包到 root）、**必须不含**任何 `rankable=false` 行（含有 per100ml 的酒类）；`product.category` 列**不**参与判别

#### 场景:违反单归属（同商品双叶）仍至多一行

- **当** 某商品违反单归属、挂两条 category 叶边且都命中目标节点
- **那么** 该商品在结果中**必须**至多出现一次（`SELECT DISTINCT unit_price.id` 兜底）、不重复

#### 场景:per100ml/formula/confidence 取存储值不重算且 confidence 取权威列

- **当** 某行 `unit_price.per100ml = 0.505`、`formula = "40 / (330 * 24 * 1) * 100"`、`unit_price.confidence = 0.95`，而其 `product.confidence`（解析中间值）= `0.5`
- **那么** 投影行的 `per100ml`/`formula` **必须**等于 `unit_price` 存储值（未重算），`confidence` **必须**等于 `0.95`（`unit_price.confidence`），**禁止**返回 `0.5`

#### 场景:同 per100ml 分页稳定且计划走有效护栏

- **当** 多行 `per100ml` 相同，分两次取同一节点榜（`offset=0` 与 `offset=N`，limit=N，两次间数据不变）
- **那么** 两次结果**必须**按 `unit_price.id` 升序不重叠不遗漏地覆盖这些同值行；EXPLAIN（先 `ANALYZE`）中 `category_closure` 与 `unit_price` **必须** `SEARCH ... USING INDEX`（不退化为 SCAN），**允许** temp B-tree 与驱动表全扫

## 新增需求

### 需求:repository 必须提供品类树 + 每节点可排名计数的只读查询

`@unit-price/db` 的 repository **必须**新增只读方法（供 `category-tree-api` 的 `GET /categories`）返回 store-agnostic 的 category is-a 树及每节点的可排名计数。该方法**必须只读**、不写库、不解析/计算。

- **节点集与继承**：返回全部 `kind=category` 节点（`slug`/`name`/`parentSlug`）+ 经 is-a 继承解析的 `comparableUnit`（节点自身值，空则沿 parent 取最近非空祖先，至 root 仍空则 null）。继承解析**必须**一次性加载全部 category 节点后在**内存**沿 parent map 求解，**禁止**逐节点串行调按 `parent_id` 往返的 `resolveComparableUnit`（D1 上 O(节点×深度) 次往返）。
- **rankableCount 与节点榜同源**：每节点 `rankableCount` 的过滤谓词（闭包成员 ∧ `rankable=true` ∧ `per100ml` 非空）**必须**与 listRankings 节点榜查询取自**同一份可复用 builder 片段**，`rankableCount` = 在该片段上做 `COUNT(DISTINCT product.id)`；**禁止**两处各自手写谓词。`COUNT(DISTINCT product.id)` 与节点榜（去重于 `unit_price.id`）基数相等**依赖既有不变量 `unit_price` 与 `product` 1:1（`unit_price_product_id_unique`）**——此为承重前提，须显式成立；若未来放松该 1:1，两侧须改用同一 `COUNT(DISTINCT product.id)` 口径。
- **正交语义**：节点自身 `rankable`（= `comparableUnit !== null`）与 `rankableCount`（闭包后代可排名数）**正交**——root `beverage`（`rankable=false`）的 `rankableCount` 可 `> 0`（其后代含可排名软饮）；唯闭包无可排名成员的节点（酒类子树）`rankableCount=0`。**禁止**把节点 `rankable=false` 推成 `rankableCount=0`。
- **未 seed 退化**：`tag` 无 category 行时返回空节点集（不报错）。

#### 场景:返回全 category 节点 + 继承单位 + 每节点可排名计数

- **当** 调用品类树查询，库已 seed 品类树且有若干可排名软饮
- **那么** **必须**返回全部 kind=category 节点（含 root/软饮父/软饮叶/酒类子树），每节点带继承解析的 `comparableUnit`（软饮线 `per_100ml`、酒类/root `null`）与 `rankableCount`；root 的 `rankableCount` **必须** `>0` 且等于默认节点榜基数、酒类节点 `rankableCount=0`

#### 场景:rankableCount 与节点榜基数逐节点相等

- **当** 对每个节点比较其 `rankableCount` 与对应节点榜（同一过滤片段、同快照）的行数
- **那么** 二者**必须**逐节点相等（含 root / 父 / 叶 / 酒类=0），由共用过滤片段 + `unit_price` 1:1 保证

#### 场景:未 seed 时返回空节点集

- **当** `tag` 表无任何 kind=category 行
- **那么** 查询**必须**返回空节点集，**禁止**报错
