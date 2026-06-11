## 修改需求

### 需求:每 100ml 单价的可计算条件与统一不可计算终态

系统必须先按 `totalAmount`（缺则 `unitSize`）的单位判定**轴**：`unit ∈ {ml, L}` → **容量轴**（产出 `per100ml`）、`unit ∈ {g, kg}` → **重量轴**（产出 `per100g`）、其它/缺失 → 无轴。再判定「是否可计算」：判据 = 满足 `spec-parsing` 「字段分层定义」中的**计算必需集**（`totalAmount.unit` 落在某一轴的单位集内、换算到该轴基准单位后的总量 `> 0` 且 `price > 0`，或可由 `unitSize`+`quantity` 推出**同轴** `totalAmount`）**且**通过一致性 gate（见下「规格一致性校验」需求；一致性是计算必需集之上的独立 gate，不并入计算必需集本身的定义）。仅当两者都满足时，才在**该轴对应字段**产出非空单价（容量轴 `per100ml`、重量轴 `per100g`），**另一轴字段恒为 `null`**——一个商品至多一条轴可算（`per100ml` 与 `per100g` **恰一非空**，或两者皆 `null`），两轴**不互转、不互比**（密度换算 `g↔ml` 永不进行）。任一不满足（无轴/未知单位、总量缺失/≤0、price≤0、规格不一致）时，系统必须走**统一的不可计算终态**：`per100ml = per100g = null`、不产出 `formula`、产出对应 `warning`、置信度降为 `≤ 0.5`，且结果中禁止出现 `NaN`/`Infinity`。`UnitPrice` 的 Zod schema 必须显式允许 `per100ml`、`per100g` 与 `formula` 为 `null`。本次不引入 `comparable`/`excludedReason` 字段（属非目标）——所有不可计算情形仅通过 `单价 = null + warning + 低置信` 表达。

#### 场景:重量单位走重量轴算 per100g

- **当** `totalAmount = {value: 2000, unit: "g"}`（重量轴）、`price = 30`
- **那么** 系统必须在重量轴算出 `per100g = 30 / 2000 * 100 = 1.5`、产出 `formula`、`per100ml = null`；**禁止**因「非容量单位」走不可计算终态

#### 场景:总量为零或缺失走不可计算终态

- **当** `totalMl`（或重量轴 `totalG`）为 `null` 或 `0`
- **那么** 系统必须返回 `per100ml = per100g = null`、无 `formula`、附 warning，且不产生 `NaN`/`Infinity`

#### 场景:价格非正走不可计算终态

- **当** `price` 为 `0` 或负数
- **那么** 系统必须返回 `per100ml = per100g = null` 并附 warning，禁止返回 `0`/负单价作为有效结果

#### 场景:无轴（无 size / 未知单位）走不可计算终态

- **当** 既无 `totalAmount` 也无 `unitSize`（或单位不在 `{ml, L, g, kg}` 内）
- **那么** 系统必须返回 `per100ml = per100g = null`、无 `formula`、附 warning、置信度 `≤ 0.5`

### 需求:确定性计算与 canonical formula

当可计算时，系统必须以纯函数（`packages/core`，无 IO）按所属轴计算单价，并产出可回放的 canonical `formula` 留痕字符串。**容量轴**：`per100ml = price / totalMl * 100`；**重量轴**：`per100g = price / totalG * 100`（`totalG` 为总量换算到 `g` 的值，`1kg = 1000g`）。formula 必须采用换算到该轴基准单位（容量 `ml`、重量 `g`）后的数值：当 `unitSize`、`quantity`、`multiplier` 均已知时用展开式 `<price> / (<unitSizeBase> * <quantity> * <multiplier>) * 100`（`unitSizeBase` 为单件 size 换算到该轴基准单位的值；`multiplier = product(multipliers)`，本次恒为 `1`）；当仅有 `totalAmount`（`unitSize`/`quantity` 缺失）时用收缩式 `<price> / <totalBase> * 100`。响应中该留痕的字段路径为 `unitPrice.formula`。禁止由 LLM 执行任何价格计算。

#### 场景:ml 单位展开式留痕

- **当** 输入价格 `40`、`unitSize = 330ml`、`quantity = 24`、`multiplier = 1`
- **那么** 系统必须返回 `per100ml ≈ 0.505` 与 `formula = "40 / (330 * 24 * 1) * 100"`

#### 场景:L 单位先换算再用 ml 值留痕

- **当** 输入价格 `48`、`unitSize = 1L`、`quantity = 6`、`multiplier = 1`
- **那么** 系统必须先把 `unitSize` 换算到 `1000ml`（`1L = 1000ml`），再返回 `formula = "48 / (1000 * 6 * 1) * 100"`，禁止在 formula 中使用未换算的字面 `1`

