## ADDED Requirements

> 术语固定(全规范):`product.category` **列**恒 `beverage`、`NOT NULL`、本期**不动**(spec-parsing 红线);本规范说的「**品类归属**」指由 `product_tag`(`kind=category` 叶)/ `pending_category_tag_id` 表达的 tag 维度,与 `product.category` 列**解耦**。凡「品类归属留空 / 待人工」一律指 tag 维(不写叶 `product_tag`),**绝不**改 `product.category` 列。

### 需求:品类 is-a 树 + 正交标签轴 + is-a 闭包(数据模型与不变量)

系统**必须**建立一套 **store-agnostic** 的品类 / 标签体系(完整设计见 [`taxonomy-and-tagging.md`](../../../../docs/taxonomy-and-tagging.md))。标签按 `kind` 分:`category`(品类,**is-a 树、单归属**,绑 `comparable_unit`)、`attribute`(属性,扁平多值、跨品类筛选)、`brand`、`product_line`。数据形状以 Zod schema 描述、types 从中推导,**禁止**手写重复 interface;**持久化行 schema**(`tag` / `product_tag` / `store_category_map` / `category_closure` 的存储列)与既有 `product` / `unit_price` 同处 `packages/db`,tier1 规则的输入 / 输出类型在 `packages/core`。

- **单归属**:一个**已完成分类**的商品**必须**经 `product_tag`(`kind=category`)归到**恰好一个叶子** category;`product_tag` **只挂叶 / 原子标签**,非叶「待细化」走 `product.pending_category_tag_id`(见三态需求)。
- **`comparable_unit` 单点绑定 + 向上继承**:绑在「软饮」(`per_100ml`),叶子继承、不每叶重复;解析某节点单位 = 取自身、null 则沿 is-a 向上找最近非空祖先,一路到 root 仍 null → 该节点不可排名,**禁止** null 单位进入排名。
- **闭包**:`category_closure` 存「叶 tag → 其**全部**祖先 tag(含 root)」,**仅含 `category` 的 is-a 边**;商品命中某节点靠 `product_tag`(`kind=category` 叶)JOIN `category_closure`(tag 维,不建 product×祖先 大表);attribute / brand / product_line 轴无 closure 行、天然不参与品类命中。
- **复合查询动态、不物化**:复合概念(无糖碳酸 = 碳酸闭包 ∧ `attribute:无糖`;所有气泡饮品 = `attribute:气泡` 跨子树并集)用原子标签 + 动态查询,**禁止**物化组合;`comparison_group` 表**禁止**建。
- **`store_category_map` 是 `(store, native_category_id) → tag` 的 N:1**(`(store, native_category_id)` 唯一);**粗 native 只能映非叶节点、禁止下放到叶**;无匹配 native → 不映射(留待人工)。

#### 场景:叶归属经向上传播成为祖先成员
- **当** `可口可乐 无糖 330ml*24` 打上叶 `品类=碳酸饮料` + `属性=无糖`
- **那么** 经闭包传播,它**必须**同时是 `碳酸饮料 / 软饮 / 饮料` 节点的成员(闭包含到 root)

#### 场景:comparable_unit 叶继承、酒类为 null
- **当** 解析「饮用水」「碳酸饮料」等软饮叶的 `comparable_unit`
- **那么** **必须**经继承得 `per_100ml`;解析「白酒 / 葡萄酒」等酒类节点**必须**得 `null`

#### 场景:气泡水跨轴用 attribute 表达、不误归碳酸
- **当** `屈臣氏苏打水 330ml*24` 打 `品类=饮用水` + `属性=气泡`
- **那么** 搜「碳酸饮料」(category 闭包)**禁止**含它;搜「所有气泡饮品」(`attribute:气泡`)**必须**含它与含糖汽水

#### 场景:山姆粗 native 只映非叶节点
- **当** 检查 seed 的山姆 `store_category_map` 行
- **那么** 粗 `native_category_id` 的映射目标**必须**是非叶节点,**禁止**出现「粗 native → 叶 tag」的下放行

### 需求:打标签必须由确定性程序决定,AI 不判定品类

