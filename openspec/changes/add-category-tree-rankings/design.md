## 上下文

P2 已就位：`tag`（is-a 树 + `comparable_unit` 单点绑定）、`product_tag`（叶 category + 正交 attribute 边）、`category_closure`（tag 维闭包，含 self 行、仅 category is-a 边）、`product.rankable`（派生列）、生产 backfill 已跑到耗尽。`repository` 已有打标签/闭包原语：`resolveComparableUnit(nodeSlug)`（继承解析）、`listProductIdsInCategoryNode(nodeSlug)`（闭包命中）、`lookupStoreCategory`、三态 reconcile 等，**均为读/写原子，尚无「按品类节点取榜」与「品类树浏览」读查询**。

现有 `GET /rankings`（`rankings-api` 规范 + `buildRankingsQuery`）：`unit_price ⋈ product ⋈ product_raw`，`WHERE per100ml IS NOT NULL`，`ORDER BY per100ml ASC, unit_price.id ASC`，`limit/offset` 分页，响应 `RankingsResponseSchema`（居 `@unit-price/api-client`）。`category` 参数当前是严格 no-op：仅接受小写 `beverage`，其它/空串 → `400 invalid-request`。seed 的品类节点 slug 全为 ASCII（root `beverage` / `soft-drink` / `carbonated` / `juice-plant` / `coffee-tea` / `drinking-water` / `alcohol` 及酒类叶），display name 为中文。

约束：读路径**只读**（禁写/禁 LLM/禁后台/禁出站 fetch）、不重算（per100ml/formula/confidence 取存储值）、`packages/core` 不进读路径、schema 用 Zod 单一事实源、treize 治理豁免（同 `/rankings`）。

## 目标 / 非目标

**目标：**
- 让小程序分类树 Tab 能：① 取品类树结构导航；② 按任一可排名品类节点取 per100ml 升序榜。
- 兑现 P2 遗留的「`rankable` 接入榜单」与「两套入榜判据收敛」。
- 复用既有 `RankingsResponse` / 分页 / 排序契约，最小化新表面与迁移。

**非目标：**
- attribute cohort 求交、`per_100g`/纸品、游标分页、store-map 激活、eval 品类准确率、跨店同款——见提案非目标。
- 不改 `rankable` 派生口径或 backfill（只读 `rankable`）。

## 决策

### D1：把 `category` 参数升级为真实品类节点过滤，而非新增端点/新参数
- **选 A（采纳）**：复用 `GET /rankings?category=<node-slug>`，把占位 no-op 升级为闭包过滤。
- 替代 B：保留 `category` no-op + 新增 `node` 参数 → 两个语义重叠参数，丑且易错。
- 替代 C：新端点 `GET /categories/:slug/rankings` → 不复用 `/rankings` 分页规范、与 architecture「`/rankings` 按品类取榜单」相悖。
- **理由**：① architecture 明确 `/rankings` 按品类取榜；② P2 已把 `category` 写成「未来品类扩展的占位参数」，P3 正是该未来；③ **root 节点 slug 恰为 `beverage`**，与现默认值字面相同——默认 `/rankings`（无参）平滑变为「饮料 root 节点榜」，参数名零变更；④ 复用 `RankingsResponseSchema` 与 `limit/offset` 边界规范，新增表面最小。

### D2：入榜判据收敛为 `rankable=true ∧ per100ml IS NOT NULL`（两道门各司其职）
- `rankable`（资格门）= 已分类叶 ∧ 该叶解析出非空 `comparable_unit`（v1=per_100ml）。回答「这商品该不该上容量轴」。
- `per100ml IS NOT NULL`（数据门）= unit_price 实际算出了 per100ml。回答「我们有没有这个数」。
- 二者**可分离**：分类为软饮（rankable=true）但规格无法解析 → per100ml 仍可能 null（如「礼盒装」无明确容量）；故**两门都要**。
- **酒类自然空榜**：酒类叶 `comparable_unit=null` → `rankable=false`，被资格门滤掉。一个有 per100ml 的葡萄酒因此**不会**进容量榜——这同时修正了扁平榜「按容量排序酒类」的语义错误。**无需对不可排名节点特判**：查询对酒类节点自然返回 `[]`。
- **收敛叙事**：P2 扁平榜（仅 `per100ml IS NOT NULL`）是收敛前的超集；本期 `category` 全节点（含默认 root）统一加 `rankable` 门，两套判据合一。

