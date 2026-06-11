## 1. schema + 迁移(packages/db）

- [x] 1.1 `packages/db/src/schema.ts`:`product` 表新增 `dedupeKey: text('dedupe_key').notNull()` 列;表定义加 `uniqueIndex('product_dedupe_key_unique').on(t.dedupeKey)`(可移植 TEXT 类型,不引入 Postgres-only)。注释标明 `dedupe_key` 是溯源/收敛增列(类同 `raw_id`)、非领域字段
- [x] 1.2 `pnpm --filter @unit-price/db generate`(`drizzle-kit generate`)产出新迁移 `packages/db/drizzle/0001_*.sql`。**不预设产出形态**:drizzle-kit 对「新增 NOT NULL 无 DEFAULT 列」可能产 `ALTER TABLE ADD COLUMN` **或** table-rebuild(`CREATE TABLE __new_product / INSERT…SELECT / DROP / RENAME`);**检查实际产出**——两形态在**空表**(migrate 时 product 为空、`INSERT…SELECT` 复制 0 行)下均成功,但须确认 `CREATE UNIQUE INDEX dedupe_key` 存在、且 `schema-boundary.test.ts`(合并全部迁移 SQL 跑空库)+ 重跑迁移幂等(drizzle journal)仍绿;不手改生成的 SQL
- [x] 1.3 确认迁移对**空表**默认路径可直接应用(`NOT NULL` 列 + 唯一索引);非空旧库回填撞唯一索引的情形由可选清理脚本处理(见任务 4),迁移本身不内嵌回填

## 2. 去重键纯函数 + saveParsed 去重(packages/db）

- [x] 2.1 新增 `packages/db/src/dedupe.ts`:确定性纯函数 `computeDedupeKey(rawId, spec: ParsedSpec): string`(无 IO,**不放 codec.ts**)。measurement 字段**必须直接调用** `encodeMeasurement(spec.unitSize)`/`encodeMeasurement(spec.totalAmount)`(**禁止另写等价序列化**);`multipliers`(`number[]`)**直接入外层数组、由最外层 `encodeJson` 一次性序列化(勿单独 `encodeJson(multipliers)` 预编码、勿双重编码)**;裸字段 `quantity`/`packageUnit`/`category` 把**原值或 `null`** 直接入数组(`null`/`undefined` 归一为 JSON `null`,**禁止字符串哨兵**——会与真值碰撞误去重;JSON 规范区分 `null`/数字/字符串);最终键用**结构化数组 + `encodeJson` 整体序列化**(固定字段序 `[rawId, encodeMeasurement(unitSize), quantity ?? null, encodeMeasurement(totalAmount), category, multipliers, packageUnit ?? null]`,`multipliers` 是 `number[]` 直接入外层、不双重编码,避免裸拼接分隔歧义)。**排除** `per100ml`/`formula`/`ParsedSpec.confidence` 及一切 `unit_price` 列
- [x] 2.2 `repository.ts` `saveParsed`:落库前 `dedupeKey = computeDedupeKey(rawId, spec)`,写入 `productRow.dedupeKey`
- [x] 2.3 `saveParsed` **sqlite 驱动**(单连接无并发):在单个 `db.orm.transaction` 内 `insert(product).onConflictDoNothing({ target: product.dedupeKey })`,用 `RunResult.changes`/`returning` 判断。真插入(`changes=1`)→同事务插 `unit_price`、返回新 `{productId, unitPriceId}`;命中既有(`changes=0`)→`SELECT product by dedupe_key` + `SELECT unit_price by product_id`、返回既有对、**不**插 unit_price。两插同事务(首插原子)
- [x] 2.4 `saveParsed` **D1 驱动**(有并发):**SELECT-first**(`SELECT product by dedupe_key`)命中→返回既有对、不写;未命中→`batch([insert product (裸 insert、禁止 onConflictDoNothing), insert unit_price])`(原子)。并发抢插致裸 insert 唯一冲突 → batch **抛错**回滚 → `try/catch` 捕获后回退「`SELECT` 既有并返回」分支(先提交方已落库必查到)。**禁止** `onConflictDoNothing`(吞冲突会留 unit_price 孤儿)
- [x] 2.5 两驱动命中既有后 `SELECT unit_price by product_id` **查空** → **抛错**(数据损坏,与 `getProduct`/`repository.ts:282` 一致),禁止返回 `unitPriceId: undefined`
- [x] 2.6 确认 `saveParsed` 返回值结构不变(`{productId, unitPriceId}`),等价重复调用返回**同一对** id(幂等);首次落库 product+unit_price 在单一原子边界(sqlite=transaction / D1=batch)

