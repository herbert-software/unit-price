## 为什么

P2 已落地 store-agnostic 品类树（`tag` / `product_tag` / `category_closure` / `store_category_map`）、确定性打标签管线与 `product.rankable` 派生列，且存量 backfill 已在生产跑到 `nextCursor=null`——生产现已有「叶 category 标签 + 闭包 + rankable」就位，但**无任何读路径消费它**。现有 `GET /rankings` 仍是一张扁平全局榜：`category` 参数是 v2 占位 no-op（仅接受 `beverage`），入榜判据是 `per100ml IS NOT NULL`、**不读 `rankable`**。

这有两个后果：① 小程序「分类树」Tab（产品形态已拍板的 3-Tab 之一）拿不到品类树结构、也无法按品类节点取榜；② 一个有 per100ml 的葡萄酒（`comparable_unit=null`、`rankable=false`）目前仍会混进扁平榜，按容量轴排序酒类在语义上是错的。P2 已显式把「`rankable` 接入榜单」与「两套入榜判据收敛」划给 **P3**——本变更即兑现 P3。

## 变更内容

- 新增 `GET /categories` 品类树浏览接口：返回 store-agnostic 品类 is-a 树（节点 slug / 名称 / 父节点 / 经继承解析的 `comparable_unit` / `rankable` 可排名标记 / 该节点闭包下「可排名」成员数），供小程序分类树 Tab 渲染导航与隐藏空/不可排名节点。只读、治理豁免（同 `/rankings` 家族）。
- **BREAKING（行为）**：把 `GET /rankings` 的 `category` 参数从「仅接受 `beverage` 的占位 no-op」升级为**真实 taxonomy 品类节点过滤**：值为 seed 的 kind=category 节点 slug（默认 `beverage` = 饮料 root），经 `product_tag`(叶) JOIN `category_closure`(祖先=该节点) 做闭包命中，入榜判据收敛为 **`rankable=true ∧ per100ml IS NOT NULL`**，仍按 `per100ml` 升序、复用同一 `RankingsResponse` 与 `limit/offset` 分页。
- 完成 P2 遗留的**两套入榜判据收敛**：`rankable` 成为品类作用域榜单的权威「资格门」，`per100ml IS NOT NULL` 退为「数据可得门」，最终入榜 = 二者皆真。酒类子树（`rankable=false`）经此门**自然产出空榜**、不再需要特判；待人工/待细化软饮（`rankable=false`）也不再混入。
- 新增 Zod `CategoryTreeResponseSchema`（居 `@unit-price/api-client`，与小程序共依赖），types 从中推导。

## 功能 (Capabilities)

### 新增功能
- `category-tree-api`: `GET /categories` 只读品类树浏览接口——透出品类 is-a 树结构、各节点经继承解析的 `comparable_unit`、节点自身轴标记 `rankable`、与闭包可排名成员数 `rankableCount`；客户端用 `rankableCount>0` 决定是否展示榜入口（含 root，其 `rankable=false` 但 `rankableCount>0`）、用 `rankable` 仅决定轴标灰显；响应 schema 用 Zod 单一事实源，供小程序分类树 Tab 消费。

### 修改功能
- `rankings-api`: `category` 参数由 v2 占位 no-op 升级为真实品类节点过滤（闭包命中）；入榜判据由 `per100ml IS NOT NULL` 收敛为 `rankable=true ∧ per100ml IS NOT NULL`（数据门列随节点轴）；未知/非 category slug 返回 `400 invalid-request`，已知但不可排名节点（如酒类）自然返回 `200 + []`。排序/分页/响应字段不变。
- `category-tagging`: 解除「`rankable` 本期不接入 `/rankings`、两套判据收敛留 P3」的 carve-out——本变更使 `rankable` 成为榜单权威入榜门，明确收敛口径。
- `persistence`: P3 把 repository 榜单查询从 P2 的「`category` 不下推、`per100ml IS NOT NULL` 唯一判据、不读 `rankable`、主序走 `unit_price_per100ml_idx`」改为「`category` 下推为闭包过滤 + `rankable` 门 + `DISTINCT` 兜底 + 节点路径新查询计划口径」，并新增「品类树 + 每节点 `rankableCount`」只读查询契约。
- `api-client`: 新增传输无关的 `/categories` 契约（`CategoryTreeResponseSchema` + `buildCategoriesUrl` + `parseCategoryTreeResponse`，与既有 rankings 三件套同构）。

> 范围说明：以上 1 新增 + 4 修改/扩充增量是**同一个 P3「品类树榜」能力跨层的契约面**——SDK 契约（`api-client`）、HTTP 契约（`rankings-api` / `category-tree-api`）、持久层查询契约（`persistence`）、与使其成立的 rankable 收敛（`category-tagging`）相互绑定、无法各自单独成立（如 `rankableCount` 必等于节点榜基数的跨端点不变量贯穿 persistence→category-tree-api），故合为一个聚焦变更，未跨 Phase 混做。

## 影响

- `apps/api`：新增 `GET /categories` 路由；改 `GET /rankings` 的 `category` 参数解析与查询（注入闭包 JOIN + `rankable` 门）。仍**只读**：禁写、禁 LLM、禁后台任务、禁出站 fetch。
- `packages/db`：`repository` 新增「按品类节点取榜」查询（闭包 + rankable + per100ml 过滤、per100ml 升序、`unit_price.id` 次级键）与「品类树 + 每节点可排名成员数」读查询；复用既有 `category_closure` / `product_tag` / `tag` 表，无 schema 迁移（小数据量，复合索引为可选优化、非本期必需）。
- `packages/api-client`：新增 `CategoryTreeResponseSchema` 并导出 types；`RankingsResponseSchema` 不变。
- `apps/miniapp`：分类树 Tab 可接通（接入本身不在本变更范围，见非目标）。
- **客户端兼容（破坏性、需数据就绪门）**：默认 `/rankings`（无参 = `category=beverage` root）行为变化——从「全部 per100ml 非空」收紧为「饮料 root 下 rankable 成员」，落在已上线小程序主页榜单 Tab。此收紧同时修正「酒类混入容量榜」的语义错误，属预期收敛；但「backfill 跑到耗尽」≠「软饮全有叶」（待人工/待细化软饮 rankable=false 会掉出）。**合并阻断门 = 生产「`per100ml` 非空 ∧ `rankable=0` ∧ 无 kind=category 叶」(待人工∨待细化、可能含软饮) 计数非零**（而非总掉项规模——总规模含正确排除的酒类、仅作报告）；非零则先补 backfill/规则；合并后 devtools 实测无参主页榜（见 tasks 4.3）。
- **合规**：不触抓取/众包敏感面（纯读既有库）。

## 非目标

- 不做 attribute 轴 cohort 过滤（无糖/气泡 与品类闭包求交，如「无糖碳酸」）——原子标签动态求交是自然后续，本期只做 category 闭包节点榜。
- 不引入 `per_100g` / `per_100sheet` 计算或纸品/重量品入榜（v2 占位，core 本期仍只产 per100ml）。
- 不动 tier1/tier2/tier3 解析与打标签管线；不重跑 backfill、不改 `rankable` 派生口径（只**读**它）。
- 不为扁平榜加游标分页（`limit/offset` 固有翻页漂移降级沿用 P2 既定）。
- 不激活 store-map（无 ingest native-id 字段，沿用 P2 惰性边界）。
- 不做 eval「品类标签准确率」维度（属 eval-harness 的独立 v2 新增需求）。
- 不做跨店同款匹配。
