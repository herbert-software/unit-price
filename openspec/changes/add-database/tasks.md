## 1. workspace 脚手架

- [x] 1.1 新建 `packages/db`(`@unit-price/db`):`package.json`(`type: module`、依赖 `@unit-price/core`/`drizzle-orm`,devDeps `drizzle-kit`/`better-sqlite3`(或 `@libsql/client`)/`vitest`)、`tsconfig.json`(NodeNext、project reference 指向 core)、`src/index.ts` 占位导出
- [x] 1.2 在根 `pnpm-workspace.yaml`(已含 `packages/*`)与根 `tsconfig.json` solution refs 中接入 `packages/db`;`pnpm install` 后 `pnpm -r build` 通过
- [x] 1.3 新增 `drizzle.config.ts`(**方言 sqlite**,migrations 输出目录 `drizzle/`,本地 sqlite 文件/D1 配置)

## 2. schema(Drizzle 表定义,对齐 core 领域类型)

- [x] 2.1 `src/schema.ts`(`sqliteTable`)定义 `product_raw`:`id`(**TEXT PK,app 生成 UUID/ULID**,禁自增)/`store`(TEXT NOT NULL)/`store_sku`(TEXT NOT NULL)/`title`(TEXT NOT NULL,对齐 `RawProductSchema` `z.string().min(1)`)/`price`(**INTEGER 整数分** NOT NULL,对齐 `z.number()`)/`category_hint`(TEXT nullable,映射 `RawProduct.categoryHint`)/`source`/`source_url`(TEXT)/`captured_at`(INTEGER epoch,NOT NULL,ingest 时置)+ 去重唯一键 `(store, store_sku)`(与价格无关);不含任何解析/计算派生列
- [x] 2.2 定义 `product`:`id`(TEXT PK,app 生成)、`raw_id`(**TEXT** FK → product_raw)、`unit_size_value`(REAL)/`unit_size_unit`(TEXT)、`quantity`(nullable)、`multipliers`(**TEXT JSON** **NOT NULL**,core 侧 `.default([1])`)、`total_amount_value`(REAL)/`total_amount_unit`(TEXT,nullable)、`package_unit`(TEXT nullable)、`category`(TEXT,本次恒 beverage)、`confidence`(REAL);measurement 拆列、可空字段 nullable
- [x] 2.3 定义 `unit_price`(落 `CalcResult`,非 `UnitPrice`):`id`(TEXT PK,app 生成)、`product_id`(**TEXT** FK)、`per100ml`(**REAL** nullable,可数值排序索引,**从 core `CalcResult` 直存、不从整数分重算**)、`formula`(TEXT nullable,core 原样留痕、内嵌元价)、`confidence`(REAL,**最终权威 band**=`CalcResult.confidence`,区别于 `product.confidence` 的解析置信)、`warnings`(**TEXT JSON** **NOT NULL**,经 `WarningsSchema` 校验,空告警存 `"[]"`);`per100ml` 加索引
- [x] 2.4 定义 `corrections`:`id`(TEXT PK,app 生成)、`product_id`/`raw_id`(**TEXT** FK)、`corrected_spec`(**TEXT JSON**,`ParsedSpec` 形)、`parse_source`(默认 `manual_corrected`)、`created_at`(INTEGER epoch);独立行、不就地改 raw/product
- [x] 2.5 确认 schema **不用任何 Postgres-only 类型**(无 `...[]` 原生数组/`jsonb`/`serial`/自增整数 PK/`numeric`;主键均 app 生成 TEXT id),且**不存在** `tag`/`product_tag`/`store_category_map`/`category_closure`/`comparison_group` 表(非目标边界)

## 3. repository(类型化数据访问层 + 双向 Zod 校验)

