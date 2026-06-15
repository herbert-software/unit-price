## ADDED Requirements

### 需求:product_raw 必须存门店 native category id(可空、专用、COALESCE provenance)

`product_raw` **必须**新增可空列 `native_category_id`(可移植 `TEXT`,存门店原生 `categoryIdList` 路径末端**叶 id** 字符串),作为门店来源 provenance,供打标签管线经 `store_category_map` 命中门店自身叶级分类。

- **列必须可空**;经标准 `drizzle-kit generate` DDL 迁移加列(登记 `_journal.json`,**区别于** 0004/0005 的目录扫描幂等 DML 种子迁移)。prod `product_raw` 非空表加**可空 `TEXT`** 列对 SQLite 安全(无需 DEFAULT)。
- **`upsertRaw` 必须写入** `native_category_id`,并对 `(store, storeSku)` 冲突走 **COALESCE**(重报带值则更新、省略则保留旧值——与既有 `source`/`sourceUrl` provenance 同语义,**禁止**在 price-only 重报时清空)。这是**前向**路径(新捕获带 native-id 落库;title/price 仍随最新观测更新,合 dedupe 契约)。**存量既有行的回填不走此路径**(经 `/ingest`/`upsertRaw` 会覆写 title/price 并触发解析、有重复 product 风险),改用 native-id-only `UPDATE`(只补 `native_category_id`、不碰 title/price、不触发解析;见 `contribute-ingest` / 设计 D3)。
- **禁止**复用 `category_hint` 列存 native-id(后者是 `product.category` 透传源)。`native_category_id` 与领域列正交。
- `listProductsForBackfill`(供 backfill 重打标签)**必须** select 该列并把 `native_category_id` 传给打标签管线(取代此前硬编码 `null`);为 `null` 的行退化为仅 tier1。

#### 场景:upsertRaw 写入 native_category_id 并 COALESCE
- **当** 同一 `(store, storeSku)` 先以无 `nativeCategoryId` 落库,后重报带 `nativeCategoryId="10012164"`
- **那么** `product_raw.native_category_id` **必须**更新为 `"10012164"`,且 `title`/`price` 随最新观测更新、其它 provenance 不被清空;再次重报省略 `nativeCategoryId` 时**必须**保留 `"10012164"`(COALESCE)

#### 场景:backfill 读 native_category_id 列(不再硬编码 null)
- **当** backfill 读取一条 `native_category_id` 非空的 `product_raw`
- **那么** `listProductsForBackfill` **必须**把该 `native_category_id` 传入打标签(使 store-map 点火);为 `null` 的行传 `null`(仅 tier1)

#### 场景:加列迁移对非空 prod 表安全且可空
- **当** 生产经自动 migrate 应用加列迁移
- **那么** `product_raw.native_category_id` **必须**以可空 `TEXT` 落地(既有行该列为 `NULL`)、不破坏既有数据、不需 backfill 即可部署
