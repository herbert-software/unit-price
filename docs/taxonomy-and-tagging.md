# 品类与标签体系设计

> 设计稿。SOT 为 [`architecture.md`](architecture.md);本文**细化并部分取代**其「comparability / CategoryPlugin / comparison_group」一节(关系见第九节)。用于后续 `category-tagging` / `add-database` OpenSpec 提案。

## 一、为什么

商品库增大后,必须能**按品类做横向对比**(只看碳酸饮料,不混啤酒/纸品),且未来要接入多家商超(山姆/Costco/盒马…)。因此:

- **自建 store-agnostic 的规范品类/标签体系**,各商超原生分类**映射进**它——不照搬任一商超。
- 一个商品**多标签、多节点可搜**;复合概念(无糖可乐、无糖饮料)用**原子标签 + 复合查询**,**不物化**(避免组合爆炸)。
- 守红线:**品类/可比判断由确定性程序(规则)+ 人工定**,AI 只提候选(理解、不判断)。

## 二、模型:品类 is-a 树 + 正交标签轴 + 向上传播

标签分 `kind`:

| kind | 例 | 结构 | 作用 |
|---|---|---|---|
| **category 品类** | 碳酸饮料 ⊂ 软饮 ⊂ 饮料 | is-a 树(**单归属**) | 绑定**可比单位**、定义对比 peer 集 |
| **attribute 属性** | 无糖、进口、有机、气泡 | 扁平多值 | 跨品类筛选 |
| **brand 品牌** | 可口可乐 | 扁平 | 身份/去重(品牌**权威存于 tag 侧**) |
| **product_line 品名系列** | 可乐、零度 | 扁平 | 同系列对比 |

**「多节点可搜」= 两机制叠加**:① 品类 is-a 向上传播(归一个叶子→自动是祖先成员);② 正交标签命中。

**复合查询能力**(原子标签组合,含**跨品类并集**):
- `碳酸饮料` = 品类闭包 ∋ 碳酸饮料
- `无糖碳酸饮料` = 碳酸饮料闭包 ∧ attribute:无糖
- `无糖可乐` = product_line:可乐 ∧ attribute:无糖
- `无糖饮料` = 品类闭包 ∋ 饮料 ∧ attribute:无糖
- `所有气泡饮品` = **attribute:气泡**(不限品类子树——attribute 过滤独立于品类闭包,可跨碳酸/饮用水等子树取并集)

### 单归属与歧义叶判定(规则,非 AI)
品类**单归属**:一个**已完成分类**的商品归到**恰好一个叶子**品类(经 `product_tag(kind=category)` 挂该叶)。允许一个**中间终态**:仅有粗 native 映射、标题又无细关键词时,商品停在 `category` 字段层的**非叶节点指针** `product.pending_category_tag_id`(`粗分类/待细化`,**不写入只挂叶的 `product_tag`**),并置 `rankable=false`——此态商品**不出现在任何对比榜中(包括其挂载的那个非叶节点本身的榜)**,直到 tier1 规则/人工把它落到叶子(转为正式 `product_tag` 叶标签、清 pending)。归属由 **tier1 关键词规则表**确定性给出(命中即定),规则给出优先级以解歧义:
- 例:气泡水/苏打水 → 归 `饮用水` 叶(规则:`苏打水/气泡水/含气矿泉`→饮用水),**物理上的「含气」由 attribute `气泡` 承载**,不再单独归「碳酸饮料」。「碳酸饮料」叶专指含糖配方汽水类(可乐/汽水/雪碧)。(本期 `饮用水` 为单叶;`气泡·电解质` 等子分待软饮 HAR 细化,见 §八。)
- 规则冲突(同时命中两叶关键词)→ 取**优先级更高**的那条:判据 = **目标叶在 is-a 树更深(更细) > 规则显式优先级数 > 匹配长度**(长度仅作末位 tiebreak,非主判据;优先级数由规则表对每条规则显式赋值、人工维护,初版可空——空则退到深度/长度)。仍无法判定 → `category` 留空 + 标 `待人工`,不强归。

### 工作示例
- `可口可乐 无糖 330ml*24`:原子标签 `品类=碳酸饮料`、`属性=无糖`、`品牌=可口可乐`、`品名=可乐` → 品类成员经传播:碳酸饮料/软饮/饮料。横向对比「碳酸饮料」按软饮继承的 `per_100ml` 排名。
- `屈臣氏苏打水 330ml*24`:`品类=饮用水`、`属性=气泡`。搜「碳酸饮料」**不含它**(它归饮用水);搜「所有气泡饮品」(attribute:气泡)**含它**与含糖汽水。这是预期——含气 ≠ 含糖碳酸,二者分别由 attribute 与 category 表达。

## 三、数据模型(供 schema 落地)

