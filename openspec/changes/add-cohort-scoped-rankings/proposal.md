## 为什么

P3（`add-category-tree-rankings`）把默认 `/rankings` 收紧为「闭包成员 ∧ rankable ∧ per100ml」，但生产实测暴露两个问题（见 backfill-gap 诊断）：

1. **覆盖不足**：prod 376 条 per100ml 可算商品里只有 42 条被 tier1 分类（覆盖 ~11%），默认榜从 376 崩到 42。诊断 334 条未分类的构成：**酒类 ~280、乳品 ~24、漏判软饮 ~30**。
2. **模型混类**：P3 的「rankable 叶出现在所有祖先榜（含 root）」在只有软饮一个同质 cohort 时成立，但一旦把酒类/乳品纳入比价就**跨 cohort 混**——root 榜会把矿泉水（¥0.5/100ml）和葡萄酒（¥160/100ml）同榜，酒类父榜会把啤酒和威士忌混排。per100ml 只在**同质 cohort 内**（啤酒比啤酒、葡萄酒比葡萄酒）才是有效购买比价。

本变更（P3.5）把 per100ml 榜重构为**绑定点 cohort 制**（cohort = `comparable_unit` 绑定点；注：`软饮` 是刻意宽的便利 cohort、内部不强求价格同质，矿泉水 vs 果汁不在一个量级仍同榜——见 design D2 诚实边界；真正挡的是跨绑定点的酒类父/root），并补齐分类覆盖：新增**乳品**类、让**酒类各叶可按 per100ml 出各自的 cohort 榜**（满足「部分酒类也能做 per100ml 榜」），扩 tier1 规则把存量分类掉，并修正默认榜与跨 cohort 混类问题。

## 变更内容

- **品类树扩展**：① 新增 `乳品(per_100ml)` 节点 + 细分叶（牛奶 / 酸奶 / 乳酸菌饮料）挂在 `饮料` root 下，与软饮/酒类并列；② 把 `comparable_unit=per_100ml` **绑到各酒种叶**（啤酒 / 葡萄酒 / 白酒 / 洋酒 / 威士忌 / 清酒果酒），**不绑酒类父节点**——使每个酒种成为自己的可排名 cohort，而酒类父节点解析单位仍为 `null`。
- **Cohort 守卫（核心模型修正）**：`/rankings` 榜**只对「自身解析出非空 `comparable_unit`」的节点开放**（软饮 / 软饮叶 / 乳品 / 乳品叶 / 各酒种叶）；**跨 cohort 节点（酒类父、root `饮料`）解析为 `null` → 拒绝开榜**（`400`，提示选子 cohort），杜绝「水 + 酒」「啤酒 + 威士忌」混榜。
- **BREAKING（行为）默认榜节点 root → 软饮**：默认 `/rankings`（无参）由 P3 的 `category=beverage`(root) 改为 **`category=soft-drink`**（契合「山姆软饮榜」定位）；显式 `category=beverage`/`category=alcohol`（解析单位 null）由 P3 的 `200 []`/`200 混` 改为 **`400`**。
- **tier1 规则扩展**（`packages/core` `CategoryLeafSlugSchema`+`LEAF_RULES`，纯函数 + 脏标题样本单测）：补**乳品**（牛奶/鲜牛奶/纯牛奶/酸奶/乳酸菌）、**明显酒类**（葡萄酒/白酒/茅台/大吟酿/干邑/威士忌/麦卡伦…，**全词/型号/品牌词**——裸 `啤`/`度`/`香槟`/`山楂` 等**禁止单独定叶**，详见 category-tagging spec）、**漏判软饮**（椰子水/燕麦奶/豆浆/坚果乳、各种 NFC 果汁/醋饮、电解质水/泉水、咖啡浓缩液/本草饮料）关键词；稀奶油等非饮品判不可比、不入榜。
- **存量纠正**：seed 幂等迁移落乳品树 + 酒类叶单位绑定 → 重跑 `POST /admin/backfill` 重分类 → 重跑 4.3 数据就绪门验收（各 cohort 榜基数合理、残留 B 仅为已确认非软饮）。
- **category-tree 语义简化**：`node.rankable`（= 解析 `comparable_unit` 非空）现等价于「该节点可点进榜（单一 cohort）」；消费契约从 P3 的「用 `rankableCount>0` 判榜入口」简化回「用 `rankable` 判」（root/酒类父 `rankable=false` 即不可点进，与守卫一致）。

## 功能 (Capabilities)

