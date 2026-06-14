## 1. 共享 schema 与 SDK（packages/api-client）

- [x] 1.1 新增 `CategoryTreeResponseSchema`（Zod，单一事实源）：`{ nodes: { slug, name, parentSlug(nullable), comparableUnit(nullable), rankable(boolean), rankableCount(int>=0) }[] }`，types 从中推导并导出；`RankingsResponseSchema` 不变。
- [x] 1.2 新增 **transport-agnostic** SDK 助手（**对齐既有 `buildRankingsUrl` + `parseRankingsResponse` 形态——api-client 只建 URL + 校验响应、自身不发请求**，各端自带 transport：miniapp `Taro.request`、web/插件 `fetch`）：`buildCategoriesUrl(base)`（纯 URL 序列化 → `<origin>/categories`，复用 `buildRankingsUrl` 的 clean-origin fail-fast 校验；`/categories` 无查询参数）+ `parseCategoryTreeResponse(json)`（**签名只接 `json`、内部硬编码 `{ jitless: true }`**，与 `parseRankingsResponse(json)` 形态一致——**禁止**把 `jitless` 外露为入参，防调用方漏传致 weapp eval 禁用下 JIT 崩溃）。**禁止**新增会发 HTTP 的 `getCategories()`（会破坏 api-client 的 transport-agnostic 契约）。
- [x] 1.3 **核验既有**：`RankingsQuery.category` 与 `buildRankingsUrl` 的 `category` 序列化**已存在**（`client.ts`）——本项仅确认现状、非新增 SDK 表面（默认不传即服务端缺省 `beverage`）。
- [x] 1.4 api-client 单测：`CategoryTreeResponseSchema` 解析正例（含 root `rankable=false`/软饮叶/酒类节点）与反例（缺字段、类型错）；jitless 解析路径覆盖。

## 2. 持久化读查询（packages/db，无 schema 迁移）

- [x] 2.1 新增「按品类节点取榜」查询（扩展 `buildRankingsQuery` 思路、单一 query builder 源）：`unit_price ⋈ product ⋈ product_raw ⋈ product_tag ⋈ category_closure`，`WHERE product.rankable=1 ∧ unit_price.per100ml IS NOT NULL ∧ category_closure.ancestor_tag_id = :nodeTagId`，**`SELECT DISTINCT` / 按 `unit_price.id` 去重兜底**（防双叶重复，对齐 `listProductIdsInCategoryNode`），`ORDER BY per100ml ASC, unit_price.id ASC`，`limit/offset`；per100ml/formula/confidence/warnings 取存储值不重算，warnings 经 `decodeJson` + `WarningsSchema` 还原。把闭包+rankable+per100ml 的**过滤片段抽成可复用 builder**，供 2.2 计数共用。
- [x] 2.2 新增「品类树 + 每节点 rankableCount」读查询 `listCategoryTree`：**一次查询**载入全部 kind=category 节点 + **内存** parent map 解析 `comparableUnit` 继承（**不**逐节点串行调 `resolveComparableUnit`，避免 D1 上 N+1 往返）；`rankable = comparableUnit !== null`（节点自身轴标记）；`rankableCount` = 在 2.1 的**同一过滤片段**上 `COUNT(DISTINCT product.id)`（**禁止**另写谓词）。**rankableCount 语义**：计闭包后代可排名数、与节点 `rankable` 正交——root `beverage`（rankable=false）的 count 须 `>0`（= 默认榜基数）、唯酒类子树 count=0。
- [x] 2.3 EXPLAIN 计划测试（口径见 `rankings-api`「节点路径的查询计划口径」节，已对实际 schema 实测）：经 `.toSQL()` 对 2.1 生产 query，**先 `ANALYZE`**（与既有 P2 测试一致、钉死统计状态防 flaky），断言**有效护栏**——`category_closure` 与 `unit_price` 均为 `SEARCH ... USING INDEX`（分别经 `category_closure_tag_id_ancestor_tag_id_unique` / `unit_price_product_id_unique`），即被探表不退化为 `SCAN`；**允许** `USE TEMP B-TREE FOR ORDER BY` 与 `FOR DISTINCT`、**允许**驱动表 `product`/`product_tag` 全扫（小表、有意接受）。**断言方式：按表 substring 匹配**（如 plan 文本含上述两条 `SEARCH...USING INDEX` 行）、**不做整计划等值/行数断言**——post-`ANALYZE` 计划含 `BLOOM FILTER`、覆盖索引探查等会变动的行。**不要**断言「从 closure/product_tag 驱动」（随 ANALYZE 在 `SCAN p`↔`SCAN pt` 漂移、不稳定）或「不出现 `SCAN unit_price`」（该 join 形状下近乎恒真、无效护栏）。
- [x] 2.4 repository 单测（脏数据 fixture）：碳酸叶节点只命中碳酸成员、软饮父节点经闭包含各子叶成员、酒类节点返回空（rankable 门）、合法 slug 但 DB 无该 tag 行返回空（非报错）、**单归属违反（同商品双叶）仍至多一行（DISTINCT 兜底）**、`rankableCount` 与对应节点榜基数逐节点相等（**含 root>0、父节点、叶、酒类=0**）、无可排名成员节点 count=0。

