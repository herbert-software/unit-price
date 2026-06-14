## 上下文

P1 上线 3-Tab 骨架,「分类」为占位。P2 落地 `taxonomy-and-tagging.md` v1 数据底座 + 确定性打标签管线,供 P3 的品类树榜消费。现有持久层:`product_raw / product / unit_price / corrections`(可移植类型、first-write-wins);`product.category` 恒 `beverage`;`rankings-api` 按 `per100ml IS NOT NULL` 取扁平榜。约束:AI 不判定品类(红线);core 纯函数无 IO;backfill 不重放 ingest(first-write-wins,见 [[ingest-write-once-needs-backfill]]);山姆 native 品类来自抓包 `categoryIdList` 叶 ID(见 [[sam-category-taxonomy]])。

## 目标 / 非目标

**目标:** store-agnostic 品类 is-a 树 + 正交标签轴 + 闭包落库;确定性打标签管线(tier1 叶规则 + 山姆 native 映射 + 仲裁,AI 不参与);`rankable` 派生;现有库存 backfill。为 P3 备好「按 category 闭包 ∧ attribute 取 cohort」的数据。

**非目标:** LLM 候选打标签(v2)、eval 品类准确率维度(v2)、品类树榜 API / 分类 Tab 真数据(P3)、酒类排名、per_100g/per_100sheet 计算(v2);不动 `spec-parsing`(category 恒 beverage)、`unit-price-calc`、`rankings-api`。

## 决策

- **D1 三层落点(对齐架构 tier 边界)。** tier1 品类**叶**关键词规则 + attribute 规则 → `packages/core`(纯函数、无 IO、脏标题样本集单测);`store_category_map` 查 + 仲裁 + 写 `product_tag`/`pending`/`rankable` + 补闭包 + backfill → `apps/api`(IO);schema + 迁移 + seed + repository(tag/closure/product_tag 读写)→ `packages/db`。**理由**:打标签的确定性判定与解析同属 core 的「规则」职责、可双端可单测;落库/编排是 IO 属 api。
- **D2 闭包物化在 tag 维、不在 product 维。** 物化 `category_closure`(叶 tag → 全部祖先 tag),写时(seed / 挂叶)补;读时商品命中靠 `product_tag` JOIN `category_closure`。**理由**:品类树极小(~10 节点),tag 维物化避免查询期递归、零爆炸风险;`product×祖先` 大表不物化(规模大、随商品增长)。**取舍**:挂叶 / 改归属时需维护闭包行——但叶→祖先是静态(树固定),实际只在 seed 时一次性建,商品侧不写闭包。
- **D3 `comparable_unit` 解析走继承、不每叶冗余。** 解析某节点单位 = 取自身、null 则沿 is-a 向上找最近非空祖先。v1 树浅(`per_100ml` 绑软饮),在**派生 `rankable` 时**解析一次。**理由**:单点绑定 + 继承避免每叶重复维护;v1 只 `per_100ml`,解析平凡。
- **D4 `rankable` 存派生列、不读时算;归属变化必重算。** 打标签 / backfill / 人工纠错时算 `rankable`(已分类叶 且 继承单位非空)写入 `product.rankable`;读路径(P3 榜)直接过滤,不每次 JOIN 树。**所有写品类归属的路径(backfill / 挂叶 / 纠错)必须统一重算 `rankable`**(立为可测验收,见 category-tagging spec),避免陈旧。迁移加列用 `INTEGER NOT NULL DEFAULT 0`(非空旧库安全,见 D8)。
- **D5 backfill 不重放 ingest、写路径三态 reconcile、幂等。** 对已落库 `product` 跑管线;**写品类归属时把三态字段整体收敛到裁决**:裁决=叶 → 删旧叶 + 插新叶 + **置 `pending=NULL`**(落叶清 pending);裁决=待细化 → 删旧叶 + 写 pending;裁决=待人工 → 删旧叶 + `pending=NULL`。绝不出现「有叶 ∧ pending 非空」越界态;只动 `kind=category` 轴、不误删正交标签。`(product_id, tag_id)` 唯一防重复 → 同快照重跑幂等;以迁移 / 一次性脚本执行,**不重放 `/ingest`**(first-write-wins)。
- **D6′ `rankable` 与本期 `/rankings` 判据的边界。** 本期 `rankable` **只落列、无下游读**:现有 `GET /rankings` 仍按 `per100ml IS NOT NULL`(`rankings-api` 不变)。故可算 per100ml 的待细化 / 待人工软饮**本期仍入现有扁平榜**——这是接受的已知状态;`rankable=false 不出榜` 的「榜」**专指 P3 品类树 / cohort 榜**,两套判据 P3 收敛。**理由**:本期不碰 rankings-api(非目标),只备数据。
- **D6 山姆 native 映射人工策展、与 eval 金标准分开。** `store_category_map` 的山姆 `native_category_id`(抓包 `categoryIdList` 叶 ID)→ 我方 tag 由**人工策展 seed**;它用于「打标签」,与未来 eval 的「评打标签」金标准**两表分开、不自指**(eval 金标准属 v2)。
- **D7 `product_tag.source` 本期仅 `{rule, store-map, manual}`。** 无 `llm`(LLM 候选 v2);`confidence` 为 REAL、记规则 / 映射置信。
- **D8 非空旧库迁移安全。** `product.rankable` 用 `INTEGER NOT NULL DEFAULT 0` 加列(SQLite 非空表加无 DEFAULT 的 NOT NULL 列会报错;生产 product 非空、push main 自动 migrate);`pending_category_tag_id` 可空。两新列**不进 `dedupe_key`**(溯源 / 派生增列,类同 `raw_id`)。**三态字段判别**:已分类叶 = 有叶 `product_tag` ∧ pending 空;待细化 = 无叶 ∧ pending 非空;待人工 = 无叶 ∧ pending 空——`product.category` 列(恒 beverage)不参与三态、本期不动。

