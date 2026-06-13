## 上下文

生产 D1（`unit-price-prod`）已落 445 product / 445 unit_price，其中 329 条 `per100ml` 非空、confidence 0.95，全部山姆饮料。`unit_price` 已有 `unit_price_per100ml_idx`（REAL 升序索引），schema 注释明言其为「future per-100ml rankings」预留——榜单的存储与索引基础已就位。当前服务端缺的只是把这批已算结果暴露出去的只读端点。

读路径与既有写路径（`/contribute`/`/ingest`）共用 `packages/db` 的 `createRepository`。`apps/api` 既有治理中间件（鉴权/限频/用量）只挂在受保护端点集合 `{/parse, /contribute, /ingest, /ingest/batch}`，`/health` 显式豁免整条治理链。

## 目标 / 非目标

**目标：**
- 提供 `GET /rankings`：over 既有 `unit_price ⋈ product ⋈ product_raw`，`per100ml` 非空、升序、分页，**直接取存储值不重算**。
- 响应契约用 Zod schema 单一事实源；现居 `apps/api/src/routes.ts`、经 `index.ts` 再导出（与既有 `ParseResponseSchema` 同落点），待 `packages/api-client` 提取后 SDK 共依赖同一份。
- 把 `warnings`（尤其单件推断）原样透出，让前端能标注可信度，不静默过滤可疑高价项。
- 明确 `/rankings` 为公开只读端点，治理豁免（同 `/health`）。

**非目标：**
- per_100g/重量轴榜单（v2）。生产里重量品是陈旧 null，要救得走另一个 backfill 迁移变更，不在本期。
- category 树 / tag 表 / 对比组动态查询（taxonomy §九，v2）；本期 `category` 只接受 `beverage` 单值过滤。
- `/compare`、`/corrections`、录入/扫码、Taro 前端骨架。

## 决策

**D1：榜单读存储值，绝不重算。** per100ml/formula/confidence/warnings 全部取 `unit_price` 已落的列。理由：①「计算留痕」要求公式可回放，重算会与落库时的 formula 漂移；② core 是纯函数无 IO，重算属客户端/解析期职责，读端只做投影；③ 性能——升序分页走索引即可，无需把 core 拉进读路径。*备选*：读时用 core 重算——否决，违背留痕一致性且无收益。

**D2：排序与过滤在 SQL 层，tiebreak 用同表列，v1 不下推 category。** `WHERE per100ml IS NOT NULL ORDER BY per100ml ASC, unit_price.id ASC LIMIT ? OFFSET ?`，主排序走 `unit_price_per100ml_idx`（单列 per100ml，REAL 数值序）。`rank` 由 `offset + 行序`（从 1 起）在投影时赋值，不落库。**次级 tiebreak 必须用 `unit_price.id`（与 per100ml 同表）、不用 `product.id`**：跨表 tiebreak 无法被该单列索引覆盖、会迫使临时 B-树排序，削弱「走索引 + 分页稳定」的同时成立。

**实测修正（实现期发现，反推 spec）**：原设想「保留 `AND product.category=?` 过滤 + 走 per100ml 索引」**经 SQLite EXPLAIN 实测不成立**——只要含 category 等值谓词，规划器恒改以 `product` 为驱动表（全表 `SCAN product`）+ `USE TEMP B-TREE FOR ORDER BY`、**弃用** `unit_price_per100ml_idx`；去掉该谓词，规划器立即转 `SEARCH unit_price USING INDEX unit_price_per100ml_idx`。因 v1 `category` 恒 `beverage`、下推是 no-op，且入榜判据本就是 `per100ml IS NOT NULL`（非 category），故 **v1 决定不在 SQL 下推 category**：API 层校验 `category=beverage`（非法→400），`listRankings` 不按 category 过滤（结果等价、但保住索引驱动）。`category` 入参保留为 v2 预留——届时下推谓词并配 `(category, per100ml, id)` 复合索引。`unit_price_per100ml_idx` 是 schema 既有索引（schema.ts 已建），**无 schema 变更**。*备选*：取全量到内存排序——否决；跨表 `product.id` tiebreak——否决；为保留 category 下推而加复合索引——否决（v1 无品类、徒增 schema 变更，留 v2）；写 `INDEXED BY` 强制索引——否决（让 EXPLAIN 验的不是生产计划，造 false-pass）。

