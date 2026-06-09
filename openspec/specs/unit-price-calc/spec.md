# unit-price-calc

## 目的

以确定性纯函数从结构化规格计算每 100ml 单价，产出可回放的 canonical formula 留痕，并统一处理不可计算终态与规格一致性校验。本节为待定占位，详见各需求。

## 需求

### 需求:每 100ml 单价的可计算条件与统一不可计算终态

系统必须先判定「是否可计算每 100ml」。判据 = 满足 `spec-parsing` 「字段分层定义」中的**计算必需集**（`totalAmount.unit ∈ {ml, L}` 且 `totalMl > 0` 且 `price > 0`，或可由 `unitSize`+`quantity` 推出 `totalAmount`）**且**通过一致性 gate（见下「规格一致性校验」需求；一致性是计算必需集之上的独立 gate，不并入计算必需集本身的定义）。仅当两者都满足时才产出非空 `per100ml`。任一不满足（重量等非容量单位、总量缺失/≤0、price≤0、规格不一致）时，系统必须走**统一的不可计算终态**：`per100ml = null`、不产出 `formula`、产出对应 `warning`、置信度降为 `≤ 0.5`，且结果中禁止出现 `NaN`/`Infinity`。`UnitPrice` 的 Zod schema 必须显式允许 `per100ml` 与 `formula` 为 `null`。本次不引入 `comparable`/`excludedReason` 字段（属非目标）——所有不可计算情形仅通过 `per100ml=null + warning + 低置信` 表达。

#### 场景:非容量单位走不可计算终态

- **当** `totalAmount = {value: 2, unit: "kg"}`（重量单位，per100ml 对其无物理意义）
- **那么** 系统必须返回 `per100ml = null`、无 `formula`、附 warning（如「本次仅支持容量单位的饮料」）、置信度 `≤ 0.5`

#### 场景:总量为零或缺失走不可计算终态

- **当** `totalMl` 为 `null` 或 `0`
- **那么** 系统必须返回 `per100ml = null`、无 `formula`、附 warning，且不产生 `NaN`/`Infinity`

#### 场景:价格非正走不可计算终态

- **当** `price` 为 `0` 或负数
- **那么** 系统必须返回 `per100ml = null` 并附 warning，禁止返回 `0`/负单价作为有效结果

### 需求:确定性计算与 canonical formula

当可计算时，系统必须以纯函数（`packages/core`，无 IO）计算 `per100ml = price / totalMl * 100`，并产出可回放的 canonical `formula` 留痕字符串。formula 必须采用换算到 ml 后的数值：当 `unitSize`、`quantity`、`multiplier` 均已知时用展开式 `<price> / (<unitSizeMl> * <quantity> * <multiplier>) * 100`（`unitSizeMl` 为单件容量换算到 ml 的值；`multiplier = product(multipliers)`，本次恒为 `1`）；当仅有 `totalAmount`（`unitSize`/`quantity` 缺失）时用收缩式 `<price> / <totalMl> * 100`。响应中该留痕的字段路径为 `unitPrice.formula`。禁止由 LLM 执行任何价格计算。

#### 场景:ml 单位展开式留痕

- **当** 输入价格 `40`、`unitSize = 330ml`、`quantity = 24`、`multiplier = 1`
- **那么** 系统必须返回 `per100ml ≈ 0.505` 与 `formula = "40 / (330 * 24 * 1) * 100"`

#### 场景:L 单位先换算再用 ml 值留痕

- **当** 输入价格 `48`、`unitSize = 1L`、`quantity = 6`、`multiplier = 1`
- **那么** 系统必须先把 `unitSize` 换算到 `1000ml`（`1L = 1000ml`），再返回 `formula = "48 / (1000 * 6 * 1) * 100"`，禁止在 formula 中使用未换算的字面 `1`

### 需求:规格一致性校验（容差 + 缺项第三态）

当 `unitSize` 与 `quantity` 均在场时，系统必须做容差比较 `abs(totalMl − unitSizeMl × quantity × multiplier) ≤ 1e-6 × max(totalMl, unitSizeMl × quantity × multiplier)`（换算到同一单位后；以两侧较大值为基准，避免某一侧被高估时阈值随之放大而漏判）。判为「不一致」时，`totalMl` 不可信，系统必须走不可计算终态（`per100ml = null` + warning + 低置信），禁止用不可信的总量产出单价。当 `unitSize` 或 `quantity` 缺失（无法构造等式）时，系统必须跳过等式校验（此「缺项」第三态须与「不一致」区分）：若 `totalAmount` 在场且满足可计算条件，仍可产出 `per100ml`（用收缩式 formula），但置信度不得为高档（因无法交叉校验），并附「规格不完整，未校验自洽性」warning。

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
