## 上下文

P3.5（[[cohort-scoped-rankings-shipped]]）后 prod 分类覆盖 rankable 347/376（~92%），残留 ~29 待人工 = 标题无类型/品牌词的高端酒长尾；并存在 tier1 关键词子串启发式的跨 cohort 长尾误判（`燕麦牛奶`→milk、白酒含 `茶`→coffee-tea，P3.5 显式 accepted-degraded）。

store-map 机件已就绪但**从不点火**（探查结论）：
- 表 `store_category_map(store, native_category_id, tag_id)` + 唯一键 `(store, native_category_id)`（`schema.ts:228`）；`SAM_CATEGORY_MAP` 14 行真实山姆叶 id（`seed.ts:171`，2 软饮叶 + 12 酒类行/5 酒种叶[wine×4/baijiu×3/whisky×2/beer×2/spirits×1]，手抽自 HAR；`sake-fruit-wine` 暂无种子行）。
- `lookupStoreCategory(store, nativeId)`（`repository.ts:1360`）+ `toStoreMapResult`/`tagProduct` 仲裁分支（`tagging.ts:74,99`）+ `arbitrate`（`category-rules.ts:503`，taxonomy §五 九格表）+ 5 条 store-map 单测（`tagging.test.ts`，用合成 native id）。
- **断点**：`listProductsForBackfill` 硬编码 `nativeCategoryId: null`（`tagging.ts:237`）；`ContributeRequestSchema`（`routes.ts:61`）+ `product_raw`（`schema.ts:28`）+ `upsertRaw`（`repository.ts:681`）都无 native-id 字段/列；`categoryHint` 是 `product.category='beverage'` 透传源、**不可复用**。

## 目标 / 非目标

**目标：**
- 让 store-map 在真实商品上点火：ingest 采 native-id → 落 `product_raw` → backfill 读它喂 `tagProduct`。
- 回填存量 ~376 的 native-id（native-id-only `UPDATE`，不重放 /ingest）。
- 用门店权威叶级 native 分类**填 tier1 miss 长尾**（待人工 ↓）+ **纠 tier1 跨 cohort 误判**（精度根治）。

**非目标：**（见 proposal）度数轴、跨店归一、miniapp 接通、LLM 判品类、改 P3.5 cohort 守卫/榜语义。

## 决策

### D1：native-id 是「门店 provenance」字段,不进领域 schema、不复用 categoryHint
- ingest 请求新增 `nativeCategoryId?: string`（trim、非空时有意义），与 `store`/`storeSku`/`source`/`sourceUrl`/`capturedAt` 同列为**门店来源 provenance**，**不**进 core `RawProductSchema`（领域规格只认 title/price/categoryHint）。
- `product_raw` 加可空列 `native_category_id TEXT`；`upsertRaw` 写入并对 conflict 走 **COALESCE**（重报带 native-id 则更新、省略则保留旧值——与现有 source/sourceUrl provenance 同语义，不在 price-only 重报时清空）。
- **禁复用 `categoryHint`**：它是 `product.category`（粗 'beverage'）的透传源,塞 native-id 会污染领域列——代码注释（`tagging.ts:38`）已明令。

