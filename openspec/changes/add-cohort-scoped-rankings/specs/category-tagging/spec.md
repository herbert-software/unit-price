## 修改需求

### 需求:打标签必须由确定性程序决定,AI 不判定品类

打标签管线**必须**确定性:tier1 关键词规则(`packages/core`、**纯函数无 IO**、配脏标题样本集单测,**只产叶** category + attribute,同输入同输出)→ 山姆 `native_category_id` 经 `store_category_map` 映射 → **确定性仲裁**(对齐 taxonomy §五):粒度冲突取更深叶;同粒度异叶 tier1 > store-map;tier1 多叶 tie 而 store-map 命中干净叶 → 采 store-map 叶;仅 store-map 命中粗节点 → 待细化;两方都无确定叶 → 留空 + 待人工(**不强归**)。**LLM 本期不参与**;品类/可比判断属红线,**禁止**由 LLM 决定。

**P3.5 tier1 关键词扩展(含 core 叶枚举变更)**:tier1 规则**必须**扩出以下叶的关键词(仍纯函数、配脏标题样本单测、只产叶)。

**前置:这是一处 `packages/core` 的 schema 变更**——tier1 只能产 `CategoryLeafSlugSchema`(core Zod 枚举)中的叶,当前该枚举**仅含 4 个软饮叶**(`carbonated/juice-plant/coffee-tea/drinking-water`);酒种叶虽已在 `packages/db` `CATEGORY_NODES` 树中、却**不在** core 叶枚举(此前仅经 store-map 以 `z.string()` 落叶)。故本期**必须**把 **9 个新叶 slug**(6 酒种叶 `baijiu/wine/spirits/whisky/beer/sake-fruit-wine` + 3 乳品叶)同时加入 core `CategoryLeafSlugSchema` 与 `LEAF_RULES`。**乳品 ASCII slug 必须钉死**:节点 `乳品=dairy`、叶 `牛奶=milk` / `酸奶=yogurt` / `乳酸菌饮料=lactic-drink`(树/枚举/迁移三处用同一组 ASCII slug)。**`seed.ts` 编译期守卫耦合**:`seed.ts` 会遍历 `CategoryLeafSlugSchema.options` 断言每叶都有 seeded 节点,故新叶**必须**与 `CATEGORY_NODES` seed 节点**同变更落地**(core 加叶而 db 未 seed → 模块加载即抛)。(注:本期不动 core **计算层/calculator**,但 tier1 叶枚举属 core schema、确有改动——proposal「core 计算层不改」仅指 calculator。)

