## 1. 响应 schema（Zod 单一事实源）

- [x] 1.1 在 `apps/api/src/routes.ts` 定义 `RankingsItemSchema` 与 `RankingsResponseSchema`（Zod，落点与既有 `ParseResponseSchema`/`IngestResponseSchema` 一致——本仓 schema 现居 `routes.ts`、经 `index.ts` 再导出；`packages/api-client` 尚未建）：每项 `rank`(int≥1) / `title`(非空 string) / `priceCents`(int) / `per100ml`(number) / `formula`(非空 string) / `confidence`(number) / `warnings`(string[]) / `store`(非空 string) / `storeSku`(非空 string) / `sourceUrl`(nullable)；`store`/`storeSku`/`title` 对齐 `product_raw` 的 NOT NULL 列（非 optional），`sourceUrl` 对齐可空列；types 从 schema 推导
- [x] 1.2 定义查询参数 schema `RankingsQuerySchema`：`limit`/`offset` **仅接受十进制非负整数串**（present 时先用 `^\d+$` 正则把关、再转数字校验，**键缺失**才走 default）——**禁用宽松 `z.coerce.number()`**（它把 `""`→0、`"0x10"`→16、`" 5 "`→5 等非规范输入悄悄接受）。`limit`：缺省 50；present `>200` clamp 到 200、`=0` 或不匹配 `^\d+$`（空串/hex/含空白/负/小数）→拒。`offset`：缺省 0；不匹配 `^\d+$`→拒（与 limit 对称，消除「空 limit 拒、空 offset 静默当 0」不一致）。`category`：`z.enum(['beverage']).default('beverage')`，大小写敏感、空串 `?category=`→拒。所有非法值映射到 `400 invalid-request` 的解析失败
- [x] 1.3 从 `apps/api/src/index.ts` 再导出 `RankingsResponseSchema` / `RankingsItem` / `RankingsResponse`（供未来 `packages/api-client` SDK 复用，当前消费方从 api 包导入）

## 2. 持久化只读查询（packages/db）

- [x] 2.1 在 `packages/db` repository 增只读方法 `listRankings({ limit, offset, category })`：`SELECT up.id, up.per100ml, up.formula, up.confidence AS confidence, up.warnings, pr.title, pr.price AS price_cents, pr.store, pr.store_sku, pr.source_url FROM unit_price up JOIN product p ON p.id=up.product_id JOIN product_raw pr ON pr.id=p.raw_id WHERE up.per100ml IS NOT NULL ORDER BY up.per100ml ASC, up.id ASC LIMIT ? OFFSET ?`，投影**必须显式限定 `up.confidence`**（`product` 与 `unit_price` 均有同名 `confidence` 列——取 `unit_price` 的最终权威 band，**禁取** `product.confidence` 解析中间值）；per100ml/formula/confidence/warnings 取存储列、**不重算**；`warnings` 列为 JSON-text，方法返回前**必须** `decodeJson` 还原为 `string[]`（复用 codec，与落库编码对称），**禁止**透出原始 JSON 串。**v1 不下推 `category` 谓词**：`category` 入参保留（v2 真品类预留），但 v1 SQL **不含** `AND product.category=?`——它在 v1 是 no-op（全 beverage）且经实测会令规划器弃 `unit_price_per100ml_idx`（见 2.2）；category 仅在 API 层校验（见 3.2）。`product` 表在本查询仅作 `unit_price → product_raw` 的 join 桥（不取其列）
- [x] 2.2 排序：主键 `up.per100ml ASC` + 二级键 **`up.id ASC`（同表列）** 保证同值分页稳定——**禁用跨表 `p.id`**（无法被该单列索引覆盖）。**允许**二级键 `up.id`（不在单列索引内）触发一次 `USE TEMP B-TREE FOR ORDER BY`——本期单列索引下属固有、数据量小可接受。**前提（实测）**：v1 SQL **不含** `product.category` 谓词（见 2.1）——含该谓词时 SQLite 规划器恒改以 `product` 驱动 + 全表 `SCAN product` + TEMP B-TREE、弃用 per100ml 索引；去掉后规划器选 `unit_price` 驱动并命中索引。**验收一（EXPLAIN，唯一断言项）**：对 `listRankings` **实际执行的 v1 SQL**（无 category 谓词、与生产同、**不加 `INDEXED BY`**）跑 `EXPLAIN QUERY PLAN`，断言主序/过滤**经 `unit_price_per100ml_idx`**（plan 含 `SEARCH ... USING INDEX unit_price_per100ml_idx`、**无对 `unit_price` 的全表 `SCAN`**）；**测试取 SQL 必须复用 `listRankings` 自身的查询 builder**（抽成共享构造函数，生产与测试同源 `.toSQL()`）、**禁止**在测试里手工重建一份等价查询——否则改了 `listRankings` 的 JOIN/WHERE/ORDER 而忘同步重建块时，EXPLAIN 会对旧 SQL 假绿；**不**断言「无 TEMP B-TREE」（二级键 `up.id` 不在单列索引内、其临时排序可接受，见 design D2）。极小 in-memory 表上规划器可能弃索引致断言假红——测试须用**足量样本或 `ANALYZE`** 让规划器选索引（`INDEXED BY` 仅作本地诊断、**禁止**写进生产 SQL，以免 EXPLAIN 与生产计划脱节造成 false-pass）。**验收二（非 EXPLAIN，独立项）**：「不把全量行载入应用内存再排序、不二次重算」是**应用层**不变量、EXPLAIN 不反映——由**代码审查/单测**单独确认 handler 不在 JS 侧二次 `sort`/重算，**不并入** EXPLAIN 断言
- [x] 2.3 单测（packages/db，纯 SQLite/内存）：升序正确、`per100ml IS NULL` 项被排除、同 per100ml 时按 `up.id` 稳定、limit/offset 切片、空库返回空、**传 `category='beverage'` 不改变 v1 结果（no-op，因 v1 不下推谓词）**；断言 per100ml/formula/warnings 为存储原值，**且 `confidence` 等于 `unit_price.confidence`、不等于 `product.confidence`**（构造两列不同值的样本，证未取错列）；EXPLAIN 断言见 2.2（足量样本 + ANALYZE，断命中 `unit_price_per100ml_idx`、无 `unit_price` 全表 SCAN）。**损坏 warnings 列 fail-closed 回归测试**：直接经底层 db 句柄绕过校验写一行 `warnings` 损坏值（如 `'not-json{'` 或 `'[1,2,3]'`），断言 `listRankings` **抛错**（fail-closed），**不**返回该行的原始 JSON 串、**不**静默丢行返回部分结果（锁定 persistence delta 的 fail-closed 契约）