```
tag                      标签字典
  id, slug, name,
  kind ∈ {category, attribute, brand, product_line},
  parent_id NULL,          -- 仅 category kind 用,构成 is-a 树
  comparable_unit NULL     -- 仅 category kind:per_100ml / per_100g / per_100sheet / null
                           -- 单点绑定 + 向下继承(见第四节);不在每个叶子重复标

product                   规范商品(ParsedSpec 派生 + 跨店身份)
  id, canonical_title,
  pending_category_tag_id NULL,  -- 「粗分类/待细化」非叶终态指针(§二);非空时 rankable=false、不出任何榜
  rankable                       -- 派生:有叶 category 且单位可解析才 true
  -- 品牌不在此存权威值,以 product_tag(kind=brand) 为准

product_tag               商品↔标签(**只挂原子/叶子标签**:叶 category + attribute/brand/product_line;非叶「待细化」不写此表,走 product.pending_category_tag_id)
  product_id, tag_id,
  source ∈ {rule, llm, store-map, manual},
  confidence

store_category_map        各商超原生分类 → 我们的 tag(N:1)
  store, native_category_id, tag_id
  -- 多个 native_id 可映同一 tag;粗 native 只能映到对应**粗(非叶)**节点(禁止下放到细叶);
  -- 无匹配 native → 不映射,商品 category 留空 + 待人工

category_closure          品类 is-a 闭包(tag 维度,非 product 维度——避免 product×祖先 大表)
  tag_id, ancestor_tag_id  -- 叶 tag → 其全部祖先 tag;product 命中靠 product_tag JOIN 此表
```

- **对比节点 = category 节点闭包 [∧ attribute 过滤]**,按该节点解析出的 `comparable_unit` 排名。
- **comparable_unit 解析(含回退)**:取目标节点自身的 `comparable_unit`;为 null 则**向上沿 is-a 找最近一个非空祖先**;若一路到 root 仍无 → 该节点**不可排名**(`rankable=false`,前端不出榜 + 给「该品类暂不支持横向对比」提示),**禁止 null 单位进入排名**。
- **可比纪律分两层(正交)**:
  - **品类归属/单位**(本文)决定「比哪一组、按什么单位」;
  - **商品是否可比**(`comparable`/`excludedReason`,见第九节)决定「这个商品本身能不能参与」(规格缺失/组合礼包/赠品复杂/促销复杂)——这不是品类问题,**仍归 core `comparability` 承载**,与 tag 模型并存。

## 四、初始品类树(规范层,从山姆饮品树 seed,用我们的命名)

命名来源:山姆「酒水饮料」`grouping/queryChildren`(剔除营销节点「为您推荐/新品上市/微醺小酌」与品牌节点「茅台\*」)。**这是我们的规范树**,山姆 `categoryIdList`(数值路径)映射进来。`comparable_unit` **绑在「软饮」,叶子继承,不重复标**:

```
饮料(root,comparable_unit=null)
├ 软饮  comparable_unit = per_100ml   ← 单点绑定,下面全部继承
│  ├ 碳酸饮料        (含糖汽水:可乐/汽水/雪碧)
│  ├ 果汁/植物饮     (常温果汁 / 植物饮)
│  ├ 咖啡/茶饮       (茶饮 / 咖啡饮料 / 能量饮料)
│  └ 饮用水          (本期单叶;气泡·电解质等子分待细化,见 §八)   ← 气泡水归此 + attribute:气泡
└ 酒类  comparable_unit = null(本期不出榜)
   ├ 白酒 / 葡萄酒 / 洋酒 / 威士忌 / 啤酒 / 清酒果酒
   └ 酒类可比口径(每100ml? +度数? 单独榜)待样本到位定;本期 rankable=false
```

> 范围提醒:本次 HAR 全是「酒水饮料」部门、~66% 是酒类,**软饮样本少**。软饮各叶细分与可比单位校准需补一份**软饮为主的 HAR**(§八)。

## 五、打标签管线(守「AI 理解不判断」红线)