- [x] 3.1 `src/db.ts`:连接初始化**接受注入连接**(D1 binding 或 sqlite 句柄),缺失/打不开抛明确错误(禁止返回看似可用的空实例);测试注入 in-memory sqlite
- [x] 3.2 `src/repository.ts` 导出 `upsertRaw`(按去重键 upsert,返回 raw 行 id;**额外校验 `store`/`store_sku` 非空,空则拒写**)、`saveParsed`(入参=`ParsedSpec`+`CalcResult`+`raw_id`;`ParsedSpec` 过 `ParsedSpecSchema`、`CalcResult` 拆开过 `UnitPriceSchema`/`WarningsSchema`/`z.number().min(0).max(1)`,失败抛带字段路径错误后不写;在**单事务内**落 product + unit_price,全成或全败)、`getProduct`(读出经 Zod 重建为类型化 `ParsedSpec` + `unit_price`(CalcResult 形)+ `raw_id`,而非裸行)、`saveCorrection`(入参=纠错后 `ParsedSpec`(过 `ParsedSpecSchema`)+ 关联 id;新增 corrections 行存 `corrected_spec`,不改 raw/product)
- [x] 3.3 存储编码工具(在 repo 层):`Measurement` ↔ `*_value`(REAL)+`*_unit`(TEXT);`multipliers`/`warnings`/`corrected_spec` ↔ **JSON-text**(`JSON.parse`/`stringify`);金额 ↔ **整数分(`Math.round(元×100)` / `分/100`,禁 trunc/floor)**;时间 ↔ epoch;id 用 app 生成 UUID/ULID;保证解码后领域对象无损往返(Zod 校验对领域对象、非对 JSON 串)
- [x] 3.4 从 `src/index.ts` 导出 repository 接口与类型

## 4. 迁移与本地测试基座

- [x] 4.1 用 `drizzle-kit generate` 生成初始迁移到 `drizzle/`;验证幂等=**重复运行 `drizzle-kit migrate`** 时 migration journal 跳过已应用项(不报错),而非重放同一 SQL 文件
- [x] 4.2 测试 harness:`src/__tests__` 用 in-memory SQLite(`better-sqlite3`/`@libsql/client`)应用迁移,**显式 `PRAGMA foreign_keys=ON`**(对齐 D1 强制 FK,否则 FK 回滚断言假绿),`pnpm -r test` 无需外部 DB
- [x] 4.3 repository 测试:同款重复上报只留一行且 `captured_at` 更新;空 `store`/`store_sku` 上报被拒写;**金额换算钉死四舍五入——`¥0.29→29`(非截断的 28)、`¥0.57→57`、`¥39.90→3990`,读回精确还原,不落 float**;`per100ml` 从 core 直存(不等于库内 `price/100*?` 重算);部分规格(quantity=null)往返无损(undefined/null 归一为 NULL);JSON-text 列内容往返(`multipliers=[1,2]`、`warnings=[]` 均 NOT NULL,空数组存 `"[]"` 照常往返);`per100ml=null` 落库不写成 0;`product.confidence`(解析置信)与 `unit_price.confidence`(权威 band)各自落对列;`ParsedSpec` 与 `CalcResult`(如 confidence=1.2 越界、warnings 含非字符串)校验失败均拒写;`saveParsed` 单事务原子性——FK 已开,在同一事务内令 `unit_price` 写入失败(违反 FK/约束或 mock 抛错),断言 `product` 行随之回滚不留半行;`corrected_spec` 经 `ParsedSpecSchema` 往返;连接缺失抛错;corrections 不改 raw/product
- [x] 4.4 schema 边界测试/断言:确认**无 Postgres-only 类型**(grep 迁移 SQL 无 `...[]`/`jsonb`/`serial`/`numeric`)且未建品类/comparison_group 表(grep 迁移 SQL 或查 `sqlite_master`)

## 5. 收尾

- [x] 5.1 `.env.example`/README 说明本地 SQLite 连接(文件路径或内存)与生产 D1 binding 约定;确认 `.env`/本地 db 文件在 `.gitignore`
- [x] 5.2 `pnpm -r build`、`pnpm -r test`、`drizzle-kit generate`(无 pending diff)全绿
- [x] 5.3 更新 `TODO.md` Phase 3 行(标注 `packages/db` 落库部分由本 change 交付,product_raw/product/unit_price/corrections;comparison_group 改查询不建)
- [x] 5.4 核对 `docs/architecture.md` §五 表清单已为 `product_raw / product / unit_price / corrections`(本提案已同步:`product_spec`→`product`、移除 `comparison_group`;见 design 决策 7),确认 `public-deploy` 无撞 SOT