#### 场景:g 单位展开式留痕（重量轴）

- **当** 输入价格 `60`、`unitSize = 300g`、`quantity = 24`、`multiplier = 1`
- **那么** 系统必须返回 `per100g = 60 / (300 * 24 * 1) * 100 ≈ 0.833` 与 `formula = "60 / (300 * 24 * 1) * 100"`、`per100ml = null`

#### 场景:kg 单位先换算再用 g 值留痕（重量轴）

- **当** 输入价格 `45`、`unitSize = 2kg`、`quantity = 1`、`multiplier = 1`
- **那么** 系统必须先把 `unitSize` 换算到 `2000g`（`1kg = 1000g`），再返回 `per100g = 45 / 2000 * 100 = 2.25` 与 `formula = "45 / (2000 * 1 * 1) * 100"`，禁止在 formula 中使用未换算的字面 `2`

### 需求:规格一致性校验（容差 + 缺项第三态）

当 `unitSize` 与 `quantity` 均在场时，系统必须做容差比较 `abs(totalBase − unitSizeBase × quantity × multiplier) ≤ 1e-6 × max(totalBase, unitSizeBase × quantity × multiplier)`（**先把两侧换算到该商品所属轴的基准单位**——容量轴用 `ml`、重量轴用 `g`，且 `unitSize` 与 `totalAmount` **必须同轴**；以两侧较大值为基准，避免某一侧被高估时阈值随之放大而漏判）。判为「不一致」时，`totalBase` 不可信，系统必须走不可计算终态（`per100ml = per100g = null` + warning + 低置信），禁止用不可信的总量产出单价。当 `unitSize` 或 `quantity` 缺失（无法构造等式）时，系统必须跳过等式校验（此「缺项」第三态须与「不一致」区分）：若 `totalAmount` 在场且满足可计算条件，仍可产出该轴单价（用收缩式 formula），但置信度不得为高档（因无法交叉校验），并附「规格不完整，未校验自洽性」warning。**一致性 gate 与轴无关地适用于两轴**——重量轴满规格自洽商品与容量轴同样判「一致」、可上高档，禁止因「换算函数从 `toMl` 改为 `toGrams`」而把重量满规格品错降为「缺项/跳过」档。当 `unitSize` 与 `totalAmount` **跨轴**（如 `unitSize` 容量、`totalAmount` 重量）时，构造不出同轴等式，必须按「跳过/缺项」第三态处理（不误判为「不一致」）。

#### 场景:规格自洽时无警告

- **当** `unitSize = 330ml`、`quantity = 24`、`multiplier = 1`、`totalAmount = 7920ml`
- **那么** 一致性校验必须在容差内通过且不产生 warning

#### 场景:规格不一致时抑制单价

- **当** `unitSize = 330ml`、`quantity = 24`、`multiplier = 1`、但 `totalAmount = 3960ml`
- **那么** 系统必须判为不一致，走不可计算终态（`per100ml = null` + warning + 低置信），禁止用 3960ml 产出单价

#### 场景:小数容量浮点容差

- **当** `unitSize = 1.25L`、`quantity = 6`（换算后 `= 7500ml`）、`totalAmount = 7500ml`
- **那么** 一致性校验必须在容差内判为自洽，禁止因浮点抖动误报不一致

#### 场景:规格缺项时用收缩式且不给高置信

- **当** `unitSize` 或 `quantity` 缺失，但 `totalAmount = 6000ml`、`price = 36`
- **那么** 系统必须跳过等式校验，用收缩式 `formula = "36 / 6000 * 100"` 产出 `per100ml`，置信度不得为高档（`< 0.9`），并附「规格不完整，未校验自洽性」warning

#### 场景:重量轴满规格自洽判一致且可上高档（重量轴）

- **当** `unitSize = 300g`、`quantity = 24`、`multiplier = 1`、`totalAmount = 7200g`（重量轴）
- **那么** 一致性校验必须**先换算到 `g`** 在容差内判为自洽（`7200 == 300 × 24 × 1`）、不产生不一致 warning，且该商品的置信度可按结果质量上高档（与容量轴同口径，**禁止**因重量轴而强制降档）

#### 场景:重量轴规格不一致时抑制单价（重量轴）

- **当** `unitSize = 300g`、`quantity = 24`、`multiplier = 1`、但 `totalAmount = 3600g`（重量轴）
- **那么** 系统必须判为不一致，走不可计算终态（`per100g = null` + warning + 低置信），禁止用 3600g 产出 `per100g`
