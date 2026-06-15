## 上下文

P3 已上线：`/rankings` 节点作用域 + rankable 门 + 闭包 + DISTINCT；`/categories` 树浏览；`comparable_unit` 单点绑定（仅 `软饮` 绑 `per_100ml`，叶继承）+ `rankable` 派生（已分类叶 ∧ 解析单位非空）。生产实测（read-only）：376 条 per100ml 可算商品仅 42 条 rankable（覆盖 ~11%），默认榜 376→42。诊断 334 条未分类构成：**酒类 ~280（葡萄酒 153 / 白酒 52 / 啤酒 21 / 洋酒烈酒 19 / 清酒 10 / 果酒等 ~25）、乳品 ~24、漏判软饮 ~30、稀奶油等非饮品 少量**。per100ml 区间 ¥0.81–¥889.9。

两个根因：① **tier1 覆盖不足**（关键词只命中明显软饮）；② **模型混类**——P3「rankable 叶出现在所有祖先榜（含 root）」在单一软饮 cohort 下成立，一旦纳入酒类/乳品就跨 cohort 混（root 榜混 水+酒、酒类父榜混 啤酒+威士忌）。per100ml 是良定义的「容量单价」单位（任何液体成立），但**榜是否有意义是 cohort 同质性问题**——只有同质 cohort 内（啤酒比啤酒）才是有效购买比价。

## 目标 / 非目标

**目标：**
- per100ml 榜重构为**同质 cohort 制**：软饮 / 乳品 / 各酒种叶各自出榜；跨 cohort 节点（酒类父、root）不出混榜。
- 满足「部分酒类也能做 per100ml 榜」：各酒种叶（啤酒/葡萄酒/白酒/洋酒/威士忌/清酒果酒）成为可排名 cohort、各有榜。
- 补齐分类覆盖：tier1 扩规则 + 新增乳品类 → 重跑 backfill → 4.3 门各 cohort 基数合理。

**非目标：**（见 proposal 非目标）per-纯酒精/度数轴、store-map native-id 接通、LLM 判品类、跨店匹配、组合装拆解、miniapp 接通、core 计算层改动。

## 决策

### D1：cohort 由「`comparable_unit` 绑定点」定义；per100ml 绑各酒种叶、不绑酒类父
- `comparable_unit` 单点绑定语义不变：一个节点的解析单位 = 自身绑定值，空则沿 parent 向上取最近绑定，到 root 仍空则 `null`。
- **绑定即定义 cohort**：`软饮` 绑 `per_100ml`（其子树=软饮 cohort）；本期**新增 `乳品` 绑 `per_100ml`**（乳品 cohort）；**各酒种叶各自绑 `per_100ml`**（每叶=一个酒种 cohort），`酒类` 父节点**不绑、保持 `null`**。
- 推论：`resolveComparableUnit(酒类父)` = 自身 null → 向上 root null → **`null`**（酒类父跨多个酒种 cohort、不是单一 cohort）；`resolveComparableUnit(啤酒)` = `per_100ml`；`resolveComparableUnit(root)` = `null`。
- 替代方案（被否）：把 `per_100ml` 绑在 `酒类` 父（像软饮那样）→ 酒类父榜会混啤酒+威士忌（per100ml 不可比）。故**酒类的 cohort 在叶级、不在父级**——这是与软饮（cohort 在子树级）的关键差异。

### D2：Cohort 守卫 —— 榜只对「解析单位非空」的节点开放（核心模型修正）
- **`/rankings?category=X` 当且仅当 X 的解析单位非空时开榜**；为 `null`（root `饮料`、`酒类` 父）→ `400 invalid-request`（提示「该节点跨多个可比 cohort，请选子分类」）。
- **解析必须走编译期静态解析器（基于 `CATEGORY_NODES`），不得用运行期 DB `resolveComparableUnit`**（见 D8）：否则未 seed 的合法 cohort slug（如迁移先于 seed 窗口的 `beer`）经运行期解析得 null→被守卫误判 400，与「合法但未 seed→200 []」冲突。静态解析对 `beer` 恒为 `per_100ml`、对 `alcohol/beverage` 恒为 null，与 DB seed 状态无关，两侧契约同时满足。
- 这道守卫天然消除 P3 的混类：root/酒类父解析 null → 拒绝；软饮/软饮叶/乳品/乳品叶/各酒种叶解析非空 → 开榜（各自一个「绑定点 cohort」）。
- 入榜判据**保持 P3 三门合取**（闭包成员 ∧ `rankable=true` ∧ per100ml 非空），仅**新增「目标节点静态解析单位非空」前置守卫**。闭包仍只返回该节点子树成员（软饮节点闭包=软饮，啤酒叶闭包=啤酒）。
- **cohort = 绑定点，不等于「价格同质」（诚实边界）**：「单一 cohort」严格指「整棵子树共享同一 `comparable_unit` 绑定点」（软饮子树共享软饮绑定；酒种叶各自绑定、无更深异绑后代），故「解析非空」⟺「单一绑定点」。这是一个**编码选择**，不是价格同质性证明：`软饮` 是一个**刻意宽的便利 cohort**，其内部跨碳酸/果汁植物饮/咖啡茶饮/饮用水（矿泉水 ¥0.5 与果汁/咖啡 ¥4+ 不在一个量级）；本期把 `乳品` 拆出独立 cohort（牛奶 vs 矿泉水 vs 鲜榨汁 不可比），但软饮内部不再细拆，是「v1 先按绑定点开榜、细化留后续」的权衡。**唯一必须挡的是「跨绑定点的祖先」（酒类父/root），它们解析恰为 null**——守卫即对此。这里用「绑定点 cohort」而非「同质 cohort」措辞，避免夸大软饮内部的可比性。

