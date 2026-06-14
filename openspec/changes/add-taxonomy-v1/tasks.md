# 实现任务 — P2 · add-taxonomy-v1

> 范围:`packages/core`(tier1 叶规则·纯函数)+ `packages/db`(schema/迁移/seed/repository)+ `apps/api`(管线编排 + backfill)。不触 miniapp/extension(P3 消费)。AI 不判定品类(红线)。backfill 不重放 `/ingest`。设计细节见本变更 `design.md`,机制 SOT 见 `docs/taxonomy-and-tagging.md`。

## 1. core — 数据 schema + tier1 叶规则 + 仲裁(packages/core,纯函数无 IO)

- [x] 1.1 用 Zod 定义 tier1 规则的输入 / 输出类型(候选叶 + 命中证据 + attribute)+ 共享枚举:`kind`(`category`/`attribute`/`brand`/`product_line`)、`comparable_unit`(`per_100ml`;`per_100g`/`per_100sheet` **仅类型占位、本期不 seed**)、`source`(`rule`/`store-map`/`manual`);types 从 schema 推导,**禁止**手写重复 interface。注:`tag`/`product_tag`/`store_category_map`/`category_closure` 的**持久化行 schema** 落 `packages/db`(与 product/unit_price 同处,见 2.1),不放 core
- [x] 1.2 tier1 品类**叶**关键词规则(纯函数:`title → 候选叶 category + 命中证据`,**只产叶**):可乐/汽水/雪碧→碳酸饮料;苏打水/气泡水/含气矿泉→饮用水(+ attribute 气泡);果汁/植物饮→果汁·植物饮;茶/咖啡/能量→咖啡·茶饮;矿泉水/纯净水→饮用水。规则带显式优先级以解歧义(更深叶 > 优先级数 > 匹配长度)
- [x] 1.3 attribute 规则(纯函数:无糖 / 气泡 / 进口 … → attribute 标签)
- [x] 1.4 确定性仲裁纯函数:`(tier1 叶结果, store-map 结果) → 终裁叶 | 待人工`,覆盖 taxonomy §五 全表(粒度冲突取更深叶 / 同粒度 tier1>store-map / 仅一方命中 / 都无 → 待人工)
- [x] 1.5 core 单测(脏标题样本集):断言叶归属 + attribute + 仲裁(含粒度冲突、多叶 tie、未命中落待人工、气泡水归饮用水而非碳酸);`pnpm --filter @unit-price/core test`

## 2. db — schema / 迁移 / seed / repository(packages/db,可移植类型)

- [x] 2.1 `schema.ts` 加四表:`tag`(id/slug/name/kind/`parent_id`/`comparable_unit` **可空 TEXT**)、`product_tag`(product_id/tag_id/`source` TEXT 枚举/`confidence` REAL,`(product_id,tag_id)` 唯一)、`store_category_map`(store/native_category_id/tag_id,`(store,native_category_id)` 唯一)、`category_closure`(tag_id/ancestor_tag_id);`product` 加 `pending_category_tag_id`(**可空**,引用 tag)+ `rankable`(**`INTEGER NOT NULL DEFAULT 0`**——非空旧库加列安全)。两新列**不进 `dedupe_key`**。**仅用可移植类型**;**不建** `comparison_group`
- [x] 2.2 drizzle 迁移(可复现、本地持久层测试不依赖外部 DB,对齐 persistence「迁移可复现」)
- [x] 2.3 seed:规范品类树(`饮料 → 软饮(per_100ml) → {碳酸/果汁植物饮/咖啡茶饮/饮用水}`;`酒类(null)` 子树 rankable=false)+ 受控 attribute(无糖/气泡/进口…)+ 山姆 `store_category_map`(抓包 `categoryIdList` 叶 ID → tag,人工策展;**粗 native 只映非叶节点、不下放叶**;某 native 在 v1 树无对应节点时**该行不 seed**、留待人工)+ 对应 `category_closure`(叶 → 全部祖先含 root)。**本期 seed 禁用 `per_100g` / `per_100sheet`**
- [x] 2.4 repository:写 `product_tag`(幂等)、查 `category_closure`(命中靠 `product_tag`(**kind=category 叶**)JOIN `category_closure`;closure 仅含 category is-a 边,attribute/brand 轴不查 closure)、`comparable_unit` 继承解析(沿 is-a 向上找最近非空祖先)、`rankable` 派生写入;(可选)debug 读「某商品标签/归属/rankable」
- [x] 2.5 db 单测:闭包**全祖先**(碳酸饮料叶含 软饮 AND 饮料 root)、单归属收敛(写叶前删既有 kind=category 叶 → 规则改判后只剩新叶)、`comparable_unit` 继承(软饮→per_100ml / 酒类→null)、`product_tag` 幂等(重复挂同对 no-op)、`store_category_map` 粗 native 不映叶、加两列后 `dedupe_key` 不变、非空旧库加 `rankable`(DEFAULT 0)迁移成功、迁移可重放

