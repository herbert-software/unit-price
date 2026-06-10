## 上下文

系统当前**无状态**:`/parse` 当场算单价、不落库(`packages/core` 纯函数 + `apps/api` Hono)。下一阶段(`public-deploy` 的 Surge/插件 ingest、`category-tagging` 的品类榜单)都要持久化商品。本变更只铺核心持久层,不碰 HTTP/部署/品类。已确立约束:monorepo(pnpm workspace + TS project references + NodeNext,相对 import 带 `.js`);Zod 为 schema SOT(types 推导);`docs/architecture.md` §五 原指定 PostgreSQL + Drizzle,本变更据「CF 优先」改为 **Cloudflare D1(SQLite)+ Drizzle**,并以可移植类型保留迁 Postgres 的平滑路径(§五 已随本提案同步);`docs/taxonomy-and-tagging.md` §九 判定 `comparison_group` 表废弃改查询。

## 目标 / 非目标

**目标:**
- 新增 `packages/db`(`@unit-price/db`):Drizzle schema + 类型化 repository + 迁移 + 本地测试基座。
- 落库 core 已产出的 `RawProduct`/`ParsedSpec`/`CalcResult`(单价结果,unit_price 落它而非 `UnitPrice`,见决策 3),加 `corrections`,落库前 Zod 校验。
- 表:`product_raw` / `product` / `unit_price` / `corrections`,字段与 core 领域类型对齐、measurement 拆列、可空字段 nullable。
- CI/本地 `pnpm -r test` 无需外部托管 DB。

**非目标:**
- HTTP ingest API、鉴权限频、CF/阿里云部署(→ `public-deploy`)。
- 品类 taxonomy / `tag`/`product_tag`/`store_category_map`/`category_closure` / 分类管线(→ `category-tagging`);本次 `product.category` 仍恒 `beverage`。
- `comparison_group` 表(改动态查询,不建)、`/compare`、榜单、Redis 缓存、跨店同款匹配。
- 改动 core 计算逻辑(只读复用)。

## 决策

**1. DB 引擎 = Cloudflare D1(SQLite),非 Postgres。** 契合「CF 优先」:D1 是 CF 原生、零外部依赖、与 Worker 同机最低延迟、免 Hyperdrive/Neon 账号/出口流量、免费额度大。本层工作负载简单(榜单按 `per100ml`/`category` 排序筛选、去重按 `(store,store_sku)`、FK 连接),而品类 closure 用 `WITH RECURSIVE`——**SQLite 原生支持递归 CTE**,无需 Postgres。**Postgres 为上位 escape hatch**:撑爆 D1 的 10GB/库上限、或需高写并发/金额 numeric 精度/利于分析时再迁;迁移平滑由决策 2 的「可移植类型」+ 不变的 repository 契约/core SOT 保证。(此决策修正了早先「closure 需 Postgres」的站不住论据——SQLite 支持 CTE。)

**2. ORM = Drizzle(sqlite 方言)+ 可移植类型约束。** TS 原生、类型从 schema 推导(与 Zod SOT 同构)、迁移用 `drizzle-kit`。**schema 禁用 Postgres-only 类型**(原生数组/`jsonb`/`serial`/`numeric`),只用 SQLite↔Postgres **等价**类型,使引擎可逆:
- `Measurement` → `*_value` **REAL** + `*_unit` **TEXT**(可查询)。
- `multipliers`/`warnings` → **JSON-text(`TEXT` 列存 JSON 串)**,**非**原生数组。两者均 `NOT NULL`(core 侧 `multipliers.default([1])`、`CalcResult.warnings` 恒非 null 数组、`WarningsSchema` 拒 null,无可空态),往返只需保内容(空数组存 `"[]"`),不引入「`[]` vs NULL」区分。
- **主键/外键 → app 生成 `TEXT` id(UUID/ULID),禁用 `serial`/自增整数 PK。** 自增 PK 不可移植(SQLite `INTEGER PK` ↔ PG `identity/serial`);app 生成 TEXT id 两边等价,且契合多源众包 ingest(Surge/插件/手动各自生成 id,无需中心自增)。`raw_id`/`product_id` FK 同为 `TEXT`。
- `price`(输入金额)→ **整数分(`INTEGER`,精确)**,避开 float 金额;换算钉死 **`Math.round(元×100)`**(禁 trunc/floor——如 `0.29*100=28.9999…` 截断得 28、少 1 分,需 round 得 29;注:`39.90*100` 在 float64 下恰为精确 3990、不丢分,真正会漂移的是 `0.29`/`0.57`/`1.13`/`19.90` 这类值)。
- `per100ml`(派生排序/展示比值)→ **REAL**(排序够用,可空表不可算);**从 core `CalcResult` 直存,禁从库内整数分重算**。`formula` 由 core 原样留痕、内嵌元价,自包含可独立回放(回放用 formula 串本身,不代入 price 列)。
- `confidence` → **REAL**;`captured_at`/`created_at` → **INTEGER epoch**(或 ISO TEXT)。
- `corrected_spec` → **JSON-text(`TEXT`)**,非 `jsonb`。
这些列在 SQLite 与 Postgres 上语义等价;且我们从不 `WHERE` 进数组/JSON 载荷(只整存整取),故放弃原生数组/jsonb 的查询能力**零损失**。