- **乳品叶**(本期新增节点 `dairy`;**`dairy` 节点绑 `comparable_unit=per_100ml`、三叶不绑自身、经继承解析**,与 `soft-drink` 子树同范式——`CATEGORY_NODES` 中 `milk/yogurt/lactic-drink` 的 `comparableUnit` 留空,DML 迁移这三叶行 `comparable_unit=NULL`):`牛奶/鲜牛奶/纯牛奶/灭菌乳/巴氏` → `milk`;`酸奶/酸牛奶` → `yogurt`;`乳酸菌/活菌型` → `lactic-drink`。**排除** `椰奶/燕麦奶/植物奶/豆浆/坚果乳`(植物基 → 软饮 `juice-plant`、**非**乳品;规则用全词 `牛奶` 等、**禁止**用裸 `奶`,以免 `椰奶/稀奶油` 误命中)。
- **酒类各叶(6 叶各自映射,`spirits` 与 `whisky` 必须分开)**:
  - `beer` 啤酒:`啤酒/精酿/IPA/拉格/世涛/小麦啤`(**禁止**用裸 `啤`,以免 `啤梨/啤梨汁` 误命中)。
  - `wine` 葡萄酒:`葡萄酒/红酒/干红/干白/赤霞珠/西拉/黑皮诺/长相思/梅洛/起泡酒/香槟酒/冰酒`(`香槟` 必须带 `酒`/`葡萄酒`,**禁止**裸 `香槟`/`庄园`/`BIN` 单独定叶——`香槟色/酒庄园艺/SKU 含 BIN` 会误命中;`BIN` 仅在紧邻数字且与葡萄酒型号词共现时作辅助证据)。
  - `baijiu` 白酒:`白酒/茅台/五粮液/泸州老窖/国窖/洋河/梦之蓝/海之蓝/汾酒/酱香型白酒/浓香型白酒`(**禁止**用裸 `度`(撞 `零度/0度可乐/浓度`)、裸 `浓香/酱香`(撞咖啡茶饮描述词)——酒精度仅作**辅助**证据,须形如 `\d+%vol` 或 `\d+度` 且与白酒型/品牌词共现,单独不足以定叶)。
  - `sake-fruit-wine` 清酒果酒:`清酒/大吟酿/纯米/獭祭/山田锦/果酒/梅酒/青梅酒`(关键词为**全词**`果酒`/`梅酒`,软饮 `juice-plant` 关键词亦为全词 `果汁`/`葡萄汁` 而**非**裸 `果`/`葡萄`,故 `果酒/梅酒` 与 `果汁` 互不为子串、**不碰撞**——无需也**不得**令 `sake-fruit-wine` priority 高于 `juice-plant`,以免破坏「软饮叶 priority 恒高于酒类/乳品叶」的统一序)。
  - `spirits` 洋酒:`洋酒/白兰地/干邑/伏特加/金酒/朗姆/龙舌兰/轩尼诗/人头马/绝对伏特加`。
  - `whisky` 威士忌:`威士忌/whisky/whiskey/麦卡伦/单一麦芽/苏格兰威士忌/波本`。
- **漏判软饮**:`椰子水/椰汁/椰奶/燕麦奶/豆浆/坚果乳/植物蛋白饮` → `juice-plant`（含 `椰奶`：植物基、归软饮 `juice-plant`,绝不入乳品 `dairy`——`dairy` 禁裸 `奶`、不命中 `椰奶`）;`果汁/橙汁/NFC/西梅汁/桑葚汁/葡萄汁/醋饮/山楂汁` → `juice-plant`(果汁类关键词一律**全词**`果汁`/`葡萄汁`/`山楂汁`、**禁止**裸 `果`/`葡萄`/`山楂`,故与 `葡萄酒`/`果酒`/`山楂酒` 互不为子串、不碰撞);`电解质水/泉水/苏打水` → `drinking-water`;`浓缩液/黑咖/本草饮/麦冬` → `coffee-tea`。
- **非饮品判不可比**:`稀奶油` 等烹饪料**禁止**归任何饮品叶(它有 per100ml 但不是饮品)→ 留待人工/不可比、不入任何榜。

**仲裁优先级(防跨 cohort 误归)**:当软饮叶关键词(`可乐/汽水/雪碧/苏打水/果汁/橙汁/…`)与酒类/乳品关键词在同一标题同时命中时,**软饮叶优先**(避免 `零度可乐`/`0度可乐` 落白酒、`啤梨汁` 落啤酒);裸单字/泛描述词(`度/啤/浓香/酱香/山楂/香槟/BIN/奶`)**禁止**单独定叶,只能作辅助证据或须与型/品牌词共现。**实现机制(钉死)**:此优先级**必须**经现有 tier1 仲裁的 `LEAF_RULES.priority`（同深度按 priority/matchLength 排序的既有机件,见 `packages/core` arbitrate）实现——软饮叶规则 priority **高于**酒类/乳品叶规则,**禁止**新增独立仲裁层;多数反例本就靠「禁裸字」使错叶不命中(如 `零度可乐` 因禁裸 `度`、根本不命中 baijiu,仲裁对其无关),但对**真正软饮词与酒词共现**的标题,须由该 priority 序兜底。

