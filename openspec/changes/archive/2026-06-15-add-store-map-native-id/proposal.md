## 为什么

store-map 的轨道早已铺好——`store_category_map` 表、14 条山姆 native 叶 id 种子、`lookupStoreCategory`、打标签管线的 store-map 仲裁分支、单测——但**从不在真实商品上点火**：ingest 不采集山姆 native `categoryIdList`、`product_raw` 无对应列、`listProductsForBackfill` 把 `nativeCategoryId` 硬编码为 `null`（`apps/api/src/tagging.ts:237`）。后果是分类**只靠 tier1 关键词**，留下 P3.5 实测的两类残债：① **~29 待人工**（标题既无类型词又无品牌词的高端酒长尾，如裸 `剑南春`/`水井坊`，tier1 必然 miss）；② **tier1 长尾精度误判**（如 `燕麦牛奶`→`milk`、含 `茶` 的白酒→`coffee-tea`——关键词子串启发式的固有跨 cohort 误归，P3.5 作为 accepted-degraded 显式留给本期）。

接通 native-id 让**门店自身的叶级分类**成为 ground truth：tier1 miss 的长尾由 store-map 兜住（填待人工），tier1 误判的跨 cohort 错归由权威 native 叶纠正（根治精度）。

## 变更内容

- **ingest 采 native-id**：`/ingest` `/contribute` 请求新增**专用 provenance 字段** `nativeCategoryId`（山姆 `categoryIdList` 路径末端叶 id 字符串）——**不复用 `categoryHint`**（后者是 `product.category='beverage'` 的透传源，会污染）、**不进 core 领域 `RawProductSchema`**（native-id 是门店来源、非领域规格）。`product_raw` 加可空 `native_category_id` 列；`upsertRaw` 写入，沿用 provenance 的 COALESCE 语义（重报带值则写、省略则留旧）。
- **存量 HAR 回填**：现有 ~376 prod 商品当初仅采标题/价格、无 native-id。经山姆 HAR 提取每条 `(store, storeSku, categoryIdList 叶 id)`，对既有行做 **native-id-only `UPDATE`**（只补 `native_category_id`、不碰 title/price、不触发解析；**不重放 /ingest**，遵 [[ingest-write-once-needs-backfill]]）回填存量，使其可被 store-map 命中。
- **打标签管线点火**：`listProductsForBackfill` 改为**读 `product_raw.native_category_id` 列**并传给 `tagProduct`（取代硬编码 `null`），store-map 分支随之点火。`lookupStoreCategory` / 仲裁机件不变。
- **仲裁优先级（核心决策）**：native **叶级** store-map 命中**优先于** tier1 关键词（反转现「tier1 > store-map」的同粒度叶冲突格）——门店自身叶级 native 分类是权威 ground truth、本就是接通 native-id 的目的；native 缺失时仍走 tier1；**粗 native 节点仍不压 tier1 叶**（粒度规则不变）。详见 design。
- **扩 store-map 覆盖**：补软饮叶（`咖啡·茶饮`/`饮用水`，原 HAR 偏酒类未抽到）+ 更多酒种 native 叶 id（需一次软饮足量的 HAR 抓取，运维项）。
- **重跑 backfill + 验收**：合并部署后重跑 `POST /admin/backfill` → 待人工 ↓、tier1 误判被 native 纠正、各 cohort 基数更准。

## 功能 (Capabilities)

### 新增功能
（无——均为既有能力扩展）

### 修改功能
- `contribute-ingest`: ingest/contribute 请求 + 落库新增 `nativeCategoryId` provenance 字段（专用、不复用 categoryHint、不进领域 schema；空串/空白/显式 null 均落 null 不报错）；存量经 native-id-only `UPDATE` 回填（非 /ingest 重放）。
- `persistence`: `product_raw` 加可空 `native_category_id` 列 + 幂等迁移；`upsertRaw` 写入并 COALESCE；`listProductsForBackfill` 读该列。
- `category-tagging`: backfill 传 native-id 使 store-map 点火；仲裁同粒度叶冲突由「tier1>store-map」改为「native 叶 store-map > tier1」（粗 native 仍 < tier1 叶）；扩 `SAM_CATEGORY_MAP` 覆盖。

## 影响

- `packages/db`：`schema.ts` product_raw 加列；新增幂等 DDL/迁移；`repository.ts` `upsertRaw` 写 native_category_id、`listProductsForBackfill` 读它（去掉硬编码 null）；`seed.ts` `SAM_CATEGORY_MAP` 扩行。
- `packages/core`：`category-rules.ts` `arbitrate` 同粒度叶冲突优先级反转（native 叶 > tier1）+ 仲裁表单测更新（taxonomy §五）。**不动 calculator、不引入 LLM 判品类（红线）**。
- `apps/api`：`routes.ts` `ContributeRequestSchema` 加 `nativeCategoryId`（可空）；`tagging.ts` backfill 入参传 native-id。
- `packages/api-client`：**无需改动**——api-client 只承载读路径契约（rankings/categories），不含 ingest/contribute 请求 schema；ingest body 校验的唯一落点是 `apps/api/src/routes.ts` `ContributeRequestSchema`（经 `upsertRawOrNull` 单一落库映射喂三端点）。
- 运维：一次软饮足量 HAR 抓取（补软饮叶 native id + 新增 `0007` DML 种子迁移）；native-id-only `UPDATE` 回填存量 native_category_id（先 join-rate 校验对齐）；重跑 backfill + store-map 精度抽样 + 数据门。
- **合规**：仍只消费运营自抓 HAR 的门店自有分类，不新增爬取面（架构第七节风险分层无新增暴露）。

## 非目标

- per-纯酒精/度数轴 value 榜（仍 v2，独立提案）。
- 跨店同款匹配（native-id 接通是其前置，但跨店归一本期不做）。
- miniapp 分类树 Tab 接通（API/数据定对即可，端接通留小程序变更）。
- 不引入 tier2 LLM 判品类（红线）。
- 不改 P3.5 的 cohort 守卫 / 榜语义（本期只改「叶归属来源 + 仲裁优先级」，不动 rankings/category-tree 读路径契约）。