打标签管线**必须**确定性:tier1 关键词规则(`packages/core`、**纯函数无 IO**、配脏标题样本集单测,**只产叶** category + attribute,同输入同输出)→ 山姆 `native_category_id` 经 `store_category_map` 映射 → **确定性仲裁**(对齐 taxonomy §五):两方命中粒度冲突 → 取更深叶;同粒度异叶 → tier1 > store-map;**tier1 多叶 tie(视作 tier1 无确定输出)而 store-map 命中干净叶 → 采 store-map 叶(不锁待人工)**;仅 store-map 命中粗节点(tier1 无叶)→ 暂停「待细化」(见三态需求);两方都无确定叶 → 品类归属留空 + 待人工(**不强归**)。**LLM 本期不参与**;品类 / 可比判断属红线,**禁止**由 LLM 决定(v2 才引入候选,且须过受控白名单 + kind 校验)。

#### 场景:标题命中叶关键词即确定归属
- **当** 标题含「可乐 / 汽水 / 雪碧」碳酸叶关键词
- **那么** tier1 **必须**确定性挂 `碳酸饮料` 叶;`苏打水 / 气泡水` **必须**归 `饮用水` 叶 + `attribute:气泡`

#### 场景:粒度冲突取更深叶
- **当** tier1 命中细叶、`store_category_map` 命中粗(非叶)节点
- **那么** 仲裁**必须**取更深叶,**禁止**停在粗节点

#### 场景:tier1 tie 但 store-map 命中干净叶则采 store-map 叶
- **当** tier1 多叶等优先级 tie(无确定输出),而 `store_category_map` 命中一个干净叶
- **那么** **必须**采该 store-map 叶,**禁止**因 tier1 tie 就锁「待人工」

#### 场景:都无确定叶则品类归属留空待人工、不强归
- **当** tier1 未命中 / tie 且 `store_category_map` 也未命中确定叶
- **那么** **品类归属留空**(不写叶 `product_tag`、不设 pending)+ 标「待人工」,**禁止**由 LLM 或猜测强归;**禁止**改 `product.category` 列

### 需求:商品分类三态必须由字段可判别(已分类叶 / 待细化 pending / 待人工)

商品的品类归属**必须**落为三个**字段可判别**的互斥态(供 backfill / 读路径 / 人工纠错确定性区分):

- **已分类(叶)**:有 `kind=category` 的叶 `product_tag` **且** `pending_category_tag_id` 为空。
- **待细化(pending)**:**无**叶 `product_tag` **且** `pending_category_tag_id` **非空**(指向粗 / 非叶节点)。
- **待人工**:**无**叶 `product_tag` **且** `pending_category_tag_id` 为空。

三态**禁止**用 `product.category` 列表达(该列恒 `beverage` 不动)。「待人工」与「待细化」都无叶 `product_tag`,**必须**靠 `pending_category_tag_id` 是否为空区分——不可混为一谈。

#### 场景:三态字段可判别
- **当** 检查任一 `product` 的品类归属
- **那么** 它**必须**恰好落入三态之一,且可仅凭「有无叶 `product_tag`」+「`pending_category_tag_id` 是否为空」机械判定;`product.category` 列在三态下均保持 `beverage`

#### 场景:待人工与待细化字段可分
- **当** 一个商品仅有粗 native 映射(待细化)vs 一个商品 tier1/native 都未命中(待人工)
- **那么** 前者 `pending_category_tag_id` **非空**、后者**为空**;二者**禁止**无法区分

### 需求:rankable 派生、归属变化必重算、且本期不接入 /rankings

`product.rankable` **必须**为派生值:当且仅当商品为**已分类(叶)**态且该叶解析出的 `comparable_unit` 非空(v1 = `per_100ml` 软饮)时为 `true`;待细化 / 待人工 / 酒类(`comparable_unit=null`)一律 `false`。

