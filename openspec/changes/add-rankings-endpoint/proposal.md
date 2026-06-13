## 为什么

简版山姆比价小程序的定位是**只读榜单浏览**（本期不做录入/扫码），它的主消费接口是 `GET /rankings`。生产 D1 已经躺着现成的高质量数据源：445 个 product、其中 **329 条 per100ml 已算、confidence 0.95**，全部山姆饮料，最便宜真实单价 0.22 元/100ml（MM 饮用水 4L）。但当前服务端只有 `/health /parse /contribute /ingest /ingest/batch`，**没有 `/rankings`**——这是把简版小程序排期提前的**唯一后端阻塞**。

本变更只补这一个后端能力：把已落库的 per100ml 计算结果按真实单价升序暴露成一张榜单。数据和计算都已就绪，无需重算、无需迁移、无需 LLM。对齐 `docs/taxonomy-and-tagging.md` §七「v1 排名只支持 per_100ml 节点（软饮全线）」的既定范围。

## 变更内容

- 新增 `GET /rankings`：从既有 `unit_price ⋈ product ⋈ product_raw` 读取，过滤 `per100ml IS NOT NULL`，按 per100ml **升序**（最便宜真实单价排第一）分页返回。复用已存在的 `unit_price_per100ml_idx` 索引排序，**直接取存储值**（per100ml/formula/confidence/warnings），不重算。
- 查询参数最小化：`limit`（默认 50、上限 200）+ `offset` 分页；`category` 可选但本期只接受 `beverage`（留作未来过滤位）。
- 响应用 **Zod schema 作为单一事实源**（`RankingsResponseSchema`，types 推导、server 校验、未来 SDK 共用一份），每项含 `rank / title / priceCents / per100ml / formula / confidence / warnings / store / storeSku / sourceUrl`（`formula` 透出留痕、可回放；`priceCents` 与 `per100ml` 口径不同不可互推）。
- `warnings` **原样透出**（尤其「数量按单件推断为 1」）：329 条里有 243 条用了单件推断，个别无显式件数的多件装会高估 per100ml（实测最高 889.9/100ml）。榜单**不静默过滤**这些项，而是把 warning 带到响应里，让前端能标注可信度/反套路徽标——「明确告诉用户哪些项不那么可靠」是专业感而非缺陷。
- `GET /rankings` 定位为**公开只读端点**，归入 api-governance 既有「集外、治理豁免」一类（与 `/health` 同性质，区别于受保护写/解析端点），无需 API key。

## 功能 (Capabilities)

### 新增功能
- `rankings-api`: `GET /rankings` 的请求/响应契约——数据源、排序与过滤（per100ml 非空、升序）、分页参数与边界、响应 schema（含 rank 与原样 warnings）、空库/越界行为、只读公开语义。

### 修改功能
- `api-governance`: 明确把 `GET /rankings` 归为**受保护端点集合之外的公开只读端点**（豁免鉴权/限频/用量，理由同 `/health`），消除「新读端点是否应被治理」的歧义。受保护端点集合 `{/parse, /contribute, /ingest, /ingest/batch}` 的既有行为不变。
- `persistence`: 新增 repository 只读契约 `listRankings`（按 `per100ml` 升序、`unit_price.id` 次级 tiebreak 分页，`per100ml IS NOT NULL` 过滤，投影取存储列不重算、`warnings` 经 `decodeJson` 还原为 `string[]`，`confidence` 取 `unit_price.confidence` 权威列）。既有方法语义与既有表结构不变；固化榜单查询依赖的 `unit_price_per100ml_idx` 与读投影的校验口径。
- `contribute-ingest`: 修订「本能力不含读出与对比」需求——既有场景断言「不存在 `/rankings`」，本变更将 `/rankings` 作为**独立只读端点**（`rankings-api`）引入，故收窄该断言为「写入端点不内联读出/对比；`/rankings` 由独立只读端点承载；`/corrections`/`/compare` 仍不存在」，避免归档后主 spec 自相矛盾。

## 影响

- **apps/api**：新增 `GET /rankings` route + handler（读 repository，无写入、无 LLM、无后台任务）；`packages/db` repository 增一个只读查询方法 `listRankings`（按 per100ml 升序、`unit_price.id` 次级分页 join 取榜）。
- **schema**：`RankingsResponseSchema`（Zod）**与既有 `ParseResponseSchema`/`IngestResponseSchema` 落点一致**——现居 `apps/api/src/routes.ts`、经 `index.ts` 再导出；`packages/api-client` 共享包尚未建，待其提取时再迁共享层（届时 app 与 SDK 共依赖同一份）。
- **合规面**：不触碰抓取/众包敏感面——纯读已沉淀的众包数据，无新数据采集。
- **非目标（本期不做）**：per_100g/重量轴榜单（v2；且生产里重量品是陈旧 null，属另一个 backfill 迁移变更）；category 树 / tag 表 / 对比组动态查询（taxonomy §九，v2）；录入/扫码、`/compare`、`/corrections`；`apps/miniapp` Taro 前端骨架（后续独立变更）。
