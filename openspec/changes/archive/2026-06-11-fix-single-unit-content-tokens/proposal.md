## 为什么

真机众包数据暴露 tier1 单件推断的 false-negative:白酒/烈酒整类被误判不可算。`汾酒 55%vol清香型白酒 950ml`、`汾酒沪上青花 清香型白酒 53度 500mL`、`LFE 进口埃德华兹900单一葡萄园干红 750mL` 这类标题,tier1 **正确提取了 `unitSize`**(950ml/500mL/750mL),但 `quantity=null`、`totalAmount=null`、`per100ml=null`,warnings 写「无法确定总容量」。

根因:`parseTier1`(`packages/core/src/parser.ts`)的「孤立容量单件视为数量 1」推断,要求标题剩余部分**无任何数字数量信号**(`hasQuantitySignal(rest)` 为 false)才把 `quantity` 推断为 1。但 `QTY_SIGNAL_RE` 的末尾 `\d`(任意游离数字)会被**酒精度/百分比含量描述符**命中:`55%vol` 的 `55`、`53度` 的 `53`、品名 `埃德华兹900` 的 `900`。这些**不是数量**,却让 `hasQuantitySignal=true` → 拒绝推断 `quantity=1` → 单瓶商品(本可算)落成 `per100ml=null`。

这是 false-negative(本可算却保守为 null),**系统性影响整个白酒/烈酒品类**(都带度数、单瓶售卖),会随采集增长污染可比覆盖率。生产抽查现 3 条,品类铺开后会更多。

## 变更内容

- **tier1 单件推断的「数量信号」判定排除含量描述符 token**:`hasQuantitySignal` 在判定游离数字前,先剥离**明确的酒精度/百分比含量** token——`\d+(\.\d+)?\s*%vol`、`\d+(\.\d+)?\s*度`、`\d+(\.\d+)?\s*°`、`\d+(\.\d+)?\s*%`——这些是商品**含量描述符、非数量**。剥离后剩余无数字信号 → 推断 `quantity=1`、`totalAmount=unitSize` → `per100ml` 正常算。
  - 受益:`53度 500mL`、`55%vol 950ml`、`NFC 100%果汁 300ml` 等单瓶/百分比含量商品转为可算。
- **剥离只作用于单件推断的判据,不误删真实数量信号**:`CONTENT_TOKEN_RE` 只匹配「数字 + 含量后缀(`%`/`vol`/`度`/`°`)」,**绝不**匹配乘号 `[*×x]` 或「数字+包装单位」(`6瓶`/`24听`)。故 `白酒 53度 500ml*6瓶`(数量 `*6` 紧贴 size 之后)经既有 `QTY_RE` 得 `quantity=6`(`quantity≠null`、根本不进单件推断,与剥离无关)——含量 `53度` 不干扰正常数量抽取。单 size `300mL*24`、数量前置 `24x500mL`、品名噪声 `可口可乐X20 330ml`、总量复述 `2.1L(100mL×21)` 等既有路径不变。
- **验收锚点 = `packages/core` 单测**(对 `quantity`/`totalAmount`/`per100ml` 值做真断言)。脏标题样本也加进 `packages/eval` corpus 备未来用,但仅防漂移(`score.ts` 当前不消费 `expected` 值)。

## 功能 (Capabilities)

### 新增功能
<!-- 无新建 capability;作为 spec-parsing 能力的增量需求修改 -->

### 修改功能
- `spec-parsing`: 修改「孤立容量单件视为数量 1」需求——把「除 size 外无其他数字数量信号」的判据细化为「**明确的酒精度/百分比含量描述符 token(`NN%vol`/`NN度`/`NN°`/`NN%`)不计入『游离数字数量信号』**」,使带度数的单瓶烈酒/百分比含量饮料能正确推断 `quantity=1`;真实数量信号(乘号、数字+包装单位)仍抑制推断。

## 影响

- **代码**:`packages/core/src/parser.ts`(`hasQuantitySignal` / 单件推断判据)、`packages/core` parser 单测(脏标题样本)、`packages/eval` corpus 回归样本。
- **不触碰**:tier1 的 size/乘号/包装计数抽取主路径(只改单件推断的「无信号」判据)、tier2 LLM、`unit-price-calc`、去重(`saveParsed`)、persistence。
- **数据**:已落库的酒类假 null 行不在本变更范围(parser 修复上线后,新采集的同款会按 `(store,storeSku)` upsert 覆盖、重解析补算;历史行可后续重解析或随重录刷新)。
- **合规面**:无(纯解析准确率)。
- **非目标 / 已知残留**:品名里的**裸编号**(如 `埃德华兹900` 的 `900`,无 `%`/`度`/`vol` 后缀)难与数量区分,**保守仍抑制推断、留 `per100ml=null`**(已知残留、可接受边缘,与「宁可不算也不算错」哲学一致)。不重写 tier1 正则;只修「含量 token 不计数量信号」这一点。