## 3. 单测(packages/db）

- [x] 3.1 `computeDedupeKey` 单测:同 `(rawId, spec)`→同键;不同 `spec`(改 `unitSize`/`quantity`/`category` 任一)→不同键;`null` vs `undefined` 可空字段(`quantity`/`packageUnit`)→**同键**(归一为 JSON `null`);**`packageUnit=null` vs `packageUnit="瓶"` → 不同键**(结构化 `null` 不与字符串碰撞);measurement **缺失(both NULL)vs `{value:0,unit:'ml'}`→不同键**(真有判别力,替代伪用例);`ParsedSpec.confidence` 变、`per100ml`/价格变 → **键不变**。(**删除** `1` vs `1.0` 伪用例——JS `number` 无此区分、`1===1.0` 恒真)
- [x] 3.2 `saveParsed` 去重单测(sqlite):同 `rawId` 同 spec 调两次 → `product` 仅一行、两次返回**同一** `{productId, unitPriceId}`、`unit_price` 仅一行(无孤儿)
- [x] 3.3 `saveParsed` 不同结果不去重单测:同 `rawId` 两个不同 spec → 落两条 `product`(各自键),互不去重
- [x] 3.4 价格/置信无关单测:同 `rawId` 同 spec、不同 `CalcResult`(per100ml/formula 不同)或不同 `ParsedSpec.confidence` 调两次 → 仍只一条 `product`,返回既有最老对
- [x] 3.5 唯一约束兜底单测:直接以同 `dedupe_key` 双插 `product` → 唯一索引拒第二条(确认 DB 约束是 SoT,非仅应用层判断);测试基座须 `PRAGMA foreign_keys=ON`(与既有原子性测试一致)
- [x] 3.6 **D1 path 去重单测**(fake D1 binding,如既有 `d1.test.ts`):同 `rawId` 同 spec 两次 → SELECT-first 命中、第二次**不进 batch**、返回既有对
- [x] 3.7 **D1 path 并发冲突回退单测**(workerd D1,如既有 `d1-workerd.test.ts`):模拟两等价提交均 SELECT 未命中后插入 → 后插裸 insert 唯一冲突致 batch 抛错回滚、**无 `unit_price` 孤儿**、捕获后回退 SELECT 返回既有(最老)对
- [x] 3.8 `pnpm --filter @unit-price/db test` 全绿;`pnpm --filter @unit-price/db build` 绿

## 4. 历史清理脚本(可选、不进自动路径）

- [x] 4.1 提供一次性清理脚本,含 `--dry-run`:**应用层**读每行 `product` 的 spec → 调 `computeDedupeKey` 算键 → 按算出的键分组、保留 `MIN(rowid)`(SQLite 隐式 rowid 单调=最早插入)、删其余 `product` 及其 `unit_price`。**禁止「按 `dedupe_key` 列分组」**(清理在加列之前、该列不存在,鸡生蛋)。脚本顶部注明:生产将整体删重录、本脚本仅供**非空旧库**在加约束**之前**去重之用,**不**纳入 deploy.yml 自动路径
- [x] 4.2 (文档)注明迁移路径:**空表为唯一自动支持路径**(prod 删重录、harness 空库无回填冲突);**非空旧库不自动支持**——需 drop & re-migrate,或先跑 4.1 清理脚本再应用列+约束迁移

## 5. 收尾

- [x] 5.1 grep `saveParsed` 调用点(`apps/api/src/routes.ts` 等)确认无调用方依赖「每次返回不同 productId」;无需改 `apps/api`(返回契约不变)
- [x] 5.1b **必改既有原子性测试**:`repository.test.ts` 的「`is atomic: a failing unit_price insert rolls the product row back`」用例以**同 `rawId`+同 `spec`** 二次调用 `saveParsed`(复用首次 `unitPriceId`)强制 `unit_price` UNIQUE 冲突——新去重下第二次走**命中既有分支、根本不插 unit_price**,冲突永不触发、`rejects.toThrow(/UNIQUE/)` 变红、首插原子性回归覆盖丢失。**必须改造**:第二次调用改用**不同 `spec`**(→ 不同 `dedupe_key` → 走插入路径)再经复用 `unitPriceId` 强制 `unit_price` 冲突,断言 `product` 回滚到调用前计数、无孤儿。另复核其余 `packages/db` 测试有无「重复调用期望多行 / `countRows`=调用次数」断言(其余应为不同 spec/单次,确认即可)
- [x] 5.2 `pnpm -r test` + `pnpm -r build` 全绿
- [x] 5.3 `openspec-cn validate add-product-dedup --strict` 通过