### D3：按品类节点取榜的查询形状
```
SELECT DISTINCT up.{id,per100ml,formula,confidence,warnings}, pr.{title,price,store,storeSku,sourceUrl}
FROM unit_price up
  JOIN product p        ON up.product_id = p.id
  JOIN product_raw pr   ON p.raw_id = pr.id
  JOIN product_tag pt   ON pt.product_id = p.id            -- 叶 category 边（也可能是 attribute 边）
  JOIN category_closure cc ON cc.tag_id = pt.tag_id
                          AND cc.ancestor_tag_id = :nodeTagId
WHERE p.rankable = 1 AND up.per100ml IS NOT NULL          -- v1 数据门 per100ml；v2 随节点轴切列
ORDER BY up.per100ml ASC, up.id ASC
LIMIT :limit OFFSET :offset
```
- **闭包 JOIN 天然滤掉 attribute 边**：attribute/brand/product_line 无 closure 行，`cc.tag_id = pt.tag_id` 自动只匹配 category 叶 → 无需再按 kind 过滤。
- **去重 = 不变量 + DISTINCT 兜底**：单归属不变量 ⇒ 每商品至多一条 category 叶边；对给定 `:nodeTagId`，`cc` 至多命中一行 → 每商品至多一行。**但该不变量是写时（`attachTag`/`reconcileCategory`）应用层强制、非 DB 约束**（`product_tag` 唯一键是 `(product_id, tag_id)` 全对，不阻止叶+祖先并存）。故**必须**加 `DISTINCT unit_price.id` 防御性兜底（对齐既有 `listProductIdsInCategoryNode` 的 `selectDistinct`），使任一未来双叶缺陷不致重复列出/重复计数——不靠「不变量必成立」裸跑。
- **默认 root（`beverage`）**：`ancestor_tag_id = beverage.id` 命中全部软饮叶（闭包到 root）；酒类叶虽也以 beverage 为祖先，但 `p.rankable=1` 滤除 → root 榜 = 全部可排名软饮。
- **查询计划（节点路径实况，已对实际 schema EXPLAIN 实测；不沿用 P2 扁平榜「主序走 per100ml 索引」要求）**：D1/SQLite 下 `cc.ancestor_tag_id = :node` 用不上 `category_closure` 唯一键前缀（领衔列 `tag_id`）、`p.rankable` 无索引。**实测计划**：驱动表 = `product_tag` 全扫（无 `ANALYZE` 统计时，走覆盖索引）或 `product` 全扫（有 `ANALYZE` 统计时）；`category_closure`、`unit_price` 均**被探**（`SEARCH ... USING INDEX`，分别经其唯一键 / `unit_price_product_id_unique`）；`ORDER BY`、`DISTINCT` 各一次 `USE TEMP B-TREE`。**注意** `unit_price` 在此 join 形状只能经 `product_id` 唯一键到达，规划器**结构上不会** `SCAN` 它——故「不出现 SCAN unit_price」近乎恒真、**非**有效护栏。v1 规模（~445 product、闭包 **~35 行**、~13 节点）下**可接受**（sub-ms）。EXPLAIN 计划测试的**有效护栏**是：先 `ANALYZE` 钉死统计态，断言 `category_closure` 与 `unit_price` 均 `SEARCH ... USING INDEX`（被探表不退化为 SCAN），**允许** temp B-tree 与驱动表（`product`/`product_tag`）全扫；**不**断言「从 closure/product_tag 驱动」（随 ANALYZE 漂移）。规模有界降级、非永久契约；目录增长时真正杠杆是**驱动表全扫**（可考虑索引 `product.rankable` / `product_tag.tag_id`），**非** `category_closure(ancestor_tag_id, tag_id)`：实测加它规划器**会**用于 closure 探查、但**不改驱动、无实质收益**，且会令 EXPLAIN 的命名索引断言（closure 经 `..._tag_id_ancestor_tag_id_unique`）失败 → v1 **不加**。
- 实现复用 `buildRankingsQuery` 思路（单一 query builder 源，供 EXPLAIN 计划测试取 `.toSQL()`），扩展出带闭包 JOIN 的变体；**节点榜与 `rankableCount` 共用同一过滤片段**（见 D4）；per100ml/formula/confidence/warnings **取存储值不重算**，warnings 经 `decodeJson` + `WarningsSchema` 还原。

