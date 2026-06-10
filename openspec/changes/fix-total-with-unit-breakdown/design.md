## 上下文

`parseTier1`(`packages/core/src/parser.ts`)当前流程:
1. `SIZE_RE.exec(title)` 取标题里**第一个** `<数字><单位>` → `unitSize`、记 `sizeEnd`。
2. `QTY_RE.exec(title.slice(sizeEnd))` 在第一个 size **之后**找 `[*×x]<数字>` → `quantity`。
3. `totalAmount = unitSize.value × quantity`(同单位)。

对 `2.1L(100mL×21)`:步骤 1 取 `2.1L`(第一个 size),步骤 2 在 `(100mL×21)` 里找到 `×21`(`QTY_RE` 不要求乘号紧贴 size,只要在 size 之后),于是 `unitSize=2.1L × quantity=21 = 44.1L`。bug:`×21` 实际绑定的是它**左侧紧邻的** `100mL`,中间隔着的第二个 size 被跳过了,第一个 size(总量)被错当 unitSize。

## 目标 / 非目标

**目标:** 数量乘号 `×N` 在场时,`unitSize` 取**乘号左侧紧邻的 size**;更早的前导 size 作总量复述、不参与相乘。修复 `总量(单件×N)` 类标题,普通单 size 与数量前置场景不回退。

**非目标:** 不重写整个 tier1 正则;不处理其它未见脏格式;不改 calculator/consistency/可比;不动 persistence。

## 决策

**D1:重绑 `unitSize` 须先过「自洽校验门」,不是纯位置触发。**
实现:保留现有「取第一个 size + 其后 `QTY_RE` 找乘号」。`QTY_RE`(跑在 `title.slice(sizeEnd)` 上)命中后,**乘号在 title 的绝对位置 = `sizeEnd + qtyMatch.index`**(`qtyMatch.index` 相对 `qtySearch`,必须 `+sizeEnd`);取窗口 `title.slice(0, sizeEnd + qtyMatch.index)`,用 **global 正则**(`SIZE_RE` 现非 global,需 `new RegExp(src,'ig')` + `matchAll`/循环)取窗口内**最靠后**的 size = `nearestVol`。
- 若 `nearestVol` 就是第一个 size(单 volume size)→ 不进入,行为恒等不变。
- 若存在更早的 `leadingVol`(`nearestVol.index > 第一个 size.index`)→ **先过自洽门**:`leadingVol` 与 `nearestVol` **都为体积**、且 `|toMl(nearestVol)×N − toMl(leadingVol)| / toMl(leadingVol) ≤ 0.1`(±10%)。
  - 自洽门四条(短路顺序,**比较在最后**以防 NaN/Infinity):(a) `leadingVol` 与 `nearestVol` 都 `isVolumeUnit`;(b) `toMl(leadingVol) > 0`(除零守卫——`0L` 等非正前导直接不通过,**禁止**对其求相对误差);(c) `N > 0`;(d) `|toMl(nearestVol)×N − toMl(leadingVol)| / toMl(leadingVol) ≤ 0.1`。(a)(b)(c) 任一不满足即短路「不通过」、不进入 (d) 的除法。
  - **门通过**(四条全满足,真总量复述)→ `unitSize ← nearestVol`、`quantity ← N`、`totalAmount ← nearestVol × N`(派生,沿用 calculator 现有派生,不改 calculator)。
  - **门不通过**(不自洽 / 非体积 / 非正前导 / N≤0)→ **不重绑**,保持既有「`unitSize`=第一个 size、`quantity`=N」——`leadingVol` 极可能是品名营销词(`2L装`/`便携550mL`)而非总量,重绑会引入回归。
- 备选(否决):D2 旧设计「不自洽也采纳括号、只 warning」。**已废**——它作废了唯一能区分「真总量复述(自洽)」与「品名 size 噪声(不自洽)」的信号,导致 `550mL便携装 1.5L*6` 这类被误重绑(reviewer 抓到的 blocker)。自洽校验必须是**门**。

