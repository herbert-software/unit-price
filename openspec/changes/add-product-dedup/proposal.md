## 为什么

`upsertRaw` 已按 `(store, store_sku)` 把原始上报收敛为一行(重复提交=更新同行、返回**同一 `rawId`**)。但 `saveParsed` **每次都 `newId()` 插入一条新 `product` + `unit_price` 行、不做任何查重**:同一商品被反复滚动山姆 App 列表(同一用户)或多人提交时,同一 `rawId` 下会累积 N 条**结果完全相同**的 `product` 行。这会污染未来「真实单价榜」的计数与排序(同一款被算多次)。

用户要求:相同结果的数据只保留一条(**最老的一条**)。

## 变更内容

- **写路径去重(非事后清理)**:`saveParsed` 落库 `product` 前先按「去重键」收敛;命中既有则**返回既有(最老)行的 `productId`/`unitPriceId`、不插新行**,未命中则照常**单一原子边界**内插 `product`+`unit_price`(守住既有「不留孤儿」)。
  - **去重键 = `rawId` + 规范化 `ParsedSpec` 结果**(`unitSizeValue`/`unitSizeUnit`/`quantity`/`totalAmountValue`/`totalAmountUnit`/`category`/`multipliers`/`packageUnit`);**价格无关**——不含 `per100ml`/`formula`,**且完全不涉及 `unit_price` 表任何列**(含其 `confidence`/`warnings`);`ParsedSpec.confidence` 也**排除**(解析中间置信、非结果结构,见 design D1 逐列表态)。
  - **保留最老**:`product` 表无 timestamp 列。新增 `dedupe_key TEXT NOT NULL` 列 + **`uniqueIndex`**——数据库唯一约束是 SoT,**首个成功插入赢**,天然保证「保留最老一条」且并发安全(不依赖 rowid 比较或读后写竞态)。
  - **双驱动事务**:sqlite(单连接无并发)在 `transaction` 内 `onConflictDoNothing`+判 `changes`+条件插 unit_price;D1(有并发)走 SELECT-first 命中即返、未命中 `batch([裸 insert product, insert unit_price])`,并发冲突时裸 insert 抛错使 batch 原子回滚→捕获回退 SELECT 既有。**D1 path 禁用 `onConflictDoNothing`**(它吞冲突会使 unit_price 成孤儿,见 design D4 关键修正)。
- **schema + 迁移**:`product` 加 `dedupe_key` 列(`NOT NULL`)与其唯一索引;`drizzle-kit generate` 产出新迁移 `0001_*.sql`(prod 经 `wrangler d1 migrations apply` 应用)。**空表是唯一自动支持路径**(prod 整体删重录、harness 用空库);非空旧库需手动 drop 重建或先跑清理脚本(见下),**不**期望 drizzle 单步自动回填去重。
- **去重键构造为确定性纯函数**(新文件 `packages/db/src/dedupe.ts`,**不污染 core**、不放 codec):**必须直接调用** `encodeMeasurement`/`encodeJson`(非另写等价序列化)、裸字段把原值或 `null` 直接入数组(结构化 `null`、**不用字符串哨兵**,避免与真值碰撞)、结构化数组整体序列化避免分隔歧义,保证「相同结果→相同键」「不同结果→不同键」。
- **历史重复清理**:仅提供**可选**一次性脚本——**应用层**读每行 spec 算键分组(**非按 dedupe_key 列分组**,清理时该列尚不存在)、保留 `MIN(rowid)`、删其余及其 `unit_price`。生产将整体删重录,故历史清理**非必需**、不进自动部署路径。

## 功能 (Capabilities)

### 新增功能
<!-- 无新建 capability;作为 persistence 能力的增量需求引入 -->

### 修改功能
- `persistence`: 新增「`product` 必须按去重键收敛、相同结果只保留最老一条」需求——`saveParsed` 在写路径按 `(rawId + 规范化 spec)` 去重键查重,等价行不重复落库、返回既有最老行;`product` 表加 `dedupe_key` 列 + 唯一索引,以数据库约束保证保留最老。`product_raw` 原始留痕不变;去重只作用于 `product`/`unit_price` 派生层。

## 影响

- **代码**:`packages/db/src/schema.ts`(`product` 加 `dedupe_key` 列 + uniqueIndex)、`packages/db/src/repository.ts`(`saveParsed` 双驱动去重逻辑)、新文件 `packages/db/src/dedupe.ts`(`computeDedupeKey` 纯函数)、`packages/db/drizzle/0001_*.sql`(生成的迁移)、`packages/db` 单测(含 D1 path)。
- **不触碰**:tier1/tier2/计算层(`packages/core`)、`product_raw` 原始留痕与其去重键、`corrections`、可比判断、抓取/众包合规面。
- **行为变化**:`saveParsed` 对等价重复输入从「插新行」变「返回既有行 id」——返回值契约(`{productId, unitPriceId}`)不变,但同一结果多次调用返回**同一对** id;调用方(`/ingest`、`/contribute` 经 `apps/api`)无需改动。
- **数据**:已落库的历史重复不在自动路径内清理(prod 将整体删除重录);可选脚本另附。
- **非目标**:不改计算层/可比;不动 `product_raw`;不做跨 `raw` 的「同商品不同标题」实体归一(更复杂,留后续 `category-tagging`/实体归一变更);不引入服务端主动爬取。