**诚实边界**:高端/品牌酒长尾(标题既无类型词、又**不含上方关键词表里的品牌词**,如 `剑南春`/`水井坊`/`习酒` 这类未列入规则的酒厂品牌)tier1 召回有限 → 残留落待人工(不进榜、不混 cohort,是正确排除的近似);彻底收靠后续 store-map(native-id ingest,非本期)。**关键自洽约束**:`国窖/大吟酿/干邑` 等**已列入上方规则的品牌词**会被 tier1 命中(`国窖1573`→`baijiu`、`某某大吟酿`→`sake-fruit-wine`、`轩尼诗干邑`→`spirits`),**不**是长尾、**禁止**当作 manual 反例;只有**不含任何列入品牌/类型词**的标题才落待人工。样本集须据此区分「已命中品牌词」与「未列入的纯品牌长尾」,**禁止**让「诚实边界」与「品牌词规则」对同一标题给出矛盾期望。

#### 场景:标题命中叶关键词即确定归属
- **当** 标题含「可乐 / 汽水 / 雪碧」碳酸叶关键词
- **那么** tier1 **必须**确定性挂 `碳酸饮料` 叶;`苏打水 / 气泡水` **必须**归 `饮用水` 叶 + `attribute:气泡`

#### 场景:乳品/植物基/酒类标题确定归属(P3.5)
- **当** 标题为「MM 全脂纯牛奶」「原味酸牛奶」「活菌型乳酸菌饮料」
- **那么** tier1 **必须**分别归 `milk`/`yogurt`/`lactic-drink` 叶
- **当** 标题为「燕麦奶」「椰子水」「醇豆浆」
- **那么** tier1 **必须**归软饮 `juice-plant` 叶(植物基)、**禁止**误归乳品
- **当** 标题为「赤霞珠红葡萄酒」「茅台王子酒 53%vol」「一番榨啤酒」「纯米大吟酿」「麦卡伦单一麦芽威士忌」「轩尼诗 VSOP 干邑」
- **那么** tier1 **必须**分别归 `wine`/`baijiu`/`beer`/`sake-fruit-wine`/`whisky`/`spirits` 叶(`spirits` 与 `whisky` 为两个独立 cohort、各有榜,**禁止**合并)

#### 场景:跨 cohort 误归反例(P3.5,样本集必含)
- **当** 标题为「零度可乐」「可口可乐 0 度」(碳酸软饮,含裸 `度`)
- **那么** tier1 **必须**归 `carbonated`、**禁止**因裸 `度` 落 `baijiu`(仲裁:软饮叶关键词优先)
- **当** 标题为「山楂酒」「啤梨汁」「香槟色气泡水」
- **那么** tier1 **必须**分别为:`山楂酒` 命中 `山楂汁`(全词)否?——否(`山楂酒`⊉`山楂汁`),且无酒类关键词命中 → **留待人工/manual**(确定性结果,**非**软饮);`啤梨汁` 因**禁裸 `啤`** 不落 `beer`,且无 juice 全词关键词命中(`啤梨汁`⊉`果汁/梨汁…`)→ **留待人工/manual**(本期不为「梨汁」单设关键词;诚实边界=召回缺口、**非**误归);`香槟色气泡水` 命中 `苏打水`否——否,命中 `气泡水`→`drinking-water`,且**禁裸 `香槟`** 不落 `wine`
- **当** 标题为「巴黎水葡萄汁味气泡水」(软饮,含 `葡萄`)
- **那么** tier1 **必须**归软饮、**禁止**因 `葡萄` 落 `wine`
- **当** 标题同时含真软饮词与真酒词(共现样本,如「青岛啤酒风味苏打水」)
- **那么** tier1 **必须**据 `LEAF_RULES.priority` 软饮叶优先 → 归 `drinking-water`(锁定 priority 序、非仅靠禁裸字)

#### 场景:非饮品(稀奶油)不强归饮品叶
- **当** 标题为「英国进口紫米勒稀奶油」(有 per100ml 但是烹饪料、非饮品)
- **那么** tier1 **禁止**把它归任何饮品叶 → 留待人工/不可比,**不入任何榜**

#### 场景:都无确定叶则品类归属留空待人工、不强归
- **当** tier1 未命中 / tie 且 `store_category_map` 也未命中确定叶(如品牌酒长尾)
- **那么** **品类归属留空** + 标「待人工」,**禁止**由 LLM 或猜测强归;**禁止**改 `product.category` 列