**D2:自洽校验是触发门(不是仅 warning)。**
`nearestVol × N ≈ leadingVol`(±10% 容差内、都体积)是「这是总量复述」的**判定依据**;不自洽即判定「前导不是总量(是品名噪声)」→ 不重绑、保持现状,不产生新行为。**不再**有「不自洽仍采纳括号」的分支。这把回归面收敛到零:门只在确有自洽的「总量(单件×N)」上改绑。

**D3:容差与单位。** 校验换算到 `ml`(复用 `units` 的 `toMl`/`normalizeMeasurement`/`isVolumeUnit`)比较,相对误差 ≤ **0.1(±10%)**——容纳 `2L装`=2000 对 `330ml×6`=1980(1%)的标签取整,拒绝品名噪声(数量级偏差)。换算只用于**比较**;`totalAmount` 仍沿用 `unitSize` 单位、parsing 不跨 `ml`↔`L` 落库(与既有一致)。

## 风险 / 权衡

- [品名营销 size 词被当前导总量 → 回归](reviewer 抓到的核心)→ **由 D1/D2 自洽门挡住**:`leadingVol × ... ` 不自洽时不重绑,`2L装可乐`(自洽,真总量取整)重绑、`550mL便携装 1.5L*6`(不自洽,品名噪声)不重绑。回归面收敛到「确有自洽总量复述」的真子集。tasks 须加品名噪声不重绑的回归断言固化。
- [重绑改动 size 选择可能影响既有样本] → 重绑只在「≥2 体积 size + 乘号在靠后 size 右侧 + 自洽门通过」时触发;单 size 与不自洽标题恒等不变。既有脏标题样本集全跑回归 + 新增品名噪声样本确认零回退。
- [无括号 `<总量> <单件>×N` 与「数量前置 `24x500mL`」窗口交叠] → 前置=乘号在 size 之前;本规则=乘号在靠后 size 之后,位置互斥;`24` 无单位不是 size,不构成 `leadingVol`;前后乘号并存仍后侧优先。
- [容差 ±10% 边界] → 取整标签(≤几 %)与品名噪声(数量级)间隔很大,10% 干净分离;`≤ 0.1` **含等号**——恰好 10% 差判自洽→重绑,>10% 一律不重绑(保守、不误判)。
- [除零 / 真总量但印刷误差超 10% 的残留] → 除零由守卫 (b) 挡(`前导_ml≤0` 不进除法,无 NaN/Infinity);「真总量但单件×N 不自洽」(印刷错 `2L(330ml×5)`)门挡后保持既有 buggy(总量×N),本变更**不修**(无法与品名噪声区分),已在 spec「已知残留」与 proposal 非目标显式承认——不声称修复一切总量复述。

## 迁移计划

1. `parser.ts`:`QTY_RE` 命中后,按绝对乘号位 `sizeEnd + qtyMatch.index` 取左窗口、global SIZE 取最靠后 size = `nearestVol`;`nearestVol ≠ 第一个 size` 时过自洽门(都体积 + `|toMl(nearestVol)×N − toMl(leadingVol)|/toMl(leadingVol) ≤ 0.1`),通过才重绑 `unitSize/quantity/totalAmount`,否则保持现状。
2. parser 单测:`2.1L(100mL×21)`(自洽改绑)、`2L装可乐 330ml*6`(取整自洽改绑)、`550mL便携装 1.5L*6`(不自洽不改绑)、`2kg(100g×20)`(非体积不改绑)、单 size/前置/`4L`/`330ml*24听` 不变。
3. `packages/eval`:加 `多维刺梨柠檬饮 2.1L(100mL×21)` + **品名噪声样本**进脏标题回归 corpus/样本,跑 tier1-only 与 tier1+tier2 基线确认修复且零回退(尤其品名 size 噪声不被误改绑)。
4. 回滚:纯 core 改动,revert 即恢复;无 schema/部署状态。

## 待解决问题

- 无阻塞项。带空格/量词的更复杂前导形态(`2.1 L (100 mL × 21 瓶)`)与「多组单件×数量」留后续;本次覆盖紧凑形态 `2.1L(100mL×21)`/`2.1L 100mL×21` 且仅在自洽门通过时改绑。容差 ±10% 为初值,实测如遇取整差更大的合法标签再调。