## 3. apps/api 路由

- [x] 3.1 升级 `GET /rankings` 的 `category` 校验：**移除现 `RankingsQuerySchema` 的 `category: z.enum(['beverage'])`**，改为校验「seed 品类树 kind=category slug 全集」，该集**单一来源、编译期派生自 `packages/db` 的 `CATEGORY_NODES`**、纯同步 parse（**禁止** apps/api 手写第二份 slug 枚举；**禁止**改用运行期查 `tag` 表校验——无法区分「未 seed 合法 slug」与「拼写错误」）。匹配 → 解析为 `nodeTagId` 调 2.1；未知/非 category/空串 slug → `400 invalid-request`；**属全集但 DB 无该 tag 行 → `200 []`**（不误报 400）；缺省 `beverage`（root）；`limit/offset` 沿用既有严格 parse；投影 `rank = offset + 序号`；DB 失败沿用 `persistence-error`（500）。
- [x] 3.2 新增 `GET /categories` 路由：调 2.2，输出经 `CategoryTreeResponseSchema`；**只读、治理豁免**——挂载方式对齐 `/rankings`（确认不挂 admin gate、不计入固定窗口限频、不触 LLM/后台/出站）；DB 失败 `persistence-error`、未 seed → `200 {nodes:[]}`。
- [x] 3.3 路由单测（apps/api）：
  - `/rankings`：**无参 ≡ category=beverage ≡ root tag 闭包**（且为旧扁平榜真子集、rankable=false 行不再现）、闭包命中子叶、父节点闭包含子叶、酒类节点 `200 []`、未知/`Beverage`大小写/空串/非 category slug → `400`、合法 slug 但未 seed → `200 []`、`limit` clamp 200、`offset` 越界 `200 []`、非法 limit/offset → `400`、空库 `200 []`、相同 per100ml 分页稳定、rankable=false（待人工软饮/酒类）不入榜、per100ml/formula 取存储值不重算。
  - `/categories`：返回全 category 树且不含 attribute/brand/product_line 轴、`soft-drink` 父节点 `per_100ml`/`rankable=true`、软饮叶继承 `per_100ml`/`rankable=true`、酒类与 root `comparableUnit=null`/`rankable=false`、**root rankableCount>0=默认榜基数**、酒类 rankableCount=0、`rankableCount` 与节点榜基数一致、空节点 `count=0`、未 seed → `{nodes:[]}`。

## 4. 既有注释/测试随改 + 文档