### 需求:rankable 派生、归属变化必重算、且已接入 /rankings 作资格门（P3 收敛）

`product.rankable` **必须**为派生值:当且仅当商品为**已分类(叶)**态且该叶解析出的 `comparable_unit` 非空时为 `true`;待细化 / 待人工(无叶)一律 `false`。**P3.5 起可排名轴扩展**:`comparable_unit=per_100ml` 现绑在 `软饮`、**`乳品`**、与**各酒种叶**(啤酒/葡萄酒/白酒/洋酒/威士忌/清酒果酒),故已分类到这些叶的软饮/乳品/酒类商品**均 `rankable=true`**;`酒类` **父**节点与 root `饮料` 解析单位仍 `null`(它们不是商品所挂的叶)。榜单读路径**只读** `rankable`、**不改其派生口径**(派生口径仍为「已分类叶 ∧ 解析单位非空」,只是绑定单位的叶变多了)。

- **归属变化必重算**:所有写品类归属的路径(backfill / 挂叶 / 人工纠错)**必须**在写归属后**立即重算并更新 `rankable`**,**禁止**陈旧。
- **跨 cohort 不混由 rankings cohort 守卫负责、而非靠让酒类不可排名**(取代 P3「酒类 comparable_unit=null → rankable=false → 自然空榜」):本期酒类各叶**可排名**、各有自己的 per100ml cohort 榜;防止「不同酒种混排」「软饮+酒类混排」由 `rankings-api` 的 **cohort 守卫**(榜只对解析单位非空的**单一 cohort 节点**开放、跨 cohort 的酒类父/root 节点 `400` 拒榜)完成。`rankable` 仍是入榜合取门之一(闭包成员 ∧ rankable ∧ per100ml),叠加 cohort 守卫。
- 详细 HTTP 契约见 `rankings-api` 与 `category-tree-api`。

#### 场景:软饮/乳品/酒种叶且单位可算则 rankable
- **当** 商品已分类到 `软饮` 子叶、`乳品` 子叶、或任一酒种叶(均绑/继承 `per_100ml`)
- **那么** `rankable` **必须**为 `true`(取代 P3「酒类叶 rankable=false」)

#### 场景:待细化 / 待人工不可排名
- **当** 商品为待细化(无叶 ∧ pending 非空)或待人工(无叶 ∧ pending 空)
- **那么** `rankable` **必须**为 `false`

#### 场景:归属改判后 rankable 必重算
- **当** 人工纠错或规则升级后再 backfill 使某商品归属改变
- **那么** 其 `rankable` **必须**随之重算到正确值,**禁止**保留旧派生值

#### 场景:跨 cohort 不混由 cohort 守卫而非 rankable 实现
- **当** 检查 `GET /rankings` 对酒类父 `alcohol` / root `beverage` 的行为
- **那么** 它们因解析单位 `null` 被 cohort 守卫**拒榜(`400`)**,而**非**靠把其下酒类商品标 `rankable=false` 来排除;酒类商品在**各酒种叶** cohort 榜里 `rankable=true` 正常出现

### 需求:必须 seed 初始规范品类树与受控属性(comparable_unit 可空、占位单位禁 seed)

迁移 / seed **必须**落地规范品类树(从山姆「酒水饮料」树派生、用我方命名),P3.5 树为:
- `饮料 beverage(root, comparable_unit=null)`
  - `软饮 soft-drink(per_100ml)` → `{碳酸饮料 carbonated / 果汁·植物饮 juice-plant / 咖啡·茶饮 coffee-tea / 饮用水 drinking-water}`(叶继承 per_100ml)
  - **`乳品 dairy(per_100ml)`(P3.5 新增)** → `{牛奶 milk / 酸奶 yogurt / 乳酸菌饮料 lactic-drink}`(叶继承 per_100ml;ASCII slug 钉死,与 core `CategoryLeafSlugSchema`、迁移三处一致)
  - `酒类 alcohol(comparable_unit=null, 父节点不绑)` → `{白酒 baijiu / 葡萄酒 wine / 洋酒 spirits / 威士忌 whisky / 啤酒 beer / 清酒果酒 sake-fruit-wine}`,**P3.5 各酒种叶各自绑 `comparable_unit=per_100ml`**(使每叶成为独立可排名 cohort,`spirits` 与 `whisky` 为两个独立叶;`酒类` 父仍 `null` → 由 rankings cohort 守卫拒其混榜)。

