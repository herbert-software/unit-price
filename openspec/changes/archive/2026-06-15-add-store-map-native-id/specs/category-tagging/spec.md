## 修改需求

### 需求:打标签必须由确定性程序决定,AI 不判定品类

打标签管线**必须**确定性:tier1 关键词规则(`packages/core`、**纯函数无 IO**、配脏标题样本集单测,**只产叶** category + attribute,同输入同输出)→ 山姆 `native_category_id` 经 `store_category_map` 映射 → **确定性仲裁**(对齐 taxonomy §五):**native 叶级 store-map ≻ tier1 叶**(接通 native-id 后,门店权威叶级分类纠正 tier1 关键词启发式的跨 cohort 误判;native 缺失则走 tier1);tier1 多叶 tie 而 store-map 命中干净叶 → 采 store-map 叶;仅 store-map 命中**粗节点(非叶)** → 待细化(**tier1 叶 ≻ 粗 native**,粒度规则不变);两方都无确定叶 → 留空 + 待人工(**不强归**)。**LLM 本期不参与**;品类/可比判断属红线,**禁止**由 LLM 决定。

**native-id 接通与仲裁优先级反转(本期修正)**:此前(P3.5 及之前)同粒度叶冲突取 **tier1 > store-map**——那是 native-id **未接通**(`listProductsForBackfill` 硬编码 `nativeCategoryId=null`、store-map 从不点火)时的保守序。本期接通门店**叶级** native id 后**反转该格为 `native 叶 store-map ≻ tier1 叶`**:门店自身的叶级 native 分类是该商品的 ground truth,而 tier1 是关键词子串启发式、长尾必有跨 cohort 误判(如 `燕麦牛奶`→`milk`)。接通 native-id 的全部意义即用权威叶**纠正**启发式误判 +**填补** tier1 miss 的长尾。**仅当** store-map 解析出**叶**(`isLeaf=true`)且**与 tier1 叶不同**时压过 tier1;两叶**相同**时取该叶但 `decidedBy` 仍记 `tier1`(叶一致不翻 provenance,避免对本已分对的商品批量 churn `product_tag.source`);**粗 native 节点仍 < tier1 叶**(它只能 pending)。即新全序:`native 异叶 ≻ tier1 叶 ≻ 粗 native(pending) ≻ 待人工`(同叶取该叶、记 tier1)。落点:`arbitrate(tier1, storeMap)` 在 `tier1 有叶 ∧ storeMap.kind==='leaf'` 且**两叶不同**时**返回 store-map 叶**(`decidedBy=store-map`),两叶相同时仍 `decidedBy=tier1`;taxonomy §五 九格表 + `category-rules.test.ts` 仲裁单测仅翻**异叶**那格(同叶用例保持 `decidedBy=tier1` 不变)。native 缺失(未回填 / 无 map 命中)时**仍走 tier1**(多数历史行直到 HAR 回填)。

**P3.5 tier1 关键词扩展(已落,口径不变)**:tier1 规则产 `CategoryLeafSlugSchema`(core,13 叶 = 4 软饮 + 3 乳品 + 6 酒种;`spirits`≠`whisky`)中的叶;乳品叶 `牛奶/鲜牛奶/纯牛奶/灭菌乳/巴氏→milk`、`酸奶/酸牛奶→yogurt`、`乳酸菌/活菌型→lactic-drink`(**排除** `椰奶/燕麦奶/植物奶/豆浆/坚果乳`→软饮 `juice-plant`、禁裸 `奶`);酒类 6 叶各自映射(`beer`=啤酒/精酿/IPA/拉格,禁裸 `啤`;`wine`=葡萄酒/红酒/干红/干白/赤霞珠/起泡酒/香槟酒,禁裸 `香槟/庄园/BIN`;`baijiu`=白酒/茅台/五粮液/泸州老窖/国窖/洋河/汾酒/酱香型白酒/浓香型白酒,禁裸 `度/浓香/酱香`;`sake-fruit-wine`=清酒/大吟酿/纯米/獭祭/山田锦/果酒/梅酒;`spirits`=洋酒/白兰地/干邑/伏特加/金酒/朗姆/龙舌兰/轩尼诗/人头马;`whisky`=威士忌/whisky/麦卡伦/单一麦芽/苏格兰威士忌/波本);漏判软饮(椰子水/椰汁/椰奶/燕麦奶/豆浆/坚果乳/植物蛋白饮 + 果汁/橙汁/NFC/西梅汁/桑葚汁/葡萄汁/醋饮/山楂汁[全词] + 电解质水/泉水/苏打水 + 浓缩液/黑咖/本草饮/麦冬);稀奶油等非饮品不归任何饮品叶。软饮叶 `LEAF_RULES.priority` 恒高于酒类/乳品叶(防 `零度可乐`→baijiu 类共现误归)。这些 tier1 口径**本期不动**,仅在其**之上**叠加 native 叶仲裁优先。

**诚实边界收敛**:P3.5 残留待人工(标题既无类型词又无品牌词的高端酒长尾,如裸 `剑南春`/`水井坊`)——本期由**门店 native 叶**兜住:这些商品的 `native_category_id` 命中其酒种叶 → store-map 落叶(不再待人工)。tier1 仍是 native 缺失商品的主路径。

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

#### 场景:标题命中叶关键词即确定归属(native 缺失时)
- **当** 标题含「可乐 / 汽水 / 雪碧」碳酸叶关键词且无 native 叶命中
- **那么** tier1 **必须**确定性挂 `碳酸饮料` 叶;`苏打水 / 气泡水` **必须**归 `饮用水` 叶 + `attribute:气泡`

#### 场景:tier1 跨 cohort 反例在 native 缺失时仍由 tier1 兜住
- **当** 标题为「零度可乐」(碳酸软饮,含裸 `度`)且无 native 叶命中
- **那么** tier1 **必须**归 `carbonated`(禁裸 `度` + 软饮叶 priority 优先),**禁止**落 `baijiu`

#### 场景:都无确定叶(tier1 与 native 均未命中确定叶)则待人工、不强归
- **当** tier1 未命中 / tie 且 `store_category_map` 也未命中确定叶(native 为 null 或映射缺失)
- **那么** **品类归属留空** + 标「待人工」,**禁止**由 LLM 或猜测强归;**禁止**改 `product.category` 列