- **D9 store-map 本期在生产 backfill 惰性、tier1 为活跃路径。** 现状**无 ingest 字段承载 store 原生品类 id**:`product_raw.category_hint` 是 `product.category` 的透传源(对山姆库存恒 `beverage`),**非**山姆 `categoryIdList` 数值叶 id(ingest 不采集 categoryIdList)。故 backfill **不喂 store-map**(`nativeCategoryId=null`);`store_category_map` seed + 仲裁的 store-map 分支是**为 P3 铺的轨道、由单测覆盖**,待 ingest 新增**专用** store-native-category-id 字段后在 backfill 接通。**理由/取舍**:软饮全量靠 tier1 即可分类、酒类即便 store-map 命中也 `rankable=false`,本期不接 store-map 不损主交付;**禁止复用 `category_hint` 承载原生 id**(否则污染「`product.category` 恒 beverage」红线)。
- **D10 seed 经幂等 DML 迁移落地生产。** `0003` 是纯 DDL,prod 经 `wrangler d1 migrations apply` 只建空表;若 seed 仅为 `seedTaxonomy()`(只测试调)则**生产品类树为空、整个特性失活**。故加 `0004_seed_taxonomy.sql`(`INSERT OR IGNORE` 幂等、确定性 id、root→子序;prod 由 wrangler 目录扫描自动 apply;**不入 drizzle `_journal.json`** 以免测试期 `migrate()` 双跑 + CI `drizzle-kit generate` 漂移),与测试用的 `seedTaxonomy()` 由**防漂移测试**断言结构等价。**顺序**:seed(0004)随 deploy 自动落地,先于人工 backfill(4.1)。

## 风险 / 权衡

- [软饮样本少、山姆 HAR ~66% 酒类 → 软饮叶细分校准不足] → v1 接受现有 4 叶;细分(气泡·电解质等)与单位校准待补软饮为主 HAR(taxonomy §八),非本期阻塞。
- [`rankable` 派生列陈旧:改归属忘重算 → 读到旧值] → 缓解:把「重算 rankable」绑进所有写归属的路径(backfill / 挂叶 / 纠错),不散落。
- [仲裁规则未覆盖的边界误归] → 落「待人工」(安全侧),宁缺毋滥;红线守住「AI 不判定、规则 + 人工定」。
- [闭包 / 标签数据与 P3 读路径耦合] → 本期不建读 API(P3),只落数据 + 提供 repository 契约,降低跨期返工。

- [tier1 短关键词(茶 / 可乐 / 咖啡)在**非饮料**脏标题上假阳(如「茶花籽油」误判咖啡茶)] → 本期 backfill 语料是**纯 beverage**(`product.category` 恒 beverage、山姆软饮全量),跨品类假阳输入不入语料、不可达;P3 语料扩面前补强(分级关键词 / denylist),非本期阻塞。
- [`product_tag.source=manual` 本期无编排写入点] → 它是**人工纠错**路径的 source;本期只提供 `attachTag` / `reconcileCategory` 原子,纠错编排属后续;本期生产写路径 = backfill 一条,source ∈ `{rule}`(store-map 惰性,见 D9)。

## 迁移计划

迁移加 `tag` / `product_tag` / `store_category_map` / `category_closure` 四表 + `product.pending_category_tag_id`(可空)/ `rankable`(`INTEGER NOT NULL DEFAULT 0`,非空旧库安全,见 D8)两列 + seed(规范树 / attribute / 山姆映射 / 闭包,**不 seed `per_100g`/`per_100sheet` 占位**)+ backfill 现有库存(单归属收敛 + 重算 rankable,见 D5)。**必须可复现、本地持久层测试不依赖外部 DB**(对齐 persistence「迁移可复现」)。回滚 = 删四表 + 两列(P3 前无下游消费,安全)。生产经 GH Actions migrate 应用(push main 自动)——故 `rankable` 的 `DEFAULT 0` 是不炸生产部署的硬要求。本期另加 `0004_seed_taxonomy.sql`(幂等 DML 种子,见 D10)使规范树真正落生产;三态写归属经 `reconcileCategory` **单事务(sqlite)/ 批(D1)原子收敛**(见 D5,杜绝 D1 部分写留下「有叶 ∧ pending 非空」越界态)。