- **归属变化必重算**:所有写品类归属的路径(backfill / 挂叶 / 人工纠错)**必须**在写归属后**立即重算并更新 `rankable`**,**禁止**陈旧。
- **与本期 `/rankings` 的边界(消歧、不制造冲突)**:`rankable` 本期**只落列、无下游读**;现有 `GET /rankings` 仍按 `per100ml IS NOT NULL` 判据(`rankings-api` **不变、本期不读 `rankable`**)。因此一个「待细化 / 待人工但 per100ml 可算」的软饮**本期仍可能出现在现有扁平 `/rankings`**——这是**本期接受的已知状态**。本需求中「`rankable=false` 不出榜」的「榜」**专指 P3 品类树 / cohort 榜**(rankable 接入后),**不指**本期扁平 `/rankings`;两套入榜判据(`per100ml IS NOT NULL` 与 `rankable`)的收敛属 **P3**。

#### 场景:软饮叶且单位可算则 rankable
- **当** 商品为已分类软饮叶、继承 `comparable_unit=per_100ml`
- **那么** `rankable` **必须**为 `true`

#### 场景:酒类 / 待细化 / 待人工不可排名
- **当** 商品为酒类叶(`comparable_unit=null`)、或待细化、或待人工
- **那么** `rankable` **必须**为 `false`

#### 场景:归属改判后 rankable 必重算
- **当** 人工纠错或规则升级后再 backfill 使某商品归属改变
- **那么** 其 `rankable` **必须**随之重算到正确值,**禁止**保留旧派生值

#### 场景:rankable 本期不接入现有 /rankings
- **当** 本期检查 `GET /rankings` 的入榜判据
- **那么** 它**必须**仍为 `per100ml IS NOT NULL`(`rankings-api` 不变),**不读** `rankable`;可算 per100ml 的待细化软饮本期仍可入该扁平榜(rankable 收敛留 P3)

### 需求:必须 seed 初始规范品类树与受控属性(comparable_unit 可空、占位单位禁 seed)

迁移 / seed **必须**落地初始规范品类树(从山姆「酒水饮料」树派生、用我方命名):`饮料(root, comparable_unit=null)` → `软饮(per_100ml)` → `{碳酸饮料 / 果汁·植物饮 / 咖啡·茶饮 / 饮用水}`;`酒类(null)` 子树(本期 `rankable=false`)。`tag.comparable_unit` 列**必须可空**。**必须** seed 受控 `attribute` 值(无糖 / 气泡 / 进口 …)、山姆 `store_category_map`(抓包 `categoryIdList` 叶 ID → tag,人工策展,粗 native 只映非叶)、对应 `category_closure`。**本期 seed 禁止使用 `per_100g` / `per_100sheet`**(纯 v2 占位、无节点绑定;使 `rankable` 派生本期只面对 `{per_100ml, null}` 两态)。

#### 场景:软饮各叶继承 per_100ml、酒类为 null
- **当** 检查 seed 后的品类树
- **那么** 软饮全线叶解析 `comparable_unit` **必须**为 `per_100ml`;酒类节点**必须**为 `null`

#### 场景:本期不 seed 占位单位
- **当** 检查 seed 的 `tag.comparable_unit` 取值
- **那么** **禁止**出现 `per_100g` / `per_100sheet`(本期纯占位、无节点使用)

#### 场景:seed 必须经幂等 DML 迁移落地生产、且与 seedTaxonomy 等价
- **当** 生产经 `wrangler d1 migrations apply` 应用迁移
- **那么** 规范品类树 / 受控 attribute / `category_closure` / 山姆 `store_category_map` **必须**由一份**幂等 DML 种子迁移**落库(`INSERT OR IGNORE`、可重复 apply 无副作用),其产出**必须**与 `seedTaxonomy()` 结构等价(防漂移测试断言);**禁止**出现「生产只建空表、种子永不落地」使特性失活

### 需求:现有库存必须 backfill 打标签(不重放 ingest、单归属收敛、幂等)

**必须**对已落库的 `product` 跑 backfill:经打标签管线产出品类归属(叶 `product_tag` / `pending_category_tag_id`)、重算 `rankable`、补 `category_closure` 命中。backfill **必须**走迁移 / 脚本,**禁止**重放 `/ingest`(first-write-wins、不覆写)。

