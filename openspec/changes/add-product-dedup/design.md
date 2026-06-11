## 上下文

落库现状(`packages/db/src/repository.ts`):
- `upsertRaw`:按 `(store, store_sku)` `onConflictDoUpdate` → 一个 SKU 一行 `product_raw`,重复提交更新同行、返回**同一 `rawId`**。
- `saveParsed`:每次 `productId = newId()`、单事务插一条新 `product` + 一条新 `unit_price`(`unit_price` 已有 `uniqueIndex(productId)` 保证 1:1)。**`product` 无任何唯一约束、无 timestamp 列**,故同一 `rawId` 下可累积任意多条等价 `product` 行。

重复来源:同一商品(同 `rawId`)被反复提交,`saveParsed` 每次插新 `product`。`tier1`/`tier3` 对同一 title 确定性,故这些行**结果相同**。

迁移机制:`drizzle-kit generate`(sqlite 方言)产出 `packages/db/drizzle/000N_*.sql`;prod 经 `wrangler d1 migrations apply`(`migrations_dir=../../packages/db/drizzle`,deploy.yml on main)应用;幂等由 drizzle journal 保证。现有 `0000_*.sql`,本变更新增 `0001`。

## 目标 / 非目标

**目标:** `saveParsed` 对「同 `rawId` + 同规范化解析结果」的重复落库**只保留最老一条**;写路径去重(防重复产生);以数据库唯一约束保证「保留最老」且并发安全;去重键构造为确定性纯函数(IO 层,不污染 core)。

**非目标:** 不改 tier1/tier2/计算层;不动 `product_raw` 原始留痕及其去重键;不做跨 `raw` 的「同商品不同标题」实体归一;不把历史重复清理纳入自动部署路径(prod 将整体删重录)。

## 决策

**D1:去重键 = `rawId` + 规范化 `ParsedSpec`、价格无关。**
**`product` 表 9 个领域列的纳入/排除(逐列表态,与 `schema.ts:60-77` 对账,无遗漏):**

| 列 | 纳入键? | 理由 |
|---|---|---|
| `unitSizeValue` / `unitSizeUnit` | ✅ 纳入 | 解析结果核心 |
| `quantity` | ✅ 纳入 | 解析结果核心 |
| `totalAmountValue` / `totalAmountUnit` | ✅ 纳入 | 解析结果核心 |
| `multipliers` | ✅ 纳入 | 解析结果核心 |
| `packageUnit` | ✅ 纳入 | 解析结果核心 |
| `category` | ✅ 纳入 | 解析结果核心(当前恒 `beverage`,纳入面向未来品类) |
| **`confidence`(`ParsedSpec.confidence`)** | ❌ **排除** | **解析置信是中间值、非「结果结构」的一部分**;同 title tier1 确定 → 同 confidence(纳不纳入对 tier1 无差),但 tier2(AI)可能对同 rawId 给出同 spec 结构、不同 confidence——此时**视为同款重复、保留最老**(不因置信抖动堆叠新行)。这是显式裁决:`confidence` **不进** `computeDedupeKey`。 |

`unit_price` 表的列(`per100ml`/`formula`/`confidence`/`warnings`)**一律不进键**——键仅由 `(rawId + ParsedSpec 派生的 product 列)` 构成、**完全不涉及 `unit_price` 表任何列**。理由:价格变动是「同款更新」、不应制造新「结果」行(与 `product_raw` 去重键「与价格无关」同口径);用户语义「相同结果」指**解析结构相同**,而非单价数值相同;两个不同商品恰好同 `per100ml` 不是重复,故键必须 spec-based 且锚定 `rawId`(同源)。
- 备选(否决):键含 `per100ml`/`formula`。否决——价格波动会让同一款反复生成新行,违背「同款只一条」;且 `formula` 内嵌元价,价格抖动即破键。

**D2:保留最老 = `dedupe_key` 列 + `uniqueIndex` 为单一事实源。**
`product` 加 `dedupe_key TEXT NOT NULL` 列与 `uniqueIndex('product_dedupe_key_unique')`。「保留最老」由唯一约束天然保证:**首个成功插入的行赢、后到的等价行被拒/no-op**(在单线程顺序提交下首插即最老;并发下先提交方最老)。**数据库唯一约束是 SoT**,不靠应用层 rowid 比较或读后写时序。`dedupe_key` 是溯源/收敛增列(类同 `raw_id`),**非领域字段、不进 `ParsedSpec`**。
- 备选(否决):事后清理(全量插+定期 `DELETE ... WHERE rowid NOT IN (SELECT MIN(rowid) ...)`)。否决——重复行已产生、需后台 job、有竞态窗口;写路径去重从根上不产生重复,更简单。

