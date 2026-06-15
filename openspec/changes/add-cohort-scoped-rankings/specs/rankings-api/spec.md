## 修改需求

### 需求:GET /rankings 只读榜单接口

`apps/api` 必须提供 `GET /rankings`，从既有持久化层读取已落库的单价计算结果，按真实单价升序分页返回一张**品类节点作用域**的榜单。基础读取为 `unit_price ⋈ product ⋈ product_raw`，追加 `product_tag`(叶 category 边) JOIN `category_closure`(祖先 = 目标节点) 的闭包命中，并读取 `product.rankable` 派生列作入榜门。该接口**只读**：禁止写入、禁止调用 LLM、禁止触发任何后台任务、禁止任何出站 fetch。

**Cohort 守卫（P3.5 核心修正）**：榜**只对「自身解析出非空 `comparable_unit`」的节点开放**——即目标节点经 is-a 继承解析出非空可比单位（软饮 / 软饮叶 / 乳品 / 乳品叶 / 各酒种叶）。**跨多个可比 cohort 的节点（root `饮料`、`酒类` 父节点，解析单位为 `null`）必须拒绝开榜**（返回 `400`，见「分页与查询参数边界」），以杜绝「矿泉水 + 葡萄酒」「啤酒 + 威士忌」这类 per100ml 不可比的混榜。守卫判据机械：节点的解析单位非空 ⟺ 该节点是单一 cohort（其整棵子树共享同一 `comparable_unit` 绑定点）⟺ 可开榜；为 `null` ⟺ 跨绑定点的祖先 ⟺ 拒榜。

**守卫的解析必须基于编译期 seed 定义（`CATEGORY_NODES`）、不得用运行期 DB 查询**：cohort 守卫**必须**用一个**纯同步、编译期派生自 `packages/db` 的 `CATEGORY_NODES` 常量**的静态解析器 `resolveComparableUnitStatic(slug)`（沿 `parentSlug` 求 is-a 继承、不查 `tag` 表，与 `CATEGORY_SLUGS` 同一派生范式），**禁止**复用 repository 的运行期 `resolveComparableUnit(nodeSlug)`（它 round-trip `tag` 表）。理由是单一来源的关键正确性约束：合法但 DB 暂未 seed 的 cohort slug（如 `beer`，迁移先于 seed 窗口、`tag` 行尚不存在）经**运行期** `resolveComparableUnit` 会解析得 `null` → 被守卫误判 `400`，与下文「合法 slug 但 DB 未 seed → `200` + 空数组、禁止误报 `400`」**直接冲突**；而**静态**解析器对 `beer` 恒为 `per_100ml`（与 DB seed 状态无关）→ 守卫放行 → 闭包零命中 → `200 []`，对 `酒类`/`beverage` 恒为 `null` → `400`，两侧契约同时满足。守卫遂与 `category` slug 校验一样是**纯同步 parse、无 DB 往返**（亦消除每请求一次 D1 子查询的开销）。repository 的运行期 `resolveComparableUnit` 仍用于打标签管线（`apps/api/src/tagging.ts` 算 `rankable`），不受影响。

**数据源与计算留痕**：响应中每个榜单项的 `per100ml`、`formula`、`confidence`、`warnings` 必须**直接取自 `unit_price` 已存储的列，禁止在读路径重算**。`packages/core` 不得进入读路径。闭包 / `rankable` / cohort 守卫仅作**过滤/准入**，不参与任何重算。