## 3. /rankings route + handler（apps/api）

- [x] 3.1 在 `routes.ts` 注册 `app.get('/rankings', …)`：解析+校验 query（失败 → `400` + `invalid-request`，与既有错误码一致），调用 `repo.listRankings`，投影赋 `rank = offset + 序号`(1-based)，`RankingsResponseSchema` 校验后返回 `200`
- [x] 3.2 handler 保持只读：不写库、不调 LLM、不排后台任务；`category` 越界 → `400` `invalid-request`；`offset` 越界 → `200` + `[]`
- [x] 3.3 单测（`routes.test.ts`）覆盖 rankings-api 全部场景：升序榜、null 项不入榜、单件推断项带 warning 入榜、formula/per100ml 均取存储值（响应含 `formula` 且等于存储串）、limit clamp、**非法/非规范 limit/offset→400（含 `?limit=`/`?offset=` 空串、`?limit=0x10`、含空白、`?offset=1.5`、`-5`、`abc`——空 limit 与空 offset 对称拒；并断言 `?offset=0`→200、`?offset=100000` 越界→200+[]）**、未知/非精确 category(`alcohol`/`Beverage`/空串)→400、空库→空数组、同值分页稳定（同一快照内按 `up.id` 不重不漏）

## 4. 治理豁免（api-governance delta）

- [x] 4.1 确认 `/rankings` **不**挂 `governanceMiddleware`（不在受保护集合 `{/parse,/contribute,/ingest,/ingest/batch}`），与 `/health` 同为集外豁免；注意 Hono 精确路径匹配，避免被既有 `app.use` 误套
- [x] 4.2 单测：`GET /rankings` 不带 key → `200`，且不在 `GOVERNANCE_KV` 写限频/用量计数；同时验证受保护端点缺 key 仍 `401 auth-missing`（豁免不外溢）

## 5. 端到端校验

- [x] 5.1 `pnpm -r build && pnpm -r test` 全绿
- [x] 5.2 用生产形态样本（per100ml 升序、含单件推断 warning、含 per100ml=null 重量/酒类项）本地起 `apps/api` 跑 `GET /rankings`，确认契约：升序、rank 连续、`per100ml`/`formula`/`warnings` 原样、`confidence` 取 `unit_price` 值、null 项不出榜、分页边界符合 spec
