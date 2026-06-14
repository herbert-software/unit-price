## 为什么

P1 上线了「Sams值不值」3-Tab 浏览优先骨架,但**「分类」Tab 目前是占位**——没有品类树 / 标签数据底座。浏览优先比价的核心能力(按品类横向比、属性筛选、详情页同品类 cohort)全部依赖一套 **store-agnostic 的品类 / 标签体系**。本期(路线图 **P2**)落地 [`taxonomy-and-tagging.md`](../../../docs/taxonomy-and-tagging.md) 的 **v1 数据底座 + 确定性打标签管线**,为 P3(品类树榜 API + 分类 Tab 真数据)铺路。**用户侧暂无可见变化**——纯后端基建。

> 编号说明:本提案的 **P0–P9 指 [`docs/miniapp-roadmap.md`](../../../docs/miniapp-roadmap.md) 的小程序里程碑**,**非** `architecture.md` §八 的 Phase 1–4(后者 Phase 3 = 中心库 + 众包榜单 + 小程序、已上线;本期在其后)。

## 变更内容

- **schema**(`packages/db`,沿用可移植类型):新增 `tag`(`id`/`slug`/`name`/`kind ∈ {category,attribute,brand,product_line}`/`parent_id` is-a 树/`comparable_unit`)、`product_tag`(只挂**叶 / 原子**标签,`source ∈ {rule,store-map,manual}`/`confidence`)、`store_category_map`(`store`/`native_category_id` → `tag`)、`category_closure`(`tag_id` → `ancestor_tag_id`);`product` 增 `pending_category_tag_id`(可空,「粗分类 / 待细化」非叶终态指针)+ `rankable`(派生)。
- **seed 规范品类树**(从山姆「酒水饮料」树,用我们的命名):`饮料 → 软饮(comparable_unit=per_100ml,叶继承)→ {碳酸饮料 / 果汁·植物饮 / 咖啡·茶饮 / 饮用水}`;`酒类` 子树(`comparable_unit=null`、`rankable=false`、本期不出榜);受控 `attribute` 值(无糖 / 气泡 / 进口 …)。
- **确定性打标签管线**:tier1 关键词规则(`packages/core`,纯函数,**只产叶** category + attribute)→ 山姆 `native_category_id` 映射(`store_category_map`)→ **仲裁**(确定性优先级,见 taxonomy §五)→ 写 `product_tag` / `pending_category_tag_id` / `rankable` + 补 `category_closure`。**AI 不参与**(LLM 候选属 v2)。
- **现有库存 backfill**:对已落库商品跑打标签 + 补闭包(**走 backfill,不重放 `/ingest`**——ingest 为 first-write-wins,见持久化约定)。
- (可选)debug 查询:看某商品的标签 / 归属 / rankable,便于验证。

## 功能 (Capabilities)

### 新增功能
- `category-tagging`: store-agnostic 品类 is-a 树 + 正交标签轴(attribute / brand / product_line)+ is-a 闭包 + 确定性打标签管线(tier1 叶规则 + native 映射 + 仲裁,AI 不判定)+ `rankable` 派生 + 现有商品 backfill。`comparable_unit` 单点绑定(软饮)叶继承;v1 仅 per_100ml 软饮节点 rankable。

### 修改功能
- `persistence`: 需求「product 必须存规范商品且预留品类扩展位」——本期**引入** `tag` / `product_tag` / `store_category_map` / `category_closure` 四表(可移植类型)+ `product.pending_category_tag_id` / `rankable` 列;原「**禁止**建品类表」「不引入品类表」反转为「按 `category-tagging` 落地这些表」。`comparison_group` **仍不物化**(对比组改动态查询,留 P3);`product.category` **仍恒 `beverage`**(`spec-parsing` 不动)。

## 非目标

- 不做 **LLM 候选打标签**(v2);本期只 tier1 规则 + native 映射 + 仲裁,均未命中 → **品类归属留空**(tag 维,不写叶 `product_tag`;`product.category` 列恒 `beverage` 不动)+ 标「待人工」。
- 不做 eval「品类标签准确率」维度(v2)。
- 不动 `spec-parsing`(`category` 仍恒 `beverage`)、不动 `unit-price-calc`(**重量轴 `per100g` 计算已是既有上线能力、本期不碰**;本期不引入的是 **`tag.comparable_unit` 的 `per_100g`/`per_100sheet` 取值**——本期不绑任何重量品类节点、仅类型占位,与计算层的 `unit_price.per100g` 是两层)、不动 `rankings-api`(仍 per100ml 扁平榜——品类树榜 = P3)。
- 不做品类树榜 API / 分类 Tab 真数据(P3);不做酒类排名(`comparable_unit=null` → `rankable=false`)。
- 不碰合规敏感面:打标签是对**已入库**商品的本地确定性 enrichment,**无新抓取、无众包写入**;backfill 用迁移 / 脚本,**不重放 `/ingest`**。

## 影响

- **`packages/db`**:schema(四张新表 + product 两列)+ 可复现迁移 + repository(写 `product_tag`、查 `category_closure`、派生 `rankable`)+ seed(规范树 / attribute 受控值 / 山姆 native 映射)。
- **`packages/core`**:tier1 品类**叶**关键词规则 + attribute 规则(纯函数、无 IO,配脏标题样本集单测)。
- **`apps/api`**:打标签管线编排(调 core 规则 + `store_category_map` 查 + 仲裁 → 写库 + 补闭包)+ 现有库存 backfill 入口。
- **不影响** `apps/miniapp` / `apps/extension`(P3 才消费品类树)。
- **合规面**:无——本地确定性 enrichment,无抓取 / 无众包写;backfill 非重放 ingest。
