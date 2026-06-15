# category-tagging 规范

## 目的

为「真实单价比价」提供一套 **store-agnostic 的品类 / 标签数据底座**:品类 is-a 树(单归属、绑 `comparable_unit`、叶继承)+ 正交标签轴(attribute / brand / product_line)+ is-a 闭包 + 确定性打标签管线(tier1 关键词规则 + 门店 native 映射 + 仲裁,**AI 不判定品类**)+ `rankable` 派生 + 现有库存 backfill。供品类树榜 / 同品类 cohort 比价消费;价格、单位换算与可比判断仍由 `packages/core` 的确定性程序决定。
## 需求
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

打标签管线**必须**确定性:tier1 关键词规则(`packages/core`、**纯函数无 IO**、配脏标题样本集单测,**只产叶** category + attribute,同输入同输出)→ 山姆 `native_category_id` 经 `store_category_map` 映射 → **确定性仲裁**(对齐 taxonomy §五):**native 叶级 store-map ≻ tier1 叶**(接通 native-id 后,门店权威叶级分类纠正 tier1 关键词启发式的跨 cohort 误判;native 缺失则走 tier1);tier1 多叶 tie 而 store-map 命中干净叶 → 采 store-map 叶;仅 store-map 命中**粗节点(非叶)** → 待细化(**tier1 叶 ≻ 粗 native**,粒度规则不变);两方都无确定叶 → 留空 + 待人工(**不强归**)。**LLM 本期不参与**;品类/可比判断属红线,**禁止**由 LLM 决定。

**native-id 接通与仲裁优先级反转**:此前同粒度叶冲突取 **tier1 > store-map**——那是 native-id **未接通**(`listProductsForBackfill` 硬编码 `nativeCategoryId=null`、store-map 从不点火)时的保守序。接通门店**叶级** native id 后**反转该格为 `native 叶 store-map ≻ tier1 叶`**:门店自身的叶级 native 分类是该商品的 ground truth,而 tier1 是关键词子串启发式、长尾必有跨 cohort 误判(如 `燕麦牛奶`→`milk`)。接通 native-id 的全部意义即用权威叶**纠正**启发式误判 +**填补** tier1 miss 的长尾。**仅当** store-map 解析出**叶**(`isLeaf=true`)且**与 tier1 叶不同**时压过 tier1;两叶**相同**时取该叶但 `decidedBy` 仍记 `tier1`(叶一致不翻 provenance,避免对本已分对的商品批量 churn `product_tag.source`);**粗 native 节点仍 < tier1 叶**(它只能 pending)。即新全序:`native 异叶 ≻ tier1 叶 ≻ 粗 native(pending) ≻ 待人工`(同叶取该叶、记 tier1)。落点:`arbitrate(tier1, storeMap)` 在 `tier1 有叶 ∧ storeMap.kind==='leaf'` 且**两叶不同**时**返回 store-map 叶**(`decidedBy=store-map`),两叶相同时仍 `decidedBy=tier1`;taxonomy §五 九格表 + `category-rules.test.ts` 仲裁单测仅翻**异叶**那格(同叶用例保持 `decidedBy=tier1` 不变)。native 缺失(未回填 / 无 map 命中)时**仍走 tier1**(多数历史行直到 HAR 回填)。

**诚实边界收敛**:tier1 残留待人工(标题既无类型词又无品牌词的高端酒长尾,如裸 `剑南春`/`水井坊`)——由**门店 native 叶**兜住:这些商品的 `native_category_id` 命中其酒种叶 → store-map 落叶(不再待人工)。tier1 仍是 native 缺失商品的主路径。

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

#### 场景:native 叶级 store-map 纠正 tier1 跨 cohort 误判
- **当** 标题为「燕麦牛奶 250ml*12」(tier1 因含全词 `牛奶` 误命中 `milk`),且其 `native_category_id` 经 `store_category_map` 命中软饮叶 `juice-plant`
- **那么** 仲裁**必须**取 **store-map 叶 `juice-plant`**(`native 叶 ≻ tier1 叶`),`decidedBy` 为 `store-map`,纠正跨 cohort 误归(植物饮归软饮、非乳品)