### D2：product_raw.native_category_id 用常规 drizzle DDL 迁移(ADD COLUMN),非 0004/0005 式 DML
- 这是 schema 变更（加列），走 `drizzle-kit generate` 生成的 DDL 迁移并登记 `_journal.json`，区别于 0004/0005 那种目录扫描、**不登记 journal** 的幂等 DML 种子迁移。
- **迁移编号陷阱（必须按此执行，否则 prod 迁移撞车 — 经 `drizzle-kit generate` 实测复现）**：`_journal.json` 当前最大 idx=3（`0003`），而磁盘上的 `0004_seed_taxonomy.sql` / `0005_seed_dairy_alcohol_units.sql` 是**不在 journal 内**的 DML。`drizzle-kit generate` 按 journal 末位 `max(idx)+1` 推下一号 → 产出 **`0004_<slug>.sql`**，与磁盘既有 `0004_seed_taxonomy.sql` **同前缀**；prod `wrangler d1 migrations apply` 按**数字前缀**目录扫描——新 `0004_<slug>` 是 `d1_migrations` 未记录的**新文件名**，会被单独应用一次（nullable ADD COLUMN 与 DML 种子无序依赖、**不会报错也不会重跑 0004/0005**），真正危害是**编号非单调 + 下次 generate 撞 0005（见④）+ CI drift 守卫查不出裸 `0004` 提交**，故必须改名规整。**执行序列**：① 改 `schema.ts`；② `pnpm --filter @unit-price/db generate`；③ 手工把产出 `0004_<slug>.sql` → **`0006_<slug>.sql`**、`meta/0004_snapshot.json` → `meta/0006_snapshot.json`；④ 改 journal 新条目为 **`idx:6, tag:"0006_<slug>"`**（**idx 必须=6、与文件名前缀一致**——勿留 `idx:4`：drizzle-kit 下次 generate 取 `max(idx)+1`，留 4 则下个迁移=`0005_<slug>` 又撞磁盘 `0005_seed_dairy_alcohol_units.sql`；设 6 = 当时磁盘最高前缀(0005)+1。journal 在 idx 4/5 留空档无碍，migrator 以 `tag` + `when` 时间戳按数组序应用、与 idx 无关——**保留 generate 产出条目的 `when`/`breakpoints`，仅手改 idx+tag**）；⑤ 再跑一次 `generate` 确认 `git status --porcelain packages/db/drizzle` 干净（= CI `Drizzle migration drift` 守卫 `ci.yml:41-49` 所查）；⑥ `pnpm --filter @unit-price/db test`（journal 驱动的 `migrate()` replay 幂等测试会跑到新条目）。
- **注意**：CI drift 守卫只查 `generate` 幂等，**不查前缀唯一/单调**——裸 `generate` 的 `0004_<slug>` 提交也能过 CI，却会在 prod 部署期编号错乱。故上面的改名是唯一安全网，必须写进 task 1.1。
- **通用不变式（递归适用，非一次性）**：drizzle-kit generate 对磁盘上 unjournaled DML（`0004_seed`/`0005_seed`，及 4.2 将加的 `0007_seed`）**盲**、只按 journal `max(idx)+1` 取号。故**每次新生成的 journaled DDL 迁移都必须改名到「磁盘最高数字前缀 + 1」之上、并把 journal idx 设成同值**（本次 = `0006`，因当时磁盘最高 = `0005`；待 4.2 落 `0007_seed` 后，**再下一个 DDL 须改到 `0008`**）。这是既有 unjournaled-DML 惯例的固有代价、CI drift 守卫查不出，只能靠该纪律——**勿误以为 `0006` 之后下一个 generate 槽位天然空闲**。
- prod `product_raw` 非空 + push-main 自动 migrate → 列加为 `TEXT`（可空,无需 DEFAULT；SQLite 加可空列对非空表安全，参照 `taxonomy.test.ts:495` 既有非空表 ALTER 模式）。
- 不动 `store_category_map` 表结构（已就绪）。

### D3：存量回填 = native-id-only 写(UPDATE/COALESCE),不重放 /ingest
- 存量 376 当初经运营自抓 HAR → ingest 落库（仅标题/价格）。回填**只补 `native_category_id` 一列**：HAR 提取器新抽每条 `categoryIdList` **叶 id（路径末端）** + `(store, storeSku)`，**产出一个幂等 SQL 文件**（每行 `UPDATE product_raw SET native_category_id = COALESCE(native_category_id, '<nativeId>') WHERE store='<s>' AND store_sku='<sku>';`——**只补空**：保留已有 native_category_id[如前向 ingest 已写]，仅填 null 行），经 **`wrangler d1 execute DB --env production --remote --config apps/api/wrangler.toml --file <生成.sql>`** 对既有行执行（`--config` 必带，否则从仓根解析不到 `DB` 绑定；只动 native 列、**不碰 title/price**、不触发解析）。**不新增 admin 路由**（避免动 `contribute.test.ts` 冻结的路由集断言）；`d1 execute` 不被部署守卫 `check-no-prod-drizzle-migrate.sh` 拦（它只拦 `drizzle-kit migrate`）。
- **不走 /ingest 重放**（重要，遵 [[ingest-write-once-needs-backfill]] 既定教训）：`/ingest`/`upsertRaw` 会把 title/price 覆写为重放观测（dedupe 契约本就「title/price 跟最新观测」），且 `/ingest` 触发后台 tier2 解析 + `saveParsed`——若重放 HAR 与原捕获 spec 不同会产生**重复 product 行**、并白耗 LLM/子请求预算。故存量回填用 native-id-only UPDATE，而非 D1 的 upsertRaw COALESCE 路径（后者是**前向**新捕获带 native-id 的落库路径，会一并更新 title/price=最新观测，语义正确但不可用于「只补一列」的存量回填）。HAR 提取器叶 id 抽取已被真实 HAR 验证（`categoryIdList` 存在、稳定数值路径、簇纯净，见 taxonomy §七.1 / [[sam-har-calibration]]）。
- **storeSku 对齐需先验证（非默认成立）**：回填命中依赖 HAR 抽取的 `(store, storeSku)` 与既有 `product_raw` 行键一致；若不一致，UPDATE **0 命中**、本变更对存量的核心收益落空。故 HAR 提取器须**显式产出 storeSku**（与当初 ingest 落库所用去重键同源），批量 UPDATE **前**先做一次只读 join-rate 校验（抽取键 ∩ 既有 `product_raw` 命中率）；命中率过低先查 key 口径、**勿盲灌**。漏配行 `native_category_id` 留 null（退化 tier1，不回退、不损坏）。