**D3:去重键构造为确定性纯函数,且**必须直接调用**既有编码函数(不另写等价逻辑)。**
新增 `computeDedupeKey(rawId, spec): string`(**新文件 `packages/db/src/dedupe.ts`**,纯函数无 IO;**不放 `codec.ts`**——codec 职责限定为存储定标编码,去重键构造是收敛逻辑、独立成文件,复用 codec 而不属于它)。构造规则**钉死**以消除漂移(R3 点名):
- measurement 字段**必须直接调用** `encodeMeasurement(spec.unitSize)`/`encodeMeasurement(spec.totalAmount)`——**禁止**为拼接另写一份序列化(哪怕等价),否则重开漂移窗口。`multipliers`(`number[]`)**直接入外层数组**、由最外层 `encodeJson` 一次性序列化,**勿**单独 `encodeJson(multipliers)` 预编码(避免双重编码 `"[1]"` 与裸 `[1]` 的歧义)。
- 裸字段(`quantity: number|null`、`packageUnit: string|null`、`category: string`):**必须**把原值或 `null`(`null`/`undefined` 同归一为 JSON `null`)**直接**放进序列化数组——`JSON`/`encodeJson` 规范区分 `null` / 数字 / 字符串(`null` 与字符串 `"瓶"` 与数字 `0` 互不相等),故**禁止用字符串哨兵**(会与真值字符串理论碰撞、误去重)。数值原样入数组(JS `number` 无 1 vs 1.0 区分)。
- 各字段片段**必须**以**结构化数组 + `encodeJson` 整体序列化**(而非裸字符串拼接)产出最终键,避免分隔歧义/注入。即:`computeDedupeKey = encodeJson([rawId, encodeMeasurement(spec.unitSize), spec.quantity ?? null, encodeMeasurement(spec.totalAmount), spec.category, spec.multipliers, spec.packageUnit ?? null])`(字段序固定;`multipliers` 是 number[],直接入外层数组由 `encodeJson` 一次性序列化、不双重编码)。
保证「相同结果→相同键、不同结果→不同键」。键存为 `TEXT` 列(可移植,不引入 Postgres-only)。

**D4:`saveParsed` 双驱动事务逻辑(首插原子性必须保留)。**
两驱动都以「SELECT-first 快路径 + 驱动原生原子写作并发兜底」为骨架,**首插的 product+unit_price 必须在单一原子边界内**(守住既有「不留孤儿」需求):
- **sqlite 驱动**(`db.orm.transaction` 同步,单连接、**无真并发**):在一个 `transaction` 内 `insert(product).onConflictDoNothing({target: dedupeKey})`,用 better-sqlite3 `RunResult.changes`(或 `returning`)判断:
  - `changes===1`(真插入)→ 同 tx 内插 `unit_price`、返回新 `{productId, unitPriceId}`(两插同 tx,原子)。
  - `changes===0`(命中既有)→ `SELECT product by dedupe_key` 取既有 `productId`、`SELECT unit_price by product_id` 取既有 `unitPriceId`,返回既有对、**不**插 unit_price。
- **D1 驱动**(`batch` 原子,**有真并发**):
  1. **SELECT-first**:`SELECT product by dedupe_key`,命中→返回既有对、**不写**(覆盖单线程重复的常见路径)。
  2. 未命中→`batch([insert product (**裸 insert,无 onConflictDoNothing**), insert unit_price])`。**裸 insert** 使并发抢插时唯一约束冲突**抛错** → D1 `batch` 全成或全败、**整体回滚**(经 `d1-workerd.test.ts` 实证 batch 抛错即回滚)→ **首插原子性由 batch 保证**。
  3. 捕获 batch 抛错(并发冲突)→ 回退到步骤 1 的 SELECT 既有分支、返回既有对。
- **关键修正(reviewer blocker)**:D1 path 的 product insert **必须用裸 insert、禁止 `onConflictDoNothing`**——`onConflictDoNothing` 会**吞掉**唯一冲突使 batch 不抛错、unit_price 照插成孤儿。回滚的正确触发是**裸 insert 唯一冲突抛错**(依赖 D1 FK/唯一约束 enforced),**不是** `onConflictDoNothing`。sqlite path 因单连接无并发,用 `onConflictDoNothing`+`changes` 判定是安全的;两驱动机制不同但各自原子。
- **回退查空即损坏**:命中既有后 `SELECT unit_price by product_id` 若查空,等于「既有 product 无配对 unit_price」=数据已损坏,**必须抛错**(与 `getProduct`(`repository.ts:282`)一致);首插原子性(上面 batch/tx 保证)使该分支理论上不可达。