#### 场景:native 叶填补 tier1 miss 的高端酒长尾
- **当** 标题为「剑南春水晶剑 500ml」(tier1 无类型/品牌词命中 → miss),其 `native_category_id` 命中酒种叶 `baijiu`
- **那么** 仲裁**必须**落 store-map 叶 `baijiu`、`decidedBy=store-map`、`rankable=true`,**不再**待人工

#### 场景:native 缺失退化为 tier1(多数历史行)
- **当** 商品 `native_category_id` 为 `null`(未回填 / 新店无 map)
- **那么** store-map 不点火,分类**必须**仅由 tier1 决定(口径同 P3.5);native 缺失**禁止**改变 tier1 结果

#### 场景:粗 native 节点不压 tier1 叶(粒度规则保留)
- **当** tier1 命中确定叶,而 `native_category_id` 仅命中**粗(非叶)节点**
- **那么** 仲裁**必须**取 **tier1 叶**(粗 native 更不具体,不压 tier1 叶);若 tier1 也 miss、仅粗 native 命中 → 待细化 pending 指向该粗节点

#### 场景:tier1 与 native 命中同一叶 → 取该叶、provenance 记 tier1
- **当** tier1 命中叶 `carbonated`,且 `native_category_id` 经 store-map 也命中**同一叶** `carbonated`
- **那么** 仲裁**必须**取 `carbonated`、`decidedBy=tier1`(两叶一致时**禁止**把 `product_tag.source` 由 `rule` 翻成 `store-map`,避免对本已分对的商品批量 churn provenance);仅当 store-map 叶**异于** tier1 叶时才 `decidedBy=store-map`

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

### 需求:现有库存必须 backfill 打标签(不重放 ingest、单归属收敛、幂等)

**必须**对已落库的 `product` 跑 backfill:经打标签管线产出品类归属(叶 `product_tag` / `pending_category_tag_id`)、重算 `rankable`、补 `category_closure` 命中。backfill **必须**经一个受控入口落地(迁移 / 脚本 / 鉴权运维端点之一),**禁止**重放 `/ingest`(first-write-wins、不覆写)。

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

### 需求:存量 backfill 必须有可在生产驱动的受控入口(确定性全序游标分块 + 完整覆盖)

打标签管线逻辑已就位,但生产**必须**有一个可触发它的受控入口,否则上条「现有库存必须 backfill」在生产里落空。该入口**必须**满足:① 鉴权保护(见 api-governance 的 admin tier);② **确定性全序游标分块**——按稳定全序键(`product.id`)的 keyset 游标推进、**禁止**依赖无序读 + 位置 offset 切片;③ **完整覆盖**——分多次驱动**必须**等价于对存量恰好一次全覆盖,**禁止**漏处理或在仍有未处理行时误报完成;④ `limit` **有界**——正整数下界 + 服务端上界 clamp,外部输入**禁止**绕过子请求安全护栏,**且 HTTP 入口在调用方不传 `limit` 时必须注入服务端默认有界 `limit`、恒走分块,禁止把「无参全量单次扫」暴露为生产 HTTP 行为**(无参全量仅为库函数/单测契约,见下方场景);⑤ 幂等;⑥ 纯确定性:**禁止** tier2 LLM、**禁止**任何出站 fetch;⑦ **写集封闭**——直接写集 = `product_tag`(kind=category 叶 **+ attribute 正交边**,沿用既有「品类归属与属性标签」契约)+ `product.{pending_category_tag_id, rankable}`,**禁止**触原始 raw / 价格 / `product.category`(`category_closure` 为种子期物化在 tag 轴、靠叶 attach 间接命中,backfill **不**写其行);⑧ **禁止**重放 ingest;⑨ 对 store-map 惰性。该入口为**可重复驱动**的受控入口(bootstrap + ad-hoc 重标);「ingest 后自动重标」的事件/调度化为后续项、不在本需求范围。