**入榜判据（合取门）**：一行入榜当且仅当**四者皆真**：⓪ 目标节点解析单位非空（cohort 守卫，否则整请求 `400`）；① 它是目标品类节点的闭包成员（`product_tag` 叶 JOIN `category_closure.ancestor_tag_id = 目标节点`）；② `product.rankable = true`（资格门：已分类叶 ∧ 该叶解析出非空 `comparable_unit`）；③ `unit_price.per100ml IS NOT NULL`（数据门）。`rankable` 的派生口径**不变**（已分类叶 ∧ 解析单位非空），但本期把 `comparable_unit=per_100ml` **扩绑到乳品叶与各酒种叶**，故乳品/酒类商品现也 `rankable=true`、各自在其 cohort 节点入榜。**数据门列由可排名成员所在轴决定**——v1 唯一可比轴是 `per_100ml`（软饮/乳品/酒类叶全绑 per_100ml），故对任一**可开榜节点**数据门一律 = `per100ml IS NOT NULL`；v2 引入 `per_100g` 等多轴时按成员轴取列（非目标）。分类为可排名但规格不可算者（rankable=true ∧ per100ml=null）**不入榜**。**此口径在 P3「rankable+闭包」基础上加 cohort 守卫**：取代 P3「酒类叶 comparable_unit=null 故 rankable=false、酒类节点自然空榜」——本期酒类各叶**可排名**、各有 cohort 榜，而酒类**父**节点因解析单位 null 被守卫拒榜（非空榜）。

**闭包 JOIN 的去重与单 category 轴保证**：`category_closure` 仅含 category is-a 边、attribute/brand/product_line 无闭包行，故 `category_closure.tag_id = product_tag.tag_id` 的 JOIN **天然只匹配 category 叶边**，无需另按 kind 过滤。由单归属不变量（每商品至多一条 category 叶边）+ `category_closure (tag_id, ancestor_tag_id)` 唯一，对给定目标节点每商品至多命中一行。**但该「至多一行」依赖写时（`attachTag`/`reconcileCategory`）应用层强制的单归属不变量、而非 DB 约束**。故节点榜查询**必须**对 `unit_price.id`、`rankableCount` 查询**必须**对 `product.id` 加 `DISTINCT`/`GROUP BY` 作**防御性兜底**（对齐 `listProductIdsInCategoryNode` 的 `selectDistinct`）。

**排序**：必须按 `per100ml` **升序**（最便宜真实单价 `rank=1`）。相同 `per100ml` 必须以 **`unit_price` 同表确定列 `unit_price.id` 升序**作次级排序键，保证分页稳定、不重叠不遗漏；**禁用跨表 `product.id`**。`unit_price.id` 是 app 生成 **TEXT** 主键、`ASC` 字典序、构成确定全序。

**节点路径查询计划口径**：沿用 P3——节点查询带闭包+rankable 两等值过滤；EXPLAIN 计划测试先 `ANALYZE`、断言 `category_closure` 与 `unit_price` 均 `SEARCH ... USING INDEX`（经各自唯一键），允许 `USE TEMP B-TREE`（ORDER BY + DISTINCT）与驱动表（`product`/`product_tag`）全扫；不断言「从 closure/product_tag 驱动」或「不出现 SCAN unit_price」（详见既有 P3 口径，本期不变）。

**响应 schema（Zod 单一事实源）**：响应体必须由 `RankingsResponseSchema`（居 `@unit-price/api-client`）定义、**本变更不改该 schema**。每项含 `rank`(1-based、`offset+序号`、读时投影)、`title`(`product_raw.title`)、`priceCents`(整数分、禁服务端换算)、`per100ml`(存储值)、`formula`(存储值、`CalcResultGate` 保证非空)、`confidence`(`unit_price.confidence` 权威 band、非 `product.confidence`)、`warnings`(`string[]`、经 `decodeJson`+`WarningsSchema` 还原、禁透原始 JSON)、`store`/`storeSku`/`sourceUrl`(`product_raw`，`sourceUrl` 可空)。

**口径漂移与 warnings 透出**：`priceCents`(整件总价分) 与 `per100ml`(按总容量摊算) 分母不同、前端禁互推、可比量一律用 `per100ml`；调价后 `priceCents`(最新) 与 `per100ml`(旧价算、first-write-wins 不刷新) 可能漂移、本期接受。带 `warnings`（尤其「数量按单件推断为 1」）的项照常入榜、原样透出、禁静默剔除。

#### 场景:无参默认 ≡ category=soft-drink（默认榜节点 root→软饮）