```
标题 → tier1 关键词规则(确定性,**只产叶**):可乐/汽水→碳酸叶;无糖→属性无糖;品牌词→brand;苏打/气泡水→饮用水叶+属性气泡(气泡·电解质子分待细化,见 §四/§八)
     → store_category_map:山姆 categoryId(数值路径)→ 我们的 tag(高置信)
     → 仲裁(品类 kind),确定性优先级,对 `tier1 ∈ {未命中, 命中叶, 多叶tie}` × `store-map ∈ {未命中, 命中叶, 命中粗节点}` 全覆盖(tier1 只产叶,无「命中粗节点」态;tier1 多叶等优先级不可判 = `多叶tie`,视作「tier1 无确定输出」可落 ③ 回退):
        ① **两方都命中、粒度冲突**(粗细不同)→ 取更深(更细)叶(一般判据「取更深叶」双向适用,如 `tier1 细叶` > `store-map 粗节点`);
        ② **两方都命中、同粒度异叶**(如 tier1=碳酸、store-map=果汁,等深不同叶)→ **tier1 关键词 > store-map**(标题细粒度证据强于商超粗映射);
        ③ **仅一方有确定叶输出**(含 `tier1 多叶tie` 视为 tier1 无确定输出):仅 tier1 命中叶 → 采该叶;仅 store-map 命中**叶** → 采该叶(含 tier1 tie 但 store-map 有干净叶时,**采 store-map 叶**而非锁待人工);仅 store-map 命中**粗(非叶)节点** → 暂停「粗分类/待细化」(见 §二);
        ④ **两方都无确定叶输出**(tier1 tie/未命中 且 store-map 未命中)→ 若有 LLM 候选过 guard 则用,否则 `category` 留空 + `待人工`
     → LLM 候选确定性 guard(**对所有 kind**):category 候选必须落**已知 category 节点白名单**、attribute 候选必须落**已知属性受控值白名单**、brand/product_line 候选须落已知值或→ `待人工`;**kind 误判**(如把「无糖」当 category)= 非对应白名单 → 直接丢弃,不采纳。(受控属性值表初始 = tier1 已覆盖属性(无糖/气泡/进口…)+ 人工 seed,纳入人工维护,与 category 节点白名单**同源治理**。)
     → 确定性闭包(挂叶→category_closure 补祖先)
     → 人工纠错(source=manual,沉淀规则/few-shot)
```
- LLM 永不单方面定品类/标签:只在规则/映射未命中时给候选,且**任何 kind 的候选都须过对应受控白名单 + kind 校验**,否则落人工。tier1 规则未覆盖的属性(有机/进口)由「LLM 候选过属性白名单」或人工补,不靠 LLM 自由造值。这守住第一节红线。

## 六、跨商超

- 规范 tag 是**跨店 join key**;各店原生分类经 `store_category_map`(N:1)映入,粗细失配按第三节规则处理(粗 native 不下放、无匹配待人工)。
- 标题自动打标签 **store-agnostic**(对任意店标题都跑)。
- 跨店同款识别(山姆 vs 盒马同一款可乐)→ brand + product_line + spec,沿用 **`qa.md` §十七 商品匹配 Level 1/2/3**(后续 v2)。

## 七、分期

- **v1(随 `add-database` / Phase 3)**:tag 字典(kind + is-a + comparable_unit)、product_tag、store_category_map、category_closure;自动打标签 = tier1 规则 + 山姆 map(LLM 候选稍后)。
  - **v1 排名只支持 `per_100ml` 节点**(软饮全线):`comparable_unit` 字段虽落库,但 core 本期只算 per100ml(对齐 `unit-price-calc` 主规范「只产 per100ml」);非 per100ml 节点(酒类/root/未来纸品)`rankable=false`、不出榜。`per_100g`/`per_100sheet` 为 **v2 占位**,本期重量/纸品商品一律走 `unit-price-calc` 不可计算终态。
  - **`rankable` 已接入 `/rankings`(节点作用域榜)**:`GET /rankings?category=<节点 slug>`(缺省 `beverage` root)按 `category_closure` 闭包取该节点子树成员,入榜判据收敛为**合取**——① 闭包命中目标节点 ∧ ② `product.rankable=true`(资格门:已分类叶 ∧ 该叶解析出非空可比单位)∧ ③ 数据门(单价列非空,**列由可排名成员所在轴决定**;v1 唯一可排名轴是 per_100ml,故对任一节点含 root 均为 `per100ml IS NOT NULL`)。两门各司其职、缺一不可:`rankable` 答「该不该上可比轴」、数据门答「是否真有该数」。`rankable=false` 行(酒类叶 `comparable_unit=null`、待人工/待细化软饮)**一律不入任何节点榜**——这同时修正了「按容量轴排序酒类」的语义错误。配套 `GET /categories` 输出 category is-a 树,每节点带继承解析的 `comparableUnit`、节点自身轴标记 `rankable` 与闭包后代可排名数 `rankableCount`(后者与节点榜基数逐字一致、与 `rankable` 正交:root `rankable=false` 但 `rankableCount>0`=默认榜基数)。
- **v2**:LLM 候选打标签 + 白名单 guard;**eval 新增「品类标签准确率」维度**(见下);策展视图(无糖饮料等保存查询);跨店同款匹配;酒类/纸品等可比单位与计算扩展(届时 core 增 per_100g/per_100sheet 计算 + 解除 spec-parsing `category` 恒 beverage 约束)。