### D3：默认榜节点 root → 软饮
- 默认 `/rankings`（无参）从 P3 的 `category=beverage`(root, 解析 null→现会被守卫拒) 改为 **`category=soft-drink`**（解析 per_100ml、契合「山姆软饮榜」既有定位与 ScopeBar 文案）。
- `category` 参数缺省值 = `soft-drink`；仍编译期校验属 seed kind=category slug 全集（含乳品/酒种新叶）；显式传 `beverage`/`alcohol`（解析 null）→ `400`（D2 守卫）。

### D4：`node.rankable` 语义收敛 = 可点进榜；消费契约简化
- `/categories` 节点 `rankable`（= 解析 `comparable_unit` 非空）现**恰等于「该节点是单一 cohort、可点进榜」**：软饮/软饮叶/乳品/乳品叶/各酒种叶 = `true`；root `饮料`、`酒类` 父 = `false`。
- **消费契约简化**（取代 P3 的「用 `rankableCount>0`、不用 `rankable`」）：客户端**用 `node.rankable` 判榜入口**（rankable 节点可点进、其榜=该 cohort）；root/酒类父 `rankable=false` 即不可点进，与 D2 守卫一致。P3 那条「root rankable=false 却是默认榜」的矛盾随默认改软饮而消失。
- `rankableCount` 对 `rankable=true`（可点进）节点 = 其 cohort 榜基数（= `/rankings?category=该节点` 基数，DISTINCT、unit_price↔product 1:1）；对 `rankable=false` 节点（root/酒类父，`/rankings` 返 `400`、无榜）为**分支信息性计数**（其后代可排名数，P3.5 起酒类父 `>0`），不对应任何榜。

### D5：乳品节点 + 细分叶（从 prod 样本定）；非饮品判不可比
- 树：`饮料(root,null)` 下新增 `乳品(per_100ml)` → 叶 `牛奶 / 酸奶 / 乳酸菌饮料`（覆盖样本：纯牛奶/鲜牛奶/灭菌乳/巴氏/A2/娟姗/有机/脱脂/高钙、风味奶[巧克力奶/儿童配方]→牛奶或风味奶叶；酸牛奶→酸奶；活菌型乳酸菌饮料→乳酸菌饮料）。叶继承 `per_100ml`、`rankable=true`、各自有 cohort 榜。
- **植物奶（椰子水/燕麦奶/豆浆/坚果乳）归软饮 `果汁·植物饮`、不归乳品**（植物基、与牛奶不同 cohort）。
- **稀奶油等非饮品**（烹饪料）：tier1 判不可比 / 不归饮品叶 → `rankable=false`、不入任何榜（对齐「不可比标注」）。

### D6：酒类 per100ml 的「部分」范围 = 全部酒种叶各自出榜（按数据，每叶 ≥10 条）
- prod 各酒种均有足够商品（葡萄酒 153 / 白酒 52 / 啤酒 21 / 洋酒烈酒 19 / 清酒 10）→ **6 个酒种叶都绑 `per_100ml`、各有 cohort 榜**。
- **诚实标注**：啤酒/葡萄酒/清酒果酒 按容量消费、ABV 窄 → per100ml 榜最干净；白酒/洋酒/威士忌 价值由**度数+品牌**主导，其 per100ml 榜是「按容量单价」（受品牌档次影响、非「按酒精量」value），更公平的 value 榜需 `度数` attribute → v2（非目标）。本期各酒种 cohort 榜均为容量单价口径、不跨酒种混（D2 守卫）。