- **当** 客户端 `GET /rankings`（不带参数）
- **那么** 它**必须**严格等价于 `category=soft-drink`（**取代** P3 的默认 `category=beverage`(root)），解析为 taxonomy `软饮` 节点经闭包过滤，返回软饮 cohort 榜（碳酸/果汁植物饮/咖啡茶饮/饮用水 混排、按 per100ml 升序）；**禁止**改读 `product.category` 列
- **那么** 每项与 `unit_price` 存储值逐一相等（未重算）；软饮榜**不含**酒类/乳品（它们在各自 cohort 节点的榜，不在软饮闭包内）

#### 场景:各酒种叶有自己的 per100ml cohort 榜

- **当** 客户端 `GET /rankings?category=beer`（啤酒叶，本期已绑 `comparable_unit=per_100ml`）
- **那么** 接口**必须**返回 `200`、仅含啤酒叶闭包下 `rankable=true ∧ per100ml` 非空的成员、按 per100ml 升序；葡萄酒/白酒等其它酒种**禁止**出现（各酒种是独立 cohort、不混）。`葡萄酒`/`白酒`/`洋酒`/`威士忌`/`清酒果酒` 同理各有其 cohort 榜

#### 场景:乳品有自己的 per100ml cohort 榜

- **当** 客户端 `GET /rankings?category=乳品节点 slug`
- **那么** 接口**必须**返回乳品 cohort 榜（牛奶/酸奶/乳酸菌饮料 按 per100ml 升序）；**不含**软饮/酒类

#### 场景:跨 cohort 节点（酒类父 / root 饮料）拒绝开榜

- **当** 客户端 `GET /rankings?category=alcohol`（酒类父，解析单位 `null`）或 `?category=beverage`（root，解析单位 `null`）
- **那么** 接口**必须**返回 `400 invalid-request`（cohort 守卫：该节点跨多个可比 cohort、不可直接比、请选子分类）——**取代** P3 的「酒类 → `200 []`」「默认=beverage root 榜」；**禁止**返回混排了不同酒种或软饮+酒类的榜

#### 场景:per100ml 为 null 的项不入榜

- **当** 某 rankable 商品（软饮/乳品/酒类叶）`per100ml = null`（规格不可算）
- **那么** 该行**禁止**出现（数据门兜住）

#### 场景:违反单归属（同商品双叶）时仍至多列一次（DISTINCT 兜底）

- **当** 某商品因数据漂移/缺陷同时挂两条 `kind=category` 叶边（闭包都命中目标节点）
- **那么** 该商品在节点榜中**必须**至多出现一次（`DISTINCT unit_price.id` 兜底）、`rank` 不重复

#### 场景:formula/per100ml 取存储值不重算

- **当** 某项落库 `unit_price.formula = "40 / (330 * 24 * 1) * 100"`、`per100ml ≈ 0.505`
- **那么** 响应中 `per100ml`/`formula` **必须**等于存储值，**禁止**服务端用 `priceCents` 重算覆盖

#### 场景:单件推断项带 warning 入榜而非被剔除

- **当** 某入榜项 `unit_price.warnings` 含「数量按单件推断为 1」
- **那么** 该项照常入榜、`warnings` 原样含该提示，**禁止**因含单件推断剔除或清空

### 需求:分页与查询参数边界

`GET /rankings` 必须支持 `limit` / `offset` 分页与 `category` 品类节点过滤，并对非法参数返回**确定**的 HTTP 状态：