### eval「品类标签准确率」(是 eval-harness 的**新增需求**,非复用)
现行 `eval-harness` 主规范的真值字段是 `samPkgNum/samPkgUnit/samUnitPrice/isCompare`、指标是召回/可算率/quantity 精度/per-unit 误差——**均无品类**;`spec-parsing` 的 `category` 现恒为 `beverage`。故品类准确率需配套:
1. `eval-harness` 增真值字段 `samCategoryLeafId`(HAR 提取器**新抽** `categoryIdList` 的**叶 ID**=路径末端;已用真实 HAR 验证 `categoryIdList` 存在且为稳定数值路径、簇纯净);
2. **评分桥(关键)**:预测侧是**我们的名称叶 tag**,真值侧是**山姆数值叶 ID**,二者在不同空间——故须一张**人工策展的评分金标准** `eval_category_gold(samCategoryLeafId → 我们规范叶 tag)`,比对粒度=**叶对叶**;指标 = 我们打的叶 tag 是否等于 `gold[samCategoryLeafId]`,算 precision/recall + 新回归方向。**缺键/留空分支**(对齐 eval-harness 既有纪律「缺真值→不计该指标」「空分母→n/a 不入回归」):
   - 样本的 `samCategoryLeafId` 在 gold 中**缺键**(gold 人工策展、必然部分覆盖)→ 该样本**不计入** precision/recall(标「无品类真值样本」),不算 miss;
   - 我们管线把商品判为**留空/待人工**(无叶 tag)而 gold **有**叶 → 计 **recall miss**(这是真漏判);
   - 任一指标合格样本数为 0 → 记 `n/a`、不参与回归;
3. **不自指**:该评分金标准**独立于生产 `store_category_map`**(后者用于「打标签」,前者用于「评打标签」,两表分开人工维护)——禁止用 `store_category_map` 自身当评它自己的真值;
4. `spec-parsing` 解除 `category` 恒常量、接入打标签管线。
`store_category_map` 的正确性另行人工抽检(对照评分金标准),不混用。

## 八、未决问题

- **闭包**:查询期递归 vs 物化 `category_closure`(tag 维小表;规模到一定量再物化 product 命中)。
- **酒类可比单位**:每100ml? +度数 attribute? 标准杯/单独榜——待软饮 HAR + 酒类样本到位定。
- **组合装/礼包**(非饮料,如洗发水+护发素套装):单归属 is-a 无法表达多归属/拆解,待 CategoryPlugin 扩展期(`architecture.md` Phase 4 复杂品类扩展)定;本期穿刺线=饮料,不触发。
- **attribute 轻 is-a**(无糖 ⊂ 控糖?):首版扁平,按需再加。
- **软饮样本失衡**:本期语料酒类为主,软饮细分与单位校准依赖补抓软饮 HAR。

## 九、与 architecture / 既有规范的关系(取代/并存/衔接)

| 既有(architecture / 归档主规范) | 本设计 | 关系 |
|---|---|---|
| `CategoryPlugin.getComparableUnits(spec) → [per_100ml, per_liter, per_bottle]`(代码、单品类**多单位数组**) | `tag.comparable_unit`(数据、**单值=排名主单位**);展示派生单位(每升/每瓶)由前端从 per100ml + 规格换算 | **取代**:排名主单位收为单值存 tag;多单位仅作展示派生,不再各自当可比基准 |
| `comparison_group` 表(物化字符串分组) | category 闭包 ∧ attribute **动态查询** | **取代**:对比组不物化,改查询(`comparison_group` 表废弃) |
| `comparable` / `excludedReason`(商品是否可比) | 不覆盖——仍由 core `comparability` 产出 | **并存正交**:本设计管「比哪组/按什么单位」,comparability 管「该商品能不能参与」(组合/赠品/规格缺失) |
| `unit-price-calc` 本期**只产 per100ml**、不引入 comparable/comparisonGroup | `comparable_unit` 多值为 v2 | **衔接**:v1 仅 per100ml 节点可排名(对齐主规范);非 per100ml 字段只存不算,v2 再补计算 |
| 节点榜入榜判据(P3 前两套并存:扁平榜「仅 `per100ml IS NOT NULL`」vs taxonomy 资格门) | `/rankings` 节点榜判据 = 闭包成员 ∧ `rankable=true` ∧ 数据门(列随节点轴,v1 一律 per100ml) | **收敛**:P3 起两套判据合一为**合取**;`rankable` 接入 `/rankings` 作资格门,数据门列由可排名成员轴决定;`/categories` 暴露品类树供浏览,`rankableCount` 与节点榜基数一致 |
| `spec-parsing` `category` 恒 `beverage` | 打标签管线产真实品类 | **衔接**:v2 解除恒常量约束,改由管线/map 赋值 |
