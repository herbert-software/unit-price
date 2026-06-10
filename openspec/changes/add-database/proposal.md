## 为什么

到目前为止系统是**无状态按需计算**:`/parse` 收到标题+价格当场算单价、不落库。但下一阶段要做公开 API + Surge 数据收集 + 品类比价榜,都需要**持久化的商品库**——存下抓到的原始商品、规范化后的商品与单价、以及人工纠错,后续才能做跨次比价、榜单、品类查询。这是 architecture §五 的 DB 层、也是 `public-deploy`(ingest API)与 `category-tagging`(品类/标签)两个后续变更的共同地基。本变更只铺**核心持久层**(落库 + 数据访问 + 迁移),不碰 HTTP/部署/品类。

## 变更内容

新增持久化基础设施(库选型 + schema + 数据访问层 + 迁移),把 `@unit-price/core` 已产出的领域对象落库:

- **DB 引擎**:**Cloudflare D1(SQLite)**——CF 原生、零外部依赖、与 Worker 同机最低延迟,契合「CF 优先」;**Drizzle ORM**(sqlite 方言,TS 原生、类型从 schema 推导,与 Zod SOT 一致)。**可移植类型约束**:schema **禁用** Postgres-only 类型(原生数组/jsonb/serial/numeric),只用 SQLite↔Postgres **等价**类型(详见 design),使日后撑爆 D1(10GB/高写并发)时可**平滑迁** Postgres——repository 契约 + core Zod SOT 不变,schema 仅换方言包壳。
- **核心表**:
  - `product_raw`:每次抓取/录入的**原始商品**(store、store_sku、title、price、category_hint(映射 `RawProduct.categoryHint`)、source、source_url、captured_at;去重键 `(store, store_sku)`)——Surge/插件/手动 ingest 的落地表(ingest 的 HTTP 入口归 `public-deploy`)。促销分层是 Phase 4 非目标,本次不存 promotion。
  - `product`:**规范商品**(由 ParsedSpec 派生:unitSize/quantity/multipliers/totalAmount/packageUnit/category/confidence + `raw_id` 外键)。`confidence` 为解析置信(`ParsedSpec.confidence`)。**本次不含品类标签列**(`category` 仍为现有的自由 string/恒 beverage;`pending_category_tag_id`/tag 关联留给 `category-tagging`)。
  - `unit_price`:**计算后单价**(落 `CalcResult`:per100ml 可空、formula 可空、confidence=最终权威 band、warnings;关联 product)。
  - `corrections`:**人工纠错**(parse_source=manual_corrected,沉淀样本)。
- **数据访问层**(repository):TS 类型化读写接口(upsert raw、规范化落 product+unit_price、读商品、写纠错),供 `apps/api` 与未来 ingest 复用。
- **迁移**:Drizzle migration(sqlite 方言,生成 + 应用),本地用 in-memory SQLite(better-sqlite3 / libsql)或 Miniflare D1 跑测试。

## 非目标

- HTTP ingest API、鉴权限频、部署到 CF/阿里云 → `public-deploy`。
- 品类 taxonomy / 标签 / `tag`/`product_tag`/`store_category_map`/`category_closure` / 分类管线 → `category-tagging`(本表 `product` 仅留可扩展位,不建这些表)。
- `comparison_group` 表:按 `docs/taxonomy-and-tagging.md` §九,对比组改**动态查询**、不物化此表,**不建**。
- `/compare`、榜单、Redis 缓存、跨店同款匹配。
- core 计算逻辑改动(只读复用 core 产出落库)。

## 功能 (Capabilities)

### 新增功能
- `persistence`: 商品库持久层——`product_raw`/`product`/`unit_price`/`corrections` 的 schema、Drizzle 数据访问层(upsert/查询/纠错)、迁移与本地测试基座。

### 修改功能
本次为新增基础设施,无既有功能的规范级行为变更。

## 影响

- **新增 workspace**:`packages/db`(`@unit-price/db`:Drizzle schema + repository + 迁移),依赖 `@unit-price/core` 的类型/Zod schema(落库前 Zod 校验,types 与 Drizzle 列对齐)。
- **新增依赖**:`drizzle-orm`(sqlite/d1)+ `drizzle-kit`(迁移);测试用 `better-sqlite3` / `@libsql/client`(in-memory SQLite)或 Miniflare D1。
- **新增配置**:生产用 D1 binding(wrangler 声明);本地/测试用 SQLite 文件或内存库。连接配置 gitignore。
- **合规敏感面**:无服务端主动抓取;`product_raw` 只存「用户/插件/Surge 主动上报」的商品(众包,合规分层见 architecture §七),原始抓包数据不入库。
- **依赖/顺序**:依赖已归档的 `packages/core`(领域类型 + 计算);是 `public-deploy`(ingest API 写本层)与 `category-tagging`(给 `product` 加品类列/tag 表)的前置。