`tag.comparable_unit` 列**必须可空**。**必须** seed 受控 `attribute` 值、山姆 `store_category_map`、对应 `category_closure`(含新增乳品节点/叶 + 酒种叶绑定的闭包行)。**本期 seed 仍禁止使用 `per_100g` / `per_100sheet`**(纯 v2 占位;`comparable_unit` 仍只面对 `{per_100ml, null}` 两态)。

#### 场景:软饮/乳品全线叶 + 各酒种叶解析 per_100ml,酒类父与 root 为 null
- **当** 检查 seed 后的品类树
- **那么** 软饮全线叶、**乳品全线叶**、**各酒种叶**(啤酒/葡萄酒/白酒/洋酒/威士忌/清酒果酒)解析 `comparable_unit` **必须**为 `per_100ml`;`酒类` **父**节点与 root `饮料` **必须**为 `null`

#### 场景:本期不 seed 占位单位
- **当** 检查 seed 的 `tag.comparable_unit` 取值
- **那么** **禁止**出现 `per_100g` / `per_100sheet`

#### 场景:seed 必须经幂等 DML 迁移落地生产、且与 seedTaxonomy 等价（含存量行 null→per_100ml 翻转）
- **当** 生产经 `wrangler d1 migrations apply` 应用迁移
- **那么** P3.5 品类树(含乳品节点/叶、酒种叶 `per_100ml` 绑定)/ 受控 attribute / `category_closure` / `store_category_map` **必须**由一份**幂等 DML 种子迁移**落库:乳品节点/叶 + closure 用 `INSERT OR IGNORE`;**各酒种叶的 `comparable_unit` 必须用显式幂等 `UPDATE tag SET comparable_unit='per_100ml' WHERE slug IN (...酒种叶...)`**——因生产已由 0004 落过酒种叶行(`comparable_unit=NULL`),`INSERT OR IGNORE` 对已存在主键是 no-op、**不会**翻转该列,必须靠 `UPDATE` 才能 null→per_100ml;可重复 apply 无副作用
- **那么** `seedTaxonomy()` **也必须**对已存在酒种叶行做同一幂等 `comparable_unit` 写入,否则在**已 seed 的旧 P3 库**上 `seedTaxonomy()` 与迁移产出不再等价(迁移翻转、seedTaxonomy 不翻转)。**实现形态钉死**:在既有「两遍 insert(`onConflictDoNothing`)+ 第二遍 `UPDATE … SET parentId`」块**之后**追加一条**独立** `UPDATE tag SET comparable_unit='per_100ml' WHERE slug IN ('baijiu','wine','spirits','whisky','beer','sake-fruit-wine')`(镜像 DML 迁移),**禁止**改 insert 的 `onConflictDoNothing` 为 `onConflictDoUpdate`(会连带覆写 `parentId`/`name` 等列、与两遍式 parentId 解析相互踩)
- **那么** 防漂移测试**必须**新增一条「**预置旧 P3 树**(酒种叶 `comparable_unit=NULL`)后,分别跑迁移 / `seedTaxonomy()`,断言两路均收敛到酒种叶 `per_100ml`」的用例——既有「双 fresh 库等价」用例对此存量翻转盲、不可单独作数;并更新既有「`comparable_unit` 仅绑一个节点(软饮)」断言为 P3.5 的 8 个非空节点(软饮 + 乳品 + 6 酒种叶)
- **那么** **禁止**出现「生产只建空表、种子永不落地」或「酒种叶 `comparable_unit` 停在 NULL 致酒类全程不可排名 + cohort 守卫对各酒种叶静态放行但 DB 实际空榜」使特性失活