#### 场景:经受控入口驱动存量打标签
- **当** 持 admin 凭据调用 backfill 入口
- **那么** 对存量 `product` 执行打标签:写 `product_tag`(category 叶 + 适用 attribute 边)、补 `category_closure` 命中(经叶 attach、不写 closure 行)、按归属重算 `rankable`,三态由字段可判别
- **那么** 不重放 ingest、不调用 LLM、不发起任何出站请求,直接写集**不超出** `product_tag`(category 叶 + attribute 边)+ `product.{pending_category_tag_id, rankable}`

#### 场景:确定性全序游标分块、完整覆盖、真完成信号
- **当** 入口按稳定全序键(`product.id`,数据库**文本**排序)的 keyset 游标分块驱动(每块 `WHERE id > :cursor ORDER BY id LIMIT :limit`,处理游标之后的至多 `limit` 行)
- **那么** 跨多次独立调用的处理集合**必须**等价于对存量的一次全序全覆盖:**禁止**因行序漂移漏处理某行,**禁止**重叠重复;每块返回的游标**必须**严格大于入参 cursor(取本块最大已处理 `id`),保证游标**单调前进、不原地踏步**
- **那么** **完成信号必须由游标耗尽(本次读到行数 < limit)给出、而非位置比较**;存量恰为 `limit` 整数倍时,末个满块后**多一次读到 0 行的空读**才置完成——`limit>0` 下读到 0 行是**正常耗尽终止、非缺陷**(与 `limit=0` 的空块死循环相区别),误报「已完成」即缺陷

#### 场景:`limit` 有界、非法值被拒、超大值被钳制
- **当** 调用方传 `limit`
- **那么** `limit` **必须**为正整数(`>=1`):`0` / 负数 / 非整数 → 拒(`400`,与 `/rankings` 同款严格 parse),`limit=0` 尤其**禁止**(空块、游标不前进 → 死循环)
- **那么** 超过服务端子请求安全上界的 `limit` **必须**被 clamp 到该上界(按 Worker 子请求上限与每商品实测子请求数派生),**禁止**因外部传入超大值退化成超额单块

#### 场景:无参全量仅为库函数/单测契约、不暴露为 HTTP 行为
- **当** 在**库内 / 单测**直调 `runBackfill(repo, db)` 不带游标 / limit
- **那么** 对全部存量执行一次全序 backfill(等价于现有 `runBackfill` 行为,保持现两参签名与既有单测),此路径**仅**供进程内调用(无 Worker 子请求上限约束)

#### 场景:HTTP 入口即使调用方不传 limit 也恒分块、不触发全量单扫
- **当** `POST /admin/backfill` 的调用方省略 `limit`(空 body 或缺字段)
- **那么** 入口**必须**注入服务端默认有界 `limit`(并 clamp 到上界)、走 keyset 分块路径,**禁止**把缺省透传成 `runBackfill` 的无参全量单次扫(那将一次性扫全表 ~445 × 每商品多次子请求、超 Worker 子请求上限、中途失败留半写假象)

#### 场景:任意区间重跑幂等、并发 ingest 下快照行不漏不重
- **当** 同一快照下对某游标区间重复驱动,或续跑期间并发 `/ingest` 落新 `product`
- **那么** 结果与单次驱动一致(单归属收敛、无残留旧叶、`product_tag` 不重复挂);**完整覆盖保证的对象是 sweep 起始快照行**——快照行恰被处理一次、keyset 游标只前进不损坏其覆盖
- **那么** 并发插入的**新行**按其 `product.id` 文本序相对当前游标**确定性二分**:排在游标**之后** → 本轮后续块纳入;排在游标**之前(已过区间)** → **顺延下一轮 sweep**(确定性延后、非漏标)。「增量可再驱动」= 从头一次全新全序 sweep、而非续旧游标

#### 场景:入口对 store-map 惰性
- **当** 驱动 backfill 时无承载山姆 native 分类 id 的 ingest 字段
- **那么** 每条输入以 `nativeCategoryId=null` 喂入,tier1 关键词规则为唯一活跃分类路径;仅靠 native id 才能判定的商品落「待人工」,不强归(沿用 P2 既定边界,本入口不激活 store-map)