**D3：`per100ml` 单轴，对齐 taxonomy §七。** 本期只出 per100ml 榜；`per100g` 非空的项（当前生产仅 1 条）**不入榜**。判据用 `per100ml IS NOT NULL` 而非 category，避免与未建的 tag 体系耦合。

**D4：warnings 原样透出、可疑项不删。** 单件推断（243/329）会让个别多件装高估 per100ml（实测最高 889.9/100ml）。选择「带 warning 入榜、由前端标注」而非「静默剔除」：剔除会让榜单失真且不可解释，透出符合「每个结论都能解释 + 反套路提示」原则。confidence 仍取存储值（当前恒 0.95），可信度细化留给后续校准。

**D5：`/rankings` 公开只读，治理豁免。** 归入 api-governance「集外、豁免」一类（同 `/health`），不挂鉴权/限频/用量中间件，无 key 可访问。理由：榜单是小程序与第三方的主消费面、纯读已沉淀的公开数据、无写入无 LLM 成本，强制 key 只增摩擦。受保护端点集合的既有行为完全不变。*备选*：宽松限频——本期否决（KV 计数为防写滥用而设，读端无此风险），留作未来若被滥用再加。

**D6：分页边界确定化。** `limit` 默认 50、>200 clamp 到 200、`≤0`/非整数 → 400 invalid-request；`offset` 默认 0、负值/非整数 → 400 invalid-request；`category` 默认并**仅接受精确小写 `beverage`**（大小写敏感），空串/其它值 → **400 invalid-request**（不取「空集」——确定可断言、防拼写静默）。空库/越界 offset → 200 + 空数组（不是 404）。

**D7：响应透出 `formula`、价格口径显式声明。** 响应 schema 含 `formula`（取 `unit_price.formula` 存储值），使「每个单价结论带可回放公式」对消费方可见，而非读了不暴露。`priceCents`（来自 `product_raw.price`，最新观察价、整件分）与 `per100ml`/`formula`（来自 `unit_price`，**首写价**算的——`saveParsed` first-write-wins、调价不刷新派生行）**口径不同且可能漂移**：二者分母不同不可互推，调价后最新标价与旧价算的单价会偏离。v1 **接受**此降级——权威可比量是 `per100ml`，`priceCents` 仅参考标价；派生行刷新属未来 backfill 迁移（见 [[ingest-write-once-needs-backfill]] 的写一次性约束）。`confidence` 取 `unit_price.confidence`（最终权威 band，非 `product.confidence` 解析中间值），生产现状恒约 0.95、区分力当前来自 `warnings`。*备选*：响应只给 per100ml 不给 priceCents——否决，整件标价是用户基本预期；隐藏 formula——否决，违留痕铁律。

## 风险 / 权衡

- [单件推断高估 per100ml 污染榜尾/榜首] → warning 透出 + 前端徽标标注；不在读端做计算修正（属解析期职责）。后续可在 backfill/校准变更里把可疑项 confidence 降档。
- [无治理的公开端点被刷] → 读端无写入/无 LLM、走索引代价低；CF Workers 平台层有基础防护。若实测被滥用，再补「集外端点也可选挂宽松限频」——本期记为 Open Question，不预先复杂化。
- [响应字段未来要扩（每升/每瓶展示派生、对比组）] → 响应 schema 以 per100ml 为权威基准值，展示派生单位由前端从 per100ml + 规格换算（对齐 taxonomy §九），schema 预留扩展不锁死。

## 迁移计划

无数据迁移、无 schema 变更（仅新增只读查询与 route）。部署随 main 自动上 prod（migrate 无新迁移即 no-op，deploy 带上新 route）。回滚＝回退该 route，无状态残留。

## 待决问题

- 公开只读端点是否需要可选的宽松限频闸？本期不做，待实测滥用信号再定。
- 派生行（`unit_price`）的刷新（让 `priceCents` 与 `per100ml` 重新对齐、把陈旧重量品/酒类纳入）属未来 backfill 迁移变更，不在本期；本期以 D7 的显式口径声明承接该已知漂移。
