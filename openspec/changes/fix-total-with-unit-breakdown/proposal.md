## 为什么

真机众包数据暴露一个 tier1 解析 bug:`多维刺梨柠檬饮 2.1L(100mL×21)`(原价 ¥69.90)被解析成 `unitSize=2.1L`、`quantity=21` → `totalAmount=44.1L` → `per100ml=¥0.159`(**错**,正确应 **¥3.33/100ml**),单价偏低 **21 倍**。

根因:标题同时有**前导总量** `2.1L` 与**括号拆解** `(100mL×21)`。`parseTier1`(`packages/core/src/parser.ts`)的 `SIZE_RE` 取标题里**第一个** size token——抓到前导「2.1L」当 `unitSize`;`QTY_RE` 在其后找到「×21」当 `quantity`;calculator 算 `total = unitSize × quantity = 2100ml × 21 = 44.1L`。但这个 `×21` 实际绑定的是括号里**紧邻它的** `100mL`、不是 2.1L。真实含义:总量 2.1L = 21 瓶 × 100mL。即**乘数应绑「最近的前置 size」**,而当前代码把乘数与「第一个 size」错配,导致总量被重复计算。

这类「总量(单件×N)」括号复述总量的标题在山姆饮料里真实存在(组合装、礼盒),会系统性把单价算低数倍,污染真实单价榜。

## 变更内容

- **tier1 加「总量复述识别」规则,经自洽门触发**:当 `[*×x]<N>` 乘号左侧窗口出现**两个以上** volume size(`<总量Vol>(<单件Vol>[*×x]<N>)` 或 `<总量Vol> <单件Vol>×<N>`),**且** `单件Vol×N ≈ 前导Vol`(换算到 ml、相对误差 ≤10% 自洽)时,以**最靠后的 size** 作 `unitSize`、`<N>` 作 `quantity`、`totalAmount=单件Vol×N`;前导总量不再参与相乘。
- **自洽门是关键**:`单件Vol×N` 与前导**不自洽**(如 `550mL便携装 1.5L*6`:1.5L×6=9000≠550)时,前导极可能是**品名营销词**(`2L装`/`便携550mL`)而非总量,**不重绑、保持现状**——避免把品名容量误当总量造成回归。`2L装可乐 330ml*6`(2000 对 1980,取整 1%)自洽则改绑。
- **普通「单件*N」格式行为不变**:如 `300mL*24`、`330ml*24听`(乘号左窗口只一个 size)仍正确;`24x500mL`(数量前置)、`4L`(单件)等既有规则不回退。
- **验收锚点 = `packages/core` 单测**(对 `unitSize`/`totalAmount`/`per100ml` 值做真断言)。`多维刺梨柠檬饮 2.1L(100mL×21)` 等样本也加进 `packages/eval` corpus,但仅为**防未来漂移**——`eval/score.ts` 当前不消费 `expected` 值(只看 recall/quantityAccuracy/computability/perUnitError),对本 bug 是 vacuous-green,**不**作修复验证证据。

## 功能 (Capabilities)

### 新增功能
<!-- 无新建 capability;作为 spec-parsing 能力的增量需求引入 -->

### 修改功能
- `spec-parsing`: 新增「乘数绑最近前置 size(总量括号复述场景)」需求——`[*×x]<N>` 乘数前紧邻另一 size token 时,以该紧邻 size 为 `unitSize`、`N` 为 `quantity`,更早的前导 size 为 `totalAmount`(交叉校验 `单件×N≈前导总量`);普通「单件*N」无前导 size 时行为不变。明确这是 tier1 抽取规则,计算层不变。
- `eval-harness`: 加「总量(单件×N)」脏标题回归样本,纳入 tier1-only 与 tier1+tier2 准确率回归基线(若回归样本集属该能力)。

## 影响

- **代码**:`packages/core/src/parser.ts`(`parseTier1` 的 size/quantity 绑定逻辑 + 前导 size→totalAmount)、`packages/core` parser 单测(脏标题样本集)、`packages/eval` 回归样本/corpus。
- **不触碰**:`calculator`/`consistency`(计算正确,错在 tier1 抽取的输入)、可比判断、`apps/api`、`packages/db`(persistence/product 去重是另一个独立变更)。
- **数据**:已落库的错值不在本变更范围(生产数据将在 parser 修复上线后整体删除、重新录入——见会话决策)。
- **合规面**:无(纯解析准确率,不碰抓取/众包面)。
- **非目标 / 已知残留**:不重写整个 tier1 正则;只修**自洽**的总量复述(`单件×N ≈ 前导`),且确保**品名 size 噪声不被误改绑**;「真总量但标签印刷误差超 10%」(如 `2L(330ml×5)`)自洽门挡后**仍误算**(无法与品名噪声区分),本变更不修。不改计算层/可比;不动 persistence。