- **写路径三态 reconcile(单归属收敛 + 落叶清 pending)**:每次写品类归属,**必须**把三态字段(`kind=category` 叶 `product_tag` 与 `pending_category_tag_id`)**整体收敛到本次裁决**,使任一时刻商品恰落三态之一、**绝不**出现「有叶 ∧ pending 非空」的越界态:
  - 裁决 = **叶**:先删该 `product` 既有 `kind=category` 叶 `product_tag`、插新叶,**并置 `pending_category_tag_id=NULL`**(落叶必清 pending,对齐 taxonomy §二「转为正式叶标签、清 pending」)——规则升级改判 A→B 后只剩叶 B、不残留 A;
  - 裁决 = **待细化**:删既有 `kind=category` 叶、写 `pending_category_tag_id`(非叶节点);
  - 裁决 = **待人工**:删既有 `kind=category` 叶、置 `pending_category_tag_id=NULL`。
  (只动 `kind=category` 轴,**不误删** attribute / brand / product_line 正交标签。)
- **幂等**:同一数据快照重跑结果一致——`product_tag` `(product_id, tag_id)` 唯一防重复;仲裁为纯函数(同输入同输出);`rankable` / `pending` 为覆写、收敛到同值。

#### 场景:现有商品获得品类归属与属性标签
- **当** 对现有库存(生产现状约 **445** 个 `product` 全量,含 per100ml 不可算行)跑 backfill
- **那么** 可判定项获叶 category + 适用 attribute 标签且 `category_closure` 填充(含到 root);`rankable` 按规则重算

#### 场景:不可判定项落待人工、不强归
- **当** backfill 遇 tier1 与 store-map 都无确定叶的商品
- **那么** 其**品类归属留空** + 待人工,**禁止**强归、**禁止**改 `product.category` 列

#### 场景:规则升级改判后单归属收敛(无残留旧叶)
- **当** tier1 规则升级使某商品从叶 A 改判叶 B,随后重跑 backfill
- **那么** 该 `product` 的 `kind=category` 叶 `product_tag` **必须**只剩叶 B、**不得**残留叶 A;`rankable` 随之重算

#### 场景:待细化命中叶后清 pending、落已分类态(无越界)
- **当** 一个「待细化」商品(`pending_category_tag_id` 非空、无叶)经规则升级 / 人工命中叶
- **那么** 写叶的同时 `pending_category_tag_id` **必须**置 `NULL`,该商品恰落「已分类(叶)」态,**禁止**出现「有叶 ∧ pending 非空」的越界态;反向(叶 → 待人工 / 待细化)亦**必须**删除既有叶,不留残叶

#### 场景:backfill 重跑幂等
- **当** 对同一数据快照重复跑 backfill
- **那么** 结果**必须**一致:不重复挂同一 `(product_id, tag_id)`、归属与 `rankable` 收敛到同值

#### 场景:三态写归属必须原子收敛(无部分写越界态)
- **当** 写一次品类归属(经 reconcile:删旧叶 + 挂新叶/属性 + 设 pending + 重算 rankable)
- **那么** 这组写**必须**在单事务(sqlite)/ 批(D1)内**整体提交或整体回滚**,即便中途失败也**禁止**留下「有叶 ∧ pending 非空」的越界态;且原语**必须**在写前校验 kind(叶位只接 category 叶、pending 只接非叶 category、属性非 category),非法 slug / 缺失 product → 抛错而非静默假成功

#### 场景:本期 backfill 对 store-map 惰性、tier1 为活跃路径
- **当** 本期对现有库存跑 backfill
- **那么** 因现状无 ingest 字段承载 store 原生品类 id(`category_hint` 是 `product.category` 透传源、恒 `beverage`,**非**原生 `categoryIdList` 叶 id),backfill **不喂 store-map**(tier1 关键词规则为本期活跃分类路径);`store_category_map` seed + 仲裁 store-map 分支为后续阶段轨道、由单测覆盖,待 ingest 新增**专用** native-id 字段后接通;**禁止**复用 `category_hint` 承载原生 id(污染 `product.category`)