- [x] 4.1 改写 `packages/db/src/repository.ts` 中 `ListRankingsInput.category` JSDoc（约 176-183）与 `buildRankingsQuery` 内「category 是 no-op、不下推因会废 per100ml 索引」注释（约 416-421）——category 下推后这些注释成反话；**替换** P2 扁平榜 EXPLAIN 测试中「主驱动走 per100ml 索引」断言为节点路径计划形状断言（同 2.3）。
- [x] 4.2 `docs/taxonomy-and-tagging.md` §七/§九：标注 `rankable` 已接入 `/rankings`、两套入榜判据 P3 已收敛为合取（数据门列随节点轴）；`docs/architecture.md` 的 `/rankings`「按品类取榜单」补 `/categories` 品类树浏览接口。
- [ ] 4.3 **合并前数据就绪门（线上主消费面保护，含 backfill-gap 甄别）**：查生产两个**可执行**计数——
  - (A) 总掉项规模 = `unit_price.per100ml IS NOT NULL ∧ product.rankable=0` 的 `product` 行数（默认榜相对 P2 扁平榜静默掉的项，仅报告用）；
  - (B) **backfill-gap 子集（阻断门）** = (A) 中**未拿到任何 kind=category 叶 `product_tag` 的行**，即 `per100ml IS NOT NULL ∧ rankable=0 ∧ 该 product 无 kind=category 叶 product_tag`（= 三态中「待人工」`pending IS NULL` ∨「待细化」`pending IS NOT NULL`，二者皆无叶）。**此谓词同时覆盖待人工与待细化**——故**不要**写成 `pending_category_tag_id IS NOT NULL`（那会漏掉 `pending IS NULL` 的待人工软饮、留空洞）。有叶且 rankable=0 者必是酒类等非软饮叶（正确排除）、不计入 (B)。
  - **合并阻断门 = (B) 非零**（而非 (A) 的原始大小）：(B)>0 说明仍有未分类、可能含软饮的行（rankable 列未就绪），应先补 backfill/规则再合并（本期只读 rankable、不改其口径）。memory 记 prod backfill 跑到 `nextCursor=null`，预期 (B)≈0——但须实测确认、非假设。
  - 合并后 devtools 实测小程序**无参**主页 Tab 渲染收敛后榜（确认 `useRankings` 无 category 的默认路径正常）。
- [ ] 4.4 主 spec 同步留到归档：实现合并后经 `/opsx:archive`（或 `/opsx:sync`）把**五份**增量并入/新建主 spec——MODIFIED 并入 `rankings-api` / `category-tagging` / `persistence`，ADDED 并入 `api-client`，新建 `category-tree-api` 主 spec。
- [ ] 4.5 **（归档硬门、阻断式、独立勾项防漏）`category-tagging` 主 spec 需求标题更名**：把被改需求标题从 `rankable 派生、归属变化必重算、且本期不接入 /rankings` **机械更名为** `rankable 派生、归属变化必重算、且已接入 /rankings 作资格门（P3 收敛）`。原因：本变更的 MODIFIED 增量**必须**保留原标题逐字相同才能匹配并替换主 spec 正文（OpenSpec 按标题匹配；改增量标题会令其匹配失败 → 正文不被替换、旧「不接入」需求残留 + 产生重复，反更糟），故标题更名**只能**在归档/sync 那一步对主 spec 做、不能提前到增量里。**此更名是归档 PR 的阻断门**：归档 PR **不得合并直到**主 spec 该标题已逐字更名为上述目标（与正文「已接入」一致）；漏改即留下与正文字面相悖的标题——**禁止**带病合并。

## 5. 非本变更范围（记录、不在此做）

- [ ] 5.1 （非目标）`apps/miniapp` 分类树 Tab 接通 `/categories` + 节点榜、及 `ScopeBar.tsx:10-12` 旧入榜判据注释更新 → 留待后续小程序接通变更（本期只定 API 契约，miniapp 接通是声明非目标）。