**3. 落库前后双向 Zod 校验,真值源严格对齐 core 导出物。** 写:repository 入参先过 core 的 `*Schema.parse`,失败抛错不写。读:db 行 → 重建领域对象 → 再过 Zod,返回类型化对象而非裸行。**存储编码与校验分层**:数组/`corrected_spec` 列在 repo 工具层做 `JSON.parse`/`stringify`、金额做 `Math.round` 整数分 ↔ 元换算,这只是**存储定标编码、非领域计算**——core 仍是价格/单位换算/可比的唯一来源,repo 不引入任何领域判断(对齐 CLAUDE.md「AI 只理解不计算」红线:分↔元是定标编码,不是单价/可比那类领域计算)。Zod 校验始终对**领域对象**(不是对 JSON 串),解码后再 `*Schema.parse`。**关键约束**:`unit_price` 落的是 **`CalcResult`(calculator 输出 `{unitPrice:{per100ml,formula}, confidence, warnings}`)**,**不是** `UnitPrice`——`UnitPriceSchema` 只有 `{per100ml,formula}` 两字段,`confidence`/`warnings` 不属 `UnitPrice`。core **未导出** `CalcResultSchema`(仅 interface),故校验拆开:嵌套 `unitPrice` 用 `UnitPriceSchema`、`warnings` 用已导出的 `WarningsSchema`、`confidence` 用 `z.number().min(0).max(1)`。**两个 confidence 是不同的值**:`product.confidence` = `ParsedSpec.confidence`(解析中间置信,parser),`unit_price.confidence` = `CalcResult.confidence`(最终权威 band,calculator 注释明示 single authoritative)——两列分别标注,不是真值漂移而是两个语义不同的量。(若未来想对 `CalcResult` 做整体 Zod 校验,需 core 导出 `CalcResultSchema`——属 core 的后续小改,非本变更范围。)

**4. product_raw 与 product 分离 + 不可篡改原始事实。** `product_raw` 存原始上报(去重键 upsert),`product` 存派生规范商品(关联 raw)。`corrections` 以独立行表达纠错,**不就地改 raw**——保留原始观察供回溯与 eval 真值。

**5. comparison_group 不物化。** 按 taxonomy §九,对比组是查询结果非实体;本次不建该表,避免日后改查询时的迁移债。

**6. 本地测试用 in-memory SQLite;迁移幂等靠 journal 而非 IF NOT EXISTS。** in-process SQLite(`better-sqlite3` 或 `@libsql/client` 内存库,或 Miniflare D1),`pnpm -r test` 不依赖任何外部托管 DB,且与生产 D1 同方言(SQLite)。**driver 差异须主动对齐**(同方言 ≠ 同运行时):裸 SQLite 默认 `PRAGMA foreign_keys=OFF`、驱动行为可能随版本/换型漂移,而 D1 强制 FK——测试基座**必须**显式开 FK(`PRAGMA foreign_keys=ON`,与 D1 强制 FK 对齐),否则 `saveParsed` 单事务的 FK 回滚原子性会**假绿**;原子性测试的失败注入用测试库上确实生效的手段(mock 抛错或约束违反,且 FK 已开)。迁移在注入连接上由 drizzle 应用(测试直连、生产 D1 binding,schema/查询同 sqlite-core)。**迁移幂等机制**:drizzle-kit 默认生成**裸 `CREATE TABLE`**(非 `IF NOT EXISTS`),幂等由 **migration journal**(`__drizzle_migrations` 表记录已应用迁移)实现——重复 `drizzle-kit migrate` 跳过已应用项,故验收测的是「重跑 migrate 命令」而非「重放同一 SQL 文件」(后者裸 CREATE 会报 already exists)。