**D5:历史清理脚本(可选、不进自动路径)。** 一次性脚本:**应用层**读每行 `product` 的 spec → 调 `computeDedupeKey` 算键 → 按算出的键分组、保留 `MIN(rowid)`(SQLite 隐式 rowid 单调=最早插入,普通 rowid 表、非 `WITHOUT ROWID`,`VACUUM` 不改相对序)、删其余 `product` 及其 `unit_price`。**FK 删除序**:`foreign_keys=ON` 下删 victim `product` 前须先删其 `corrections` + `unit_price`(两个 FK 子表,`corrections.product_id → product.id` 亦为 FK)再删 `product`(父表),否则撞 FK、整事务回滚。含 `--dry-run`。**注意**:清理发生在加 `dedupe_key` 列**之前**,故**必须在应用层算键分组、禁止「按 dedupe_key 列分组」(此时列不存在,鸡生蛋)**。因 prod 将整体删重录,标注**可选**、不进 deploy.yml。

## 风险 / 权衡

- **[R1 非空旧库迁移路径]** **空表是唯一自动支持路径**:SQLite 对空表加 `dedupe_key TEXT NOT NULL`(无 DEFAULT)+ `CREATE UNIQUE INDEX` 直接成功(prod 整体删重录、harness 用 `:memory:` 空库,均无回填冲突)。**注**:drizzle-kit 对「NOT NULL 无 DEFAULT 新列」可能产 `ALTER ADD COLUMN` 或 table-rebuild(`__new_product` rename);两形态在空表(`INSERT…SELECT` 复制 0 行)下均成功,故 tasks 1.2 以**实际产出**为准、不预设形态。**非空旧库**(本地已有数据,可能含等价重复行)**不在自动迁移支持范围**:SQLite 非空表加 `NOT NULL` 无 DEFAULT 列直接报错,且回填后唯一索引会撞重复值。处置:**(a)** 本地直接 drop & re-migrate(最简,数据无价值);**或 (b)** 先跑 D5 清理脚本(应用层算键去重)→ 再应用列+约束迁移。**禁止**期望 drizzle 单步迁移自动回填/去重(drizzle-kit 不生成数据迁移)。spec 把此明确为「空表默认、非空旧库手动」,不留「自动支持非空旧库」的假象。
- **[R2 D1 并发兜底——回滚由裸 insert 唯一冲突抛错触发(非 onConflictDoNothing)]** D1 path「SELECT-first 后 batch」竞态:两并发等价提交都查不到→都走 batch。**修正后机制**:product insert 为**裸 insert**,后提交方命中 `dedupe_key` 唯一索引 → **抛错** → D1 `batch` 全成全败、**整体回滚**(`d1-workerd.test.ts` 实证 batch 抛错即回滚,catchable)→ 捕获后回退 SELECT 既有(此时先提交方已落库、必查到)→ 返回既有对。**因果链**:回滚由**唯一约束冲突抛错**触发(依赖 D1 唯一索引 + FK enforced,D1 恒启用),**不是** `onConflictDoNothing`(它会吞冲突使 batch 不抛错、unit_price 成孤儿——故 D1 path **禁用** onConflictDoNothing,见 D4 关键修正)。「保留最老」=先提交方(最老)赢、后提交方回退取既有。
- **[R3 去重键与落库值编码漂移]** 若 `computeDedupeKey` 另写一份序列化(即便等价),与 `encodeMeasurement`/`encodeJson` 漂移则等价行算出不同键(漏去重)或不同行同键(误去重)。**缓解(D3 已钉死)**:`computeDedupeKey` **直接调用** `encodeMeasurement`/`encodeJson` 本身(非「一致的另写」);裸字段把原值或 `null` 直接入数组(**结构化 `null`、禁止字符串哨兵**,JSON 规范区分 `null`/数字/字符串、无碰撞);最终键用结构化数组 `encodeJson` 整体序列化避免分隔歧义。单测覆盖「同 spec→同键」「`null` vs `undefined` 同键」「`packageUnit=null` vs `"瓶"` 不同键」「不同 spec(改 unitSize/quantity/category 任一)→不同键」「`per100ml`/价格变动→键不变」「measurement 缺失(both NULL)vs `{value:0}` 不同键」(**删除伪用例 `1` vs `1.0`——JS `number` 无此区分,`1===1.0` 恒真**)。
- **[R4 行为变化对调用方]** `saveParsed` 返回值结构不变,但等价重复调用返回**同一对** id(而非新 id)。`/ingest`/`/contribute` 不消费「每次必新 id」假设,无需改;须确认无调用方依赖「每次返回不同 productId」。**缓解**:grep 调用点确认;契约文档注明幂等语义。
- **[R5 跨 raw 的同商品未归一]** 同款不同 title(或不同 SKU)仍是不同 `rawId`→不同键→不去重。属已知非目标(实体归一留后续);本变更只收敛「同 `rawId` 同结果」。