### D4：`GET /categories` 品类树浏览
- 响应：`{ nodes: CategoryNode[] }`，每节点 `{ slug, name, parentSlug, comparableUnit, rankable, rankableCount }`：
  - `comparableUnit`：经 is-a 继承解析（节点自身→沿 parent 找最近非空祖先），软饮全线 = `per_100ml`、酒类/root = `null`。**批量内存解析**：一次 `SELECT` 全部 kind=category 节点 + 内存沿 parent map 解析，**不**逐节点串行调按 `parent_id` 往返的 `resolveComparableUnit`（D1 上 O(节点×深度) 次往返）。
  - `rankable`（**节点自身是否一个排序轴**）：`comparableUnit !== null`。`soft-drink` 父节点与软饮叶 = true；root `beverage`/酒类 = false。**仅**供「自身无可比轴」展示态（如轴标灰显）。
  - `rankableCount`（**闭包后代可排名数，与节点 `rankable` 正交**）：该节点闭包下 `rankable=true ∧ per100ml 非空` 的成员数（数据门列由成员轴定、v1 一律 per100ml，含 root）。**关键**：root `beverage` 虽 `rankable=false`，其闭包含可排名软饮 → `rankableCount > 0`（= 默认 /rankings 榜基数）；唯酒类子树（闭包无可排名成员）= 0。**禁止**把「节点 rankable=false」推成「count=0」（Codex round-1 blocker）。
  - **消费契约：榜入口判定用 `rankableCount > 0`、不用 `rankable`**——root（rankable=false ∧ count>0）是默认榜、必须可点进；下游若用 `rankable` 决定是否展示榜入口会误隐藏 root。`rankable` 只管轴标灰显。此契约在 API 层钉死（miniapp 接通虽非目标，但防 MAJOR 类回归上移）。
  - **count 与节点榜共用同一过滤片段 + unit_price 1:1 前提**：`rankableCount` = 在 D3 过滤 builder 片段上 `COUNT(DISTINCT product.id)`，节点榜 = 同片段 `SELECT DISTINCT unit_price.id ... ORDER BY...LIMIT`。两者基数相等**依赖既有不变量 `unit_price` 与 `product` 1:1（`unit_price_product_id_unique`）**——此为「逐字一致」唯一承重前提，须显式成立（实测：注入双叶违例下 `COUNT(DISTINCT product.id)` 仍 == 去重榜长）。两者**禁止**各自手写谓词（防「树里 N ≠ 点进去 N」漂移）。树 ~13 节点，逐节点 count 成本可忽略；未来可一次 GROUP BY 聚合替代。
- 只读、治理豁免；Zod `CategoryTreeResponseSchema` 居 `@unit-price/api-client`、与小程序共依赖、types 推导。
- **不暴露 attribute/brand/product_line 轴**：本接口只透 category is-a 树（导航用）。
- **未 seed 退化**：DB 已连但无 category 行 → `200 { nodes: [] }`，不报错。

### D5：参数与错误语义（与 `/rankings` 既有口径对称）
- `category`：缺省 `beverage`（root）；present 时**必须**精确匹配 seed 的 **kind=category 节点 slug**（大小写敏感）。
- **校验集单一来源、编译期派生（强制）**：移除部署中的 `category: z.enum(['beverage'])`，改校验「seed 品类树 kind=category slug 全集」，该集**单一来源、编译期**派生自 `CATEGORY_NODES`、纯同步 parse；**禁止** `apps/api` 手写 slug 枚举（与 seed 漂移），**禁止**改用运行期查 `tag` 表校验——运行期查表对「合法但未 seed 的 slug」与「拼写错误」都查无行、**无法满足**下条可区分要求；编译期集是唯一同时满足「单一来源 + 可区分 + 纯函数无新 500 分支」的方案。
- 未知 slug、空串、非 category 的 slug（attribute/brand）→ `400 invalid-request`。**但**属 seed 全集的合法 slug 即便 DB 暂无对应 tag 行（迁移先于 seed 窗口）→ `200 []`（闭包零命中），**不**误报 400——拼写错误与未 seed 可区分。
- 已知但不可排名的节点（酒类子树，`rankable=false`）→ `200 + []`（资格门自然产出空榜，**不**报错）。
- `limit/offset`：完全沿用 `rankings-api` 既有严格 parse（`^\d+$`、limit clamp 200、非法 → `400 invalid-request`、offset 越界 → `200 []`）。
- 错误码复用既有集（`invalid-request`/`persistence-error`/… ），不新增、语义不冲突；两端点 DB 失败均沿用 `persistence-error`（500）。