- [x] 2.6 原子 `reconcileCategory` 原语(单事务 sqlite / 批 D1,镜像 saveParsed 双驱动):一组写(删旧叶 + 挂新叶/属性 + 设 pending + 重算 rankable)整体提交/回滚,杜绝 D1 部分写「有叶∧pending非空」越界态;**写前校验 kind**(叶位只接 category 叶、pending 只接非叶 category、属性非 category、缺 product → 抛);独立原语补守卫(`setPendingCategory` 非叶 / `attachTag` 叶粒度 / `setRankable` product 存在性)
- [x] 2.7 seed 落生产:加幂等 DML 迁移 `0004_seed_taxonomy.sql`(`INSERT OR IGNORE`、确定性 id、root→子序、prod wrangler 目录扫描自动 apply、**不入 drizzle journal**)+ 防漂移测试断言其产出与 `seedTaxonomy()` 结构等价、且 0004 可重复 apply 幂等

## 3. api — 打标签管线编排 + 现有库存 backfill(apps/api)

- [x] 3.1 打标签管线编排:调 core 规则(1.2–1.4)+ `store_category_map` 查 + 仲裁 → **写路径三态 reconcile**(裁决=叶:删旧叶+插新叶+置 pending=NULL;待细化:删旧叶+写 pending;待人工:删旧叶+pending=NULL;只动 kind=category 轴)、**重算 `rankable`** + 补 `category_closure` 命中。**本期无 LLM**;仲裁未命中 → **品类归属留空** + 待人工(三态按字段判别,见 spec);**禁止**改 `product.category` 列
- [x] 3.2 现有库存 backfill 入口:对已落库 `product`(**全量,约 445**)跑管线,**不重放 `/ingest`**(first-write-wins),**单归属收敛 + 重算 rankable**,**幂等**可重跑(同快照结果一致、规则改判后只剩新叶);**本期 backfill 对 store-map 惰性**(`nativeCategoryId=null`——无 ingest 字段承载原生 id,见 design D9),tier1 为活跃路径,经原子 `reconcileCategory` 写
- [x] 3.3 (可选)debug 端点:查某商品的标签 / 归属 / rankable(便于验证,非对外契约)
- [x] 3.4 api 测试:对样本 backfill → 叶归属 + attribute + `rankable` 派生 + 待人工分支正确;重跑幂等;全程无 LLM 调用

## 4. 验证

- [ ] 4.1 对现有库存(生产现状约 **445 个 product 全量**,非仅 per100ml 子集)跑 backfill:可判定项获叶品类归属 + 适用 attribute + `category_closure` 填充(含 root);`rankable` 按规则重算。**此为生产 / 人工执行项、非 CI 门**(逻辑正确性由 3.4 样本自动测覆盖)
- [x] 4.2 数据层断言:酒类叶 `rankable=false`;仅粗映射的「待细化」`rankable=false`、未写叶 `product_tag`、`pending_category_tag_id` 非空;「待人工」`pending` 为空——三态字段可分(rankable=false 不出榜 = 指 P3 cohort 榜);**跃迁**:待细化→命中叶后 `pending` 必清空、落已分类态,叶→待人工/待细化必删旧叶(无「有叶∧pending非空」越界态)
- [x] 4.3 不可判定项(tier1 与 store-map 都无确定叶)落「待人工」、`category` 留空,**未被强归**
- [x] 4.4 schema / 迁移核查:四表 + 两列存在且可移植类型;`rankable` 为 `NOT NULL DEFAULT 0`、**非空旧库迁移成功**;两新列**不进 `dedupe_key`**(去重收敛不变);三态可仅凭「有无叶 product_tag + pending 是否空」机械判别;`comparison_group` 不存在;迁移可重放
- [x] 4.5 红线核查:打标签全程确定性、**无 LLM 调用**(grep / 代码核查);backfill **不重放 `/ingest`**;`spec-parsing` 的 `category` 仍恒 `beverage`、`product.category` 列未被改;**`rankings-api` 未改**、本期 `/rankings` 仍按 `per100ml IS NOT NULL`(`rankable` 本期不接入)