### 新增功能
（无——均为既有能力的扩展/修正）

### 修改功能
- `category-tagging`: 品类树新增乳品节点+叶、酒类叶绑 `per_100ml`（成为可排名 cohort）；tier1 关键词规则扩展（乳品/酒类/漏判软饮）；打标签仍确定性、AI 不判品类（红线不动）。
- `rankings-api`: 引入 cohort 守卫（榜只对解析单位非空节点开放，跨 cohort 节点 `400`）；默认节点 root→软饮。
- `category-tree-api`: `node.rankable` 语义收敛为「可点进榜」、消费契约简化；`rankableCount` 对 `rankable=true`（可点进）节点 = 其 cohort 榜基数，对 `rankable=false`（root/酒类父）节点为分支信息性计数、**不对应任何榜**。
- `persistence`: seed 迁移落乳品树 + 酒类叶单位绑定；repository 榜查询/树查询机制**不变**（仍闭包+rankable+per100ml+DISTINCT），cohort 守卫**不在** repository——见下。

## 影响

- `packages/core`：**`CategoryLeafSlugSchema` + `LEAF_RULES` 加 9 个新叶 slug（6 酒种 `baijiu/wine/spirits/whisky/beer/sake-fruit-wine` + 3 乳品 `milk/yogurt/lactic-drink`）**（schema 改动,非 calculator）；tier1 规则扩展 + 脏标题样本单测（乳品/酒类/漏判软饮分类，含稀奶油及 `零度可乐`/`啤梨汁`/`山楂酒` 等跨 cohort 误归反例）。`spirits`≠`whisky` 分两叶两规则。
- `packages/db`：新增幂等 DML seed 迁移（乳品节点+叶、`category_closure`、酒类叶 `comparable_unit=per_100ml` 用 `UPDATE` 翻转、`seedTaxonomy()` 同步加独立 UPDATE）；repository 榜查询/树查询**不加守卫、谓词不变**，`listCategoryTree` 的 `rankable` 语义随 DB 列自动对齐。
- `apps/api`：`/rankings` cohort 守卫在此层、用**编译期静态解析器**（`resolveComparableUnitStatic` over `CATEGORY_NODES`，**非**运行期 `repo.resolveComparableUnit`）；默认 `category=soft-drink`；静态解析单位为 null 的节点（root/酒类父）→ `400 invalid-request`。
- `packages/api-client`：`CategoryTreeResponseSchema` 字段集不变（`rankable` 语义变、非结构变）。
- 运维：合并后重跑 backfill + 4.3 门验收（生产经自动 migrate 落 seed 迁移）。
- **客户端兼容**：默认榜 root→软饮（数值上软饮榜 ~42→~68，更正确）；`category=beverage`/`alcohol` 改 `400`。无线上消费方（小程序未上线），可平滑切换。
- **合规**：纯分类/读，不触抓取/众包敏感面。

## 非目标

- **per-纯酒精 / 度数轴**：白酒/烈酒的 per100ml 榜由「按容量单价」给出（受品牌档次影响），更公平的「按标准杯/纯酒精」value 榜需 `度数` attribute，留 v2。
- **store-map 接通（native-id ingest）**：高端/品牌酒类中**标题不含本期已列入品牌/类型词的纯长尾**（如未列入规则的 `剑南春`/`水井坊`/`习酒` 等酒厂品牌、标题又无「酒」字）tier1 关键词召回有限，靠山姆 native `categoryIdList` 收最稳——但需 ingest 加 native-id 字段 + 存量 HAR 回填，留作后续；本期 tier1 关键词（含 `国窖/大吟酿/干邑` 等已列入品牌词）覆盖大头，残留未列入品牌的长尾接受落「待人工」（不进软饮榜、不污染 cohort）。
- 不引入 LLM 判品类（本期红线）。
- 不做跨店同款匹配；不做组合装/礼盒拆解。
- 不在本期接通小程序分类树 Tab（API/榜语义定对即可，接通留后续小程序变更）。
- core **计算层（calculator）不改**：per100ml 对酒类/乳品本就已算出（它们已有 per100ml 值），本期不动 calculator。**但 core 的 tier1 叶枚举（`CategoryLeafSlugSchema`）+ `LEAF_RULES` 确有改动**——须加 9 个新叶 slug（6 酒种 + 3 乳品）才能让 tier1 产出酒类/乳品叶（当前枚举仅 4 软饮叶）。「core 不改」仅指 calculator，勿误读为 core 零改动。
