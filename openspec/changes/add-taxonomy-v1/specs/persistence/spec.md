## MODIFIED Requirements

### 需求:product 必须存规范商品且预留品类扩展位

`product` **必须**由 `ParsedSpec` 派生落库(`unit_size_value`/`unit_size_unit`、`quantity`、`multipliers`、`total_amount_*`、`package_unit`、`category`、`confidence`),并**必须**经 `raw_id` 外键关联到产生它的 `product_raw` 行。此处 `confidence` 为 **`ParsedSpec.confidence`(解析置信,中间值)**,与 `unit_price` 的最终权威置信(见下需求)是**两个不同的值**、语义不同。本次 `category` **必须**保持为现有的自由 string(恒 `beverage`)——品类真值改由 `category-tagging` 的 `product_tag` 承载,`spec-parsing` 的 `category` 恒常量约束本期不变;可空字段**必须**用 nullable 列,使部分 tier1 命中能落库。

**本期(`category-tagging`)引入品类表与扩展列**:**必须**新增 `tag` / `product_tag` / `store_category_map` / `category_closure` 四表,并给 `product` 增 `pending_category_tag_id`(可空,「粗分类 / 待细化」非叶终态指针,引用 `tag`)与 `rankable`(派生)两列。这些表 / 列**必须**沿用本规范的可移植类型(app 生成 TEXT 主键、JSON-text、INTEGER、REAL;无 Postgres-only 类型)。`tag.comparable_unit` **必须可空**;`product_tag.confidence` 为 REAL、`product_tag.source` 为 TEXT 枚举(本期 `{rule, store-map, manual}`);`(product_id, tag_id)` 与 `(store, native_category_id)` 各为唯一键。

**非空旧库迁移安全(B1)**:`product.rankable` **必须**以 `INTEGER NOT NULL DEFAULT 0` 加列——生产 `product` 为非空表(现状约 445 行)、且 push main 自动 migrate,**SQLite 非空表加无 DEFAULT 的 `NOT NULL` 列会直接报错**(对齐既有「迁移可复现 / 非空旧库」纪律);加列即全 `0`,随后由 `category-tagging` backfill `UPDATE` 重算到正确值。`pending_category_tag_id` 加列为可空(无此问题)。

**两新列不进去重键**:`pending_category_tag_id` / `rankable` 是**溯源 / 派生增列**(类同 `raw_id` / `dedupe_key`),**禁止**进入 `dedupe_key`、**不影响**既有 first-write-wins 去重收敛(与「键与价格无关、`confidence` 不进键」同口径)。

其余语义与不变量(单归属 / `comparable_unit` 继承 / 闭包 / 仲裁 / `rankable` 派生 / 三态)由 `category-tagging` 能力定义。**仍禁止** `comparison_group` 表(对比组改动态查询,见 taxonomy §九)。

#### 场景:部分规格命中也能落库
- **当** 一个只命中 `unitSize`、`quantity` 为 null 的 `ParsedSpec` 落库
- **那么** 写入成功,`quantity` 列为 NULL,读回得到同一部分规格

#### 场景:product 关联其来源 raw
- **当** 落一个 `product`
- **那么** 其 `raw_id` **必须**指向真实存在的 `product_raw` 行,可经 product 取回原始上报

#### 场景:引入品类表(comparison_group 仍不物化)
- **当** 应用本次迁移后检查 schema
- **那么** **必须**存在 `tag` / `product_tag` / `store_category_map` / `category_closure` 四表,以及 `product.pending_category_tag_id` / `product.rankable` 两列(均用可移植类型);**仍不存在** `comparison_group` 表(对比组动态查询)

#### 场景:非空旧库加 rankable 列不炸迁移
- **当** 在已有数据的 `product` 表(非空)上应用本次迁移
- **那么** `rankable` 以 `INTEGER NOT NULL DEFAULT 0` 加列、迁移**必须**成功(不因「非空表加无 DEFAULT 的 NOT NULL 列」报错);已有行 `rankable` 初值为 `0`,待 backfill 重算

#### 场景:加两列不改去重收敛
- **当** 加入 `pending_category_tag_id` / `rankable` 两列后对同款商品重复落库
- **那么** `dedupe_key` 构造**必须**不含这两列、既有 first-write-wins 去重收敛行为不变(保留最老一条)