### D4：backfill 读 native-id 列点火,机件其余不变
- `listProductsForBackfill` 去掉硬编码 `nativeCategoryId: null`，改 select `product_raw.native_category_id` 并传入 `tagProduct`。
- `tagProduct` 现有 `if (store != null && nativeCategoryId != null)` 守卫即自动点火 store-map lookup；`lookupStoreCategory` / `toStoreMapResult` / pending/manual 三态机件不变。
- 重跑 `POST /admin/backfill`（幂等、可重复驱动，见 backfill-runbook）：native-id 已落的行经 store-map 重分类；归属变化必重算 `rankable`（既有契约）。

### D5（核心）：native 叶级 store-map 优先于 tier1 关键词;粗 native 仍不压 tier1 叶
- 现仲裁（taxonomy §五）同粒度叶冲突 = **tier1 > store-map**（store-map 覆盖部分、native-id 未接通时的保守序）。本期接通**叶级**权威 native 后反转该格：**native 叶 store-map 命中 ≻ tier1 叶**。
- 理由：门店自身的叶级 native 分类是该商品分类的 ground truth；tier1 是关键词子串启发式、长尾必有跨 cohort 误判（`燕麦牛奶`→milk）。接通 native-id 的**全部意义**就是用权威叶纠正启发式误判。native 缺失（未回填/新店无 map）时仍走 tier1（多数历史行直到回填）。
- **保留的格**：① 粒度——**粗 native 节点（非叶）仍 < tier1 叶**（tier1 叶更具体,粗 native 只能 pending）；② native miss + tier1 命中 → tier1；③ 都 miss → 待人工。即新序：`native 叶 ≻ tier1 叶 ≻ native 粗节点(pending) ≻ 待人工`。
- 落点：`arbitrate(tier1, storeMap)` 在 `tier1 有叶 ∧ storeMap.kind==='leaf'` 时——**异叶**（store-map 叶 ≠ tier1 叶）→ 返回 store-map 叶（`decidedBy=store-map`，不再让 tier1 叶覆盖）；**同叶**（store-map 叶 === tier1 叶）→ **仍 `decidedBy=tier1`**（叶相同时不翻 provenance，避免把本就分对的商品 `product_tag.source` 由 `rule` 批量 churn 成 `store-map`，且保持 `category-rules.test.ts:320-322` 同叶用例不变）。taxonomy §五 九格表 + `category-rules.test.ts` 仅翻**异叶**那格：把 `category-rules.test.ts:315-317`（异叶抽象格 carbonated×juice-plant）改判 `decidedBy=store-map`，**并新增** `燕麦牛奶`+native juice-plant→juice-plant 纠偏用例（315-317 本身用 carbonated、非燕麦牛奶用例）。

### D6：扩 SAM_CATEGORY_MAP 覆盖 = 运维抓一次软饮足量 HAR + 补叶 id
- 原 HAR 偏酒类,`咖啡·茶饮`/`饮用水` 叶 native id 未抽到（`seed.ts:157` 已注明）。补这两叶 + 更多酒种 native 叶 id 需一次**软饮足量**的山姆 HAR 抓取（运维项,产出 = 新增 `seed.ts` `SAM_CATEGORY_MAP` 行 + 回填这些 id）。新增行须同步一个 **`0007_seed_<slug>.sql`** 目录扫描 DML 迁移（编号 = 当时磁盘最高前缀 0006 + 1，遵 D2 不变式；unjournaled、`INSERT OR IGNORE`、id 用 `seedTaxonomy()` 同一确定性方案），并接进 seed-parity 测试的 `apply0004()`（`taxonomy.test.ts:918`，重命名为 `applySeedMigrations`、加 0007），否则 byte-identical 断言失败（见 tasks 4.2）。
- 缺这步不阻断核心接通（已有 14 行覆盖酒类大头 + 2 软饮穿刺线）；它是覆盖增量、提升 store-map 命中率。