- `limit`：缺省 `50`；present 时**仅接受十进制非负整数串**（`^\d+$`），`> 200` **clamp 到 200**（不报错）、`= 0` 或不匹配者（空串/十六进制/含空白/负号/小数点/`NaN`/`Infinity`）一律 `400` + `invalid-request`；**禁止**宽松强转。
- `offset`：缺省 `0`；present 时**仅接受 `^\d+$`**，不匹配者 `400` + `invalid-request`（与 `limit` 同口径）；`offset` 超出结果总数返回 `200` + 空数组（**不是** `404`）。
- `category`（P3.5 升级）：**缺省为 `soft-drink`**（软饮节点，**取代** P3 的缺省 `beverage`）；present 时**必须**精确匹配一个 **seed 的 kind=category 节点 slug**（大小写敏感，含本期新增的乳品节点/叶与各酒种叶）。其值驱动闭包过滤。
  - **校验集单一来源、编译期派生**：**必须**校验「seed 品类树 kind=category slug 全集」，单一来源、**编译期**派生自 `packages/db` 的 `CATEGORY_NODES`、纯同步 parse；**禁止** `apps/api` 手写第二份 slug 枚举；**禁止**运行期查 `tag` 表校验（无法区分「未 seed 合法 slug」与「拼写错误」）。
  - **cohort 守卫（新增）**：present 或缺省解析出的节点，经**静态解析器 `resolveComparableUnitStatic`（编译期派生自 `CATEGORY_NODES`、不查 DB，见上文「守卫的解析必须基于编译期 seed 定义」）** 解析得 `null`（root `beverage`、`alcohol` 父）→ 返回 `400 invalid-request`（提示该节点跨 cohort、请选子分类）。**取代** P3 的「酒类 → `200 []`」「`beverage` 默认放行」。**禁止**用运行期 `repo.resolveComparableUnit` 做此守卫（否则未 seed 的合法 cohort slug 被误判 `400`，违反下一条）。
  - **未知 slug、空串、非 category 的 slug**（attribute/brand，如 `sugar-free`）→ `400 invalid-request`。
  - **「拼写错误」vs「合法 slug 但 DB 未 seed 该 tag 行」可区分**：属 seed 全集且**静态解析单位非空**的 slug（如 `beer`），即便 DB 暂无对应 `tag`/closure 行（迁移先于 seed 窗口）→ 守卫据**静态** `CATEGORY_NODES` 放行、闭包零命中 → `200` + 空数组，**禁止**误报 `400`。此条与上一条 cohort 守卫的相容性**仅靠静态解析器成立**：静态解析对 `beer` 恒为 `per_100ml`（放行）、对 `alcohol`/`beverage` 恒为 `null`（拒榜），不随 DB seed 状态漂移。

`invalid-request`（400）与既有码（`auth-*`/`rate-limited`/`config-error`/`persistence-error`/`internal`）一致复用、**不新增**；DB 失败沿用 `persistence-error`（500）。

#### 场景:缺省 category 为 soft-drink

- **当** 客户端 `GET /rankings`（无 `category`）
- **那么** 等价 `category=soft-drink`、返回软饮 cohort 榜（非 root、非混榜）

#### 场景:酒种/乳品叶 slug 放行、酒类父/root 拒绝

- **当** 客户端 `?category=beer`/`?category=葡萄酒 slug`/`?category=乳品叶 slug`（解析单位非空）
- **那么** `200` + 该 cohort 榜
- **当** 客户端 `?category=alcohol`/`?category=beverage`（解析单位 null）
- **那么** `400 invalid-request`（cohort 守卫）

#### 场景:未知 / 非 category / 大小写不符 / 空串 category 返回 400

- **当** 客户端 `?category=nope`（不存在）/ `?category=sugar-free`（attribute）/ `?category=Beer`（大小写不符）/ `?category=`（空串）
- **那么** `400 invalid-request`

#### 场景:合法 slug 但 DB 未 seed 该 tag 行时返回空数组而非 400（守卫走静态解析）

- **当** 客户端 `?category=beer`（属 seed 全集、**静态**解析单位 `per_100ml` 非空），但 DB 因迁移先于 seed 窗口尚无对应 `tag`/closure 行
- **那么** cohort 守卫据**静态 `CATEGORY_NODES`** 放行（**不**因运行期 `tag` 缺失而判 `null`）→ 闭包零命中 → `200` + 空数组，**禁止**误报 `400`
- **当** 同窗口客户端 `?category=alcohol`（静态解析 `null`）
- **那么** cohort 守卫 `400`（与 DB 是否 seed 无关）

#### 场景:limit 超上限 clamp / 非法 limit-offset 400 / offset 越界空数组

- **当** `?limit=1000` → `200` 最多 200 条；`?limit=-5`/`?limit=0`/`?offset=abc`/`?limit=`/`?offset=1.5`/`?limit=%20%205` → `400 invalid-request`；`?offset=100000`（越界）→ `200` + 空数组
- **那么** 严格按上述确定状态返回，**禁止**宽松强转或对越界 offset 报 `404`