### D7：tier1 规则扩展（`packages/core`，纯函数无 IO、配脏标题样本单测）
- **注：这是 core schema 改动**——`spirits`/`whisky` 等 6 酒种叶 + 3 乳品叶须加入 `CategoryLeafSlugSchema` + `LEAF_RULES`（见 D8），叶 slug 见 category-tagging spec（钉死 ASCII）。
- 关键词集（grounded in prod 样本；**裸单字/泛描述词禁止单独定叶**，须与型/品牌词共现，权威列表见 category-tagging spec）：
  - **乳品叶**：`milk`=`牛奶/鲜牛奶/纯牛奶/灭菌乳/巴氏/风味奶`、`yogurt`=`酸奶/酸牛奶`、`lactic-drink`=`乳酸菌/活菌型`（排除「椰奶/燕麦奶/植物奶/豆浆」→植物饮；**禁裸 `奶`**）。
  - **酒类叶（6 叶,`spirits`≠`whisky`）**：`beer`=`啤酒/精酿/IPA/拉格`（**禁裸 `啤`**，撞 `啤梨汁`）；`wine`=`葡萄酒/红酒/干红/干白/赤霞珠/西拉/黑皮诺/长相思/起泡酒/香槟酒`（**禁裸 `香槟/庄园/BIN`**）；`baijiu`=`白酒/茅台/五粮液/泸州老窖/国窖/洋河/汾酒/酱香型白酒/浓香型白酒`（**禁裸 `度/浓香/酱香`**，撞 `零度可乐`/咖啡描述）；`sake-fruit-wine`=`清酒/大吟酿/纯米/獭祭/山田锦/果酒/梅酒`；`spirits`=`洋酒/白兰地/干邑/伏特加/金酒/朗姆/龙舌兰/轩尼诗/人头马`；`whisky`=`威士忌/whisky/麦卡伦/单一麦芽/苏格兰威士忌/波本`。
  - **漏判软饮**：植物饮`椰子水/椰汁/椰奶/燕麦奶/豆浆/坚果乳/植物蛋白饮`（`椰奶` 归植物饮、禁裸 `奶` 故不入乳品）；果汁`果汁/橙汁/NFC/西梅汁/桑葚汁/葡萄汁/醋饮/山楂汁`（**禁裸 `山楂`**，撞 `山楂酒`）；饮用水`电解质水/泉水/苏打水`；咖啡茶饮`浓缩液/黑咖/本草饮/麦冬`。
- **仲裁优先级**：软饮叶关键词命中时优先于酒类/乳品（防 `零度可乐` 落白酒、`啤梨汁` 落啤酒）；其余仲裁不变（确定性、AI 不判品类）；store-map 仍惰性（本期不接 native-id）；多叶 tie / 都无确定叶 → 待人工。
- **诚实边界**：高端/品牌酒长尾（标题既无类型词、又不含上方规则里的品牌词，如未列入的 `剑南春`/`水井坊`/`习酒`）tier1 召回有限 → 残留落待人工（不进软饮榜、不混 cohort、是正确排除的近似），彻底收靠后续 store-map。**自洽约束**：`国窖/大吟酿/干邑` 等**已列入规则的品牌词**会被命中（`国窖1573`→`baijiu`，非长尾），**禁止**当 manual 反例；只有未列入品牌/类型词的标题才落待人工。样本集据此区分，勿自相矛盾。