## 风险 / 权衡

- **[D5 反转] 错误的 native 叶 map 行会批量误路由**（一行错 → 该 native id 下全部商品错归）。缓解：`SAM_CATEGORY_MAP` 是**叶级手抽 + HAR 验证**（leaf→leaf,非粗下放）；native 叶 > tier1 仅在**真冲突异叶**时翻（多数行无 native-id 仍 tier1）。比起 tier1 长尾误判的「有界但确定错」,native 优先是「权威源纠偏」,净精度升。**但反转后 blast radius 严格大于反转前**（一行错 map 现能压过本来分对的 tier1 叶）——故 store-map 精度抽样由「可选」**升为回填验收必做项**（见迁移计划⑤ / tasks 6.3 / 7.4）：抽样 tier1 叶在 store-map 下被改写的商品，**人工**核对其标题语义 / 山姆自身展示分类与 store-map 落叶是否一致，落错（= 该 `SAM_CATEGORY_MAP` 行错）即视为 blocker、回滚该 map 行后再宣告成功。（注：eval-harness 目前**无** native 叶真值字段[corpus 只有 `samPkgNum`]；自动化精度评测需先在 `packages/eval` 建该真值字段，属后续；本期门用人工抽样即可，不依赖尚不存在的 `samCategoryLeafId`。）
- **[D3 storeSku 对齐] 存量 storeSku 对不齐**：HAR 提取的 `(store,storeSku)` 须与既有 `product_raw` 行键一致 UPDATE 才命中。缓解：storeSku 即 ingest 去重键、本就来自同源 HAR；但**对齐需先验证**（批量 UPDATE 前做只读 join-rate 校验，见 D3），漏配的行 native_category_id 留 null（退化为 tier1,不回退）。
- **[加列] 迁移**：prod 非空表加可空 `TEXT` 列、SQLite 安全;自动 migrate 沿用既有 GH Actions。
- **[覆盖] 软饮叶 native id 仍缺**直到 D6 的 HAR 抓取：这两叶继续靠 tier1（已覆盖良好）,不阻断。
- 合规:仍只消费运营自抓 HAR 的门店自有 categoryIdList,无新增爬取面。

## 迁移计划

- DB：`drizzle-kit generate` 出 `product_raw` ADD COLUMN `native_category_id` 迁移，**按 D2 执行序列改名为 `0006_<slug>.sql` + 改 journal tag + 再 generate 确认 `packages/db/drizzle` 无 diff**（裸 generate 的 `0004_<slug>` 会撞 prod，详见 D2）。
- 部署：含代码 → feature 分支 + PR;合并 main 自动 migrate + deploy。
- 合并后（运维）：① **先**只读 join-rate 校验 HAR 抽取 `(store,storeSku)` 与既有 `product_raw` 对齐率（D3，过低先查 key 口径）;② HAR 提取器抽存量 native 叶 id → **native-id-only `UPDATE`** 回填 `native_category_id`（只补 native 列、不碰 title/price、不走 /ingest；对齐行命中、漏配留 null）;③（运维）软饮足量 HAR 补 `SAM_CATEGORY_MAP` 软饮叶 + **新增 `0007` 目录扫描 DML 种子迁移**;④ 重跑 `POST /admin/backfill`;⑤ **store-map 精度抽样（必做）**：离线重放 `tagTier1Leaf`+`lookupStoreCategory` 筛出被 store-map 改写的 tier1 叶样本 → **人工**核对标题语义/山姆展示分类与落叶是否一致，tier1-对→store-map-错=blocker（回滚该 `SAM_CATEGORY_MAP` 行;不依赖尚不存在的 `samCategoryLeafId`）;⑥ 数据门:待人工 ↓、tier1 跨 cohort 误判被 native 纠正、各 cohort 基数更准、`store-map 决定数 > 0`（`/admin/backfill` 响应的 `storeMapDecisions` 字段——= 该块内 `decidedBy=store-map` 的叶决定数;backfill 分块续跑,门值须**跨所有块累加**;同叶认同[记 tier1]、粗 native[落 pending]按设计不计入,故 >0 即证 store-map 在主动定叶）。
- 回滚:列可空、native-id 缺失退化为 tier1;仲裁反转为读路径逻辑、回滚还原即可,无数据副作用。