**7. 表名 `product`(非旧 `product_spec`),SOT 已同步。** 本变更与 `docs/taxonomy-and-tagging.md` 的数据模型统一用 `product`(承载规范商品身份、非仅 spec)。`docs/architecture.md` §五 SOT 表清单**已随本提案同步**收敛为 `product_raw / product / unit_price / corrections`(并标注 `comparison_group` 改动态查询、不物化),故无 `public-deploy` 引用时撞 SOT 的窗口期。task 5.4 仅作落地后的一致性核对。

**8. 配置缺失显式失败。** 生产用 D1 binding(由 Worker 注入,`public-deploy` 阶段在 wrangler 声明);本地/测试用 SQLite 文件或内存库连接。connection/binding 缺失或打不开时,repository 初始化**抛错**,禁止返回看似可用的空实例(对齐既有 `classifyError` 的 5xx-config 语义)。repository 接受注入连接(D1 binding 或 sqlite 句柄),不在本层耦合 binding 获取方式。

**9. 去重键字段强约束 + 写入原子性。** 去重键 `(store, store_sku)` 是 `product_raw` 的溯源增列、**不在** `RawProductSchema` 内,故 `RawProductSchema.parse` 不会校验它们;repository 的 `upsertRaw` **必须额外**校验 `store`/`store_sku` 非空(空串/缺失即拒写),且两列在 schema 中为 `NOT NULL`——否则空 `store_sku` 会让所有无 SKU 上报坍缩成一行,破坏键的确定性。`saveParsed` 一次写 `product` + `unit_price` 两表,**必须在单事务内**(全成或全败),避免有 product 无 unit_price 的孤儿。注:D1 不支持显式事务语句(裸 `BEGIN`/`COMMIT` 被运行时拒绝),`saveParsed` 的全成或全败在 D1 上由 `batch()`(D1 原生原子批,整组原子、失败整组回滚)实现、在 better-sqlite3 上由原生同步事务实现。

## 风险 / 权衡

- **D1 容量/并发上限**:D1 单库 ~10GB、写并发弱于 Postgres。缓解:beverage SKU + 单价的数据量远未触顶;众包写入量级 D1 够用;真撑爆时按决策 1/2 迁 Postgres——因可移植类型 + repository 契约/core SOT 不变,schema 仅换方言包壳 + 一次数据导出/转换/导入,非 rip-and-replace。
- **金额 float 风险**:`per100ml` 用 REAL(float)——但它是排序/展示比值,非记账值,float 误差不影响榜单序;`price` 用整数分(精确),不落 float。若未来需精确单价记账,迁 Postgres `numeric` 或继续用整数定标。
- **可移植性是设计不变量,非事后**:schema 禁用 PG-only 类型由本变更钉死(决策 2),不是迁移时才补救;代价是放弃原生数组/jsonb 查询——但本层从不查进载荷,零损失。
- **product 跨店身份未定**:本次 `product` 关联单一 raw、不做跨店同款合并(非目标)。后续若要合并,需引入稳定 product 身份键——现在留 `product_raw` 为账本、`product` 可重建,降低返工。
- **category 列预留 vs 后续 ALTER**:本次 `category` 为自由 string;`category-tagging` 将加品类列/外键。权衡:现在不加空列(YAGNI),由后续 change 的迁移 ALTER,代价是一次加列迁移——可接受。
- **合规面**:`product_raw` 只存主动上报商品(众包),原始抓包数据(HAR)**不入库**;repository 不含任何主动抓取逻辑。