### D8：实现落点（复用 P3 机件）
- **节点计数词汇（防混淆,三组不同集合）**：① **自身绑定非空** = `tag.comparable_unit` 列 IS NOT NULL = `soft-drink + dairy + 6 酒种叶` = **8**（防漂移断言对象）；② **tier1 可落叶** = `CategoryLeafSlugSchema` = `4 软饮叶 + 3 乳品叶 + 6 酒种叶` = **13**（cohort 守卫放行/可点进的叶）；③ **静态解析非空（可开榜节点全集）** = 13 叶 + 2 绑定父（soft-drink、dairy）= **15**（含两个父级可点进节点）。三者各有其义、互不矛盾。
- `packages/db/seed.ts` + 新 DML 迁移：加乳品节点 `dairy(per_100ml)` + 三叶 `milk/yogurt/lactic-drink`（**三叶 `comparableUnit` 留空、继承 `dairy`,DML 这三叶行 `comparable_unit=NULL`**,与软饮叶同范式）、酒类叶 `comparable_unit=per_100ml`、对应 `category_closure`。**酒类叶必须用幂等 `UPDATE` 翻转 `comparable_unit`**（prod 已由 0004 落过酒种叶行=NULL，`INSERT OR IGNORE` 是 no-op、翻不动该列）；`seedTaxonomy()` **也须**在既有两遍 insert(`onConflictDoNothing`)+parentId-UPDATE 块**之后**追加**独立** `UPDATE tag SET comparable_unit='per_100ml' WHERE slug IN (6 酒种叶)`（镜像迁移）,**禁止**改 insert 为 `onConflictDoUpdate`（会连带覆写 parentId/name）。防漂移测试除「双 fresh 库等价」外**必须**新增「预置旧 P3 树→两路收敛到酒种叶 per_100ml」用例，并更新既有「comparable_unit 仅绑软饮一个节点」断言为 **8 个自身绑定非空节点**（`tag.comparable_unit` 列 IS NOT NULL = soft-drink + dairy + 6 酒种叶;软饮叶/乳品叶列为 NULL、靠继承,不计入）。
- **cohort 守卫用编译期静态解析器，不用运行期 `resolveComparableUnit`**：守卫在 `apps/api` 层用一个纯同步、派生自 `CATEGORY_NODES` 的 `resolveComparableUnitStatic(slug)`（沿 `parentSlug` 求继承，与 `CATEGORY_SLUGS` 同范式）；解析 null（root/酒类父）→ `400`。**禁止**复用 repository 的运行期 `resolveComparableUnit`（它 round-trip `tag` 表，对未 seed 的合法 cohort slug 解析得 null→会与「合法但未 seed→200 []」冲突，且每请求一次 D1 子查询）。运行期 `resolveComparableUnit` 仍服务打标签算 `rankable`，不变。`listRankings` 自身不加守卫（调用方守卫后才进入）；`listCategoryTree` 的 `rankable` 仍 = 解析非空（读 DB 列）、语义自动对齐。默认 node `soft-drink` 在 API 层。
- `apps/api/routes`：`category` 缺省 `soft-drink`；静态解析单位 null 节点 → `400 invalid-request`。
- `packages/core`：**tier1 叶枚举变更**——`CategoryLeafSlugSchema` + `LEAF_RULES` 加 9 个新叶（6 酒种 + 3 乳品），脏标题样本单测（D7，含跨 cohort 误归反例）。这是 core schema 改动（非 calculator）；`seed.ts` 编译期守卫耦合 core 叶与 seed 节点，须同变更落地。

## 风险 / 权衡

- [默认榜 root→软饮 + 酒类父/root 改 400] → 行为变化；无线上消费方（小程序未上线），平滑。在 spec/迁移说明标注。
- [白酒/烈酒 per100ml 榜受品牌档次主导、非纯 value] → 诚实标注（D6）；本期容量单价口径可用、度数轴留 v2。
- [高端酒长尾 tier1 漏判 → 待人工] → 不进榜、不混 cohort（正确排除的近似）；4.3 门残留 B 由「已确认非软饮」组成、可接受；彻底收靠后续 store-map（非目标）。
- [tier1 关键词误判]（如「果酒」含「果」误入果汁、「椰奶」含「奶」误入乳品）→ 仲裁优先级 + 脏标题样本单测覆盖这些反例（D7 已列）。
- [乳品 vs 软饮的 per100ml 可比性]（牛奶 ¥1 vs 矿泉水 ¥0.5 vs 鲜榨汁 ¥4）→ 各自独立 cohort 榜、不强行同榜；root 不出混榜（D2）。
- 合规：纯分类/读，architecture 第七节风险分层无新增暴露。

## 迁移计划

- DB：新增**幂等 DML seed 迁移**（乳品节点/叶 + 酒类叶 `comparable_unit` 绑定 + closure），乳品节点/叶/closure 用 `INSERT OR IGNORE`、酒种叶 `comparable_unit` 用显式 `UPDATE`(见 D8),可重复 apply；无破坏性 schema 变更（复用既有表）。**与 0004 同样:该新 DML 迁移不登记 drizzle `meta/_journal.json`**（wrangler 按目录扫描 apply,登记会让 `drizzle-kit generate` 误判 drift）。
- 部署：含代码 → feature 分支 + PR；合并 main 自动 migrate+deploy。
- 合并后：重跑 `POST /admin/backfill`（幂等）重分类存量 → 重跑 4.3 门验收。
- 回滚：seed 迁移幂等可重置；榜语义守卫/默认节点为读路径，回滚还原即可，无数据副作用。

## 待解决问题

- 乳品叶粒度（牛奶/酸奶/乳酸菌 三叶 vs 更细如「纯牛奶/风味奶」）→ 实现时按样本量定，倾向三叶起步。
- 白酒/烈酒是否本期就出 per100ml 榜 vs 等度数轴 → 本期出（容量单价口径 + 诚实标注），度数 value 榜留 v2。
- store-map native-id 接通时机（收高端酒长尾 + 跨店）→ 后续独立提案。