### D6：schema 与包归属
- `CategoryTreeResponseSchema` 新增于 `@unit-price/api-client`，`apps/api` 与小程序共依赖同一份。`RankingsResponseSchema` **不变**（节点榜复用之）。SDK `RankingsQuery.category` 已存在且 `buildRankingsUrl` 已序列化（tasks 1.3 仅核验、非新增）。
- **api-client 是 transport-agnostic**（只建 URL + 校验响应、自身不发请求；各端自带 transport）。`/categories` 助手须**对齐既有 `buildRankingsUrl` + `parseRankingsResponse` 形态**：新增 `buildCategoriesUrl(base)` + `parseCategoryTreeResponse(json)`（**签名只接 `json`、内部硬编码 `{ jitless: true }`**，与 `parseRankingsResponse` 一致——**不**把 jitless 外露，防漏传致 weapp eval 禁用下崩溃），**禁止**新增会发 HTTP 的 `getCategories()`（破坏 transport-agnostic 契约）。SDK `RankingsParams.category` 保持 `string`、不窄化为 seed 枚举（seed 集在 `packages/db`、非 api-client 依赖；值合法性由服务端 400 兜底）。
- `packages/db/repository` 新增两读方法：按节点取榜（D3）、品类树+每节点 rankableCount（D4），二者共用同一过滤片段。`apps/api` 路由编排参数校验 + 调 repository + 投影 `rank`。
- **既有注释/测试须随改**：`repository.ts` 的 `ListRankingsInput.category` JSDoc 与 `buildRankingsQuery` 内「category 是 no-op、不下推（下推会废 per100ml 索引）」注释（约 176-183、416-421）在 category 下推后成为反话，**必须**改写；P2 扁平榜的 EXPLAIN 测试断言（断言主驱动走 per100ml 索引）**必须**替换为节点路径的计划形状断言（见 D3）。

## 风险 / 权衡

- [默认 `/rankings` 行为收紧——已上线小程序榜单 Tab 无参调用，结果从「全部 per100ml」变「root 下 rankable 成员」] → 这是**有意收敛**（同时修正酒类按容量轴混入）。但收紧落在**线上主消费面**，须**量化 + 验证**而非只声明（见 tasks 4.3）：**阻断门 = 生产「`per100ml` 非空 ∧ `rankable=0` ∧ 无 kind=category 叶」（待人工∨待细化、可能含软饮）计数非零**——而非「总掉项规模」（总规模含正确排除的酒类、仅报告用）；非零则先补 backfill/规则再依赖此门（本期只读 rankable、不改其口径）；并 devtools 实测无参主页 Tab。`rankable` 列存量默认 0、靠 backfill 重算，故「backfill 跑到耗尽」≠「软饮全有叶」，须实测该阻断门计数。
- [rankable=true 但 per100ml=null 的边角（分类为软饮但规格不可算）] → 数据门「单价列非空」兜住，不进榜；与既有口径一致。
- [闭包 JOIN 改变查询计划——节点路径不走 per100ml 索引、驱动表全扫 + temp B-tree 排序（已 EXPLAIN 实测）] → v1 数据量小（sub-ms）可接受；EXPLAIN 计划测试守住的**有效护栏**是「`category_closure` 与 `unit_price` 均 `SEARCH...USING INDEX`（被探表不退化为 SCAN）」、先 `ANALYZE` 钉死统计态（非「主序走索引」——对节点路径不成立；非「不出现 SCAN unit_price」——近乎恒真无效）；规模有界、非永久契约，成员显著增长须重评（届时杠杆是驱动表 `product`/`product_tag` 全扫、可索引 `product.rankable`/`product_tag.tag_id`，**非** `category_closure(ancestor_tag_id,tag_id)`——实测它会被用于 closure 探查但不改驱动/无收益、且会破坏 EXPLAIN 命名索引断言，故 v1 不加）。
- [`rankableCount` 与节点榜两查询漂移] → 强制共用同一过滤 builder 片段（D4），并以单测断言 count==节点榜基数（含 root/父/叶/酒类）守住。
- [`rankableCount` 逐节点子查询] → 树仅 ~13 节点，可接受；如未来树膨胀，可一次性闭包聚合替代。
- 合规：纯读既有库，不触抓取/众包敏感面（architecture 第七节风险分层无新增暴露）。

## 迁移计划

- 无 DB schema 迁移（复用既有表/索引）。
- 部署：含代码 → feature 分支 + PR；合并 main 自动部署 prod（GH Actions migrate+deploy，本期无新迁移）。
- 回滚：纯增量读路径 + 一处参数语义升级；回滚即还原 `category` 为 no-op、移除 `/categories`，无数据副作用。

## 待解决问题

- attribute cohort 求交（无糖碳酸等）口径与是否并入节点榜参数 → 留 v2，本期非目标。
- 扁平「全部 per100ml（含 rankable=false）」视图是否仍需保留为独立 debug 入口 → 暂判不需要（收敛后由树接口的 rankableCount + 节点榜覆盖消费场景）。
