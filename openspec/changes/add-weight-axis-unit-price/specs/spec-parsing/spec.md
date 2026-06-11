## 修改需求

### 需求:字段分层定义（三 spec 共同引用的单一定义）

系统必须采用以下两层字段集的单一定义；`spec-parsing` 的置信度分档、`unit-price-calc` 的可计算性、`parse-api` 的 HTTP 状态判定一律引用本定义，禁止各自另立口径：

- **计算必需集**（仅字段在场性，**不含一致性**）：`totalAmount`（`unit ∈ {ml, L}`（**容量轴**）**或** `unit ∈ {g, kg}`（**重量轴**）且 `value > 0`），或 `unitSize` + `quantity`（可推出 `totalAmount`，沿用其轴单位）；并叠加 `price > 0`。一个输入只落在**一条轴**上（由 size 单位决定）：容量轴产出 `per100ml`、重量轴产出 `per100g`（见 `unit-price-calc`）；两轴**不互转、不互比**（密度换算 `g↔ml` 永不进行）。
- **完整规格集**（仅字段在场性）：`unitSize` + `quantity` + `totalAmount` 三者全在场。
- **一致性 gate**（独立于上述字段集）：当 `unitSize` 与 `quantity` 均在场时，校验总量自洽（容差比较，见 `unit-price-calc`）。`unit-price-calc` 的「可计算」严格定义为：满足**计算必需集** **且** 一致性 gate 未判失败——一致性是计算必需集之上的独立 gate，不并入计算必需集的定义。

#### 场景:仅有总量满足计算必需集

- **当** 仅解析出 `totalAmount = 6000ml`（缺 `unitSize`/`quantity`）、`price = 36`
- **那么** 该输入必须被判为满足「计算必需集」（可产出 per100ml）、但不满足「完整规格集」（缺项无法交叉校验）

#### 场景:重量总量满足计算必需集（重量轴）

- **当** 仅解析出 `totalAmount = {value: 2000, unit: "g"}`（重量轴）、`price = 30`
- **那么** 该输入必须被判为满足「计算必需集」（可产出 `per100g`，**非** `per100ml`），落在重量轴；该轴的可计算性与容量轴同口径

### 需求:从标题与价格解析结构化规格

系统必须从 `RawProduct`（至少含 `title` 与 `price`）解析出结构化的 `ParsedSpec`，至少包含：单件容量 `unitSize`（value + unit）、数量 `quantity`、乘数数组 `multipliers`（本次恒为 `[1]`，标量乘数定义为 `multiplier = product(multipliers)`）、总量 `totalAmount`（value + unit）、包装单位 `packageUnit`（如 `can`/`bottle`）、品类 `category`、置信度 `confidence`。`ParsedSpec` 必须由 Zod schema 定义，TypeScript 类型从该 schema 推导，禁止手写重复 interface。`unitSize.unit` 与 `totalAmount.unit` 的 Zod 枚举必须为 `ml | L | g | kg`（容量 `ml`/`L`，重量 `g`/`kg`）。容量别名归一到规范单位 `ml` 或 `L`（`毫升`/`mL` → `ml`，`升` → `L`），**parsing 阶段不做 `ml`↔`L` 跨档换算**——`L` 保留为 `L`，到 `ml` 的换算只在 `unit-price-calc` 内部进行；重量别名归一到 `g`/`kg`（`斤` 按 `1斤 = 500g` 折算为 `g`），**parsing 阶段亦不做 `g`↔`kg` 跨档换算**——`kg` 保留为 `kg`，到 `g` 的换算只在 `unit-price-calc` 内部进行。**重量单位参与重量轴 `per100g` 计算（见 `unit-price-calc` 的轴分派），不参与 `per100ml`；一个商品由其 size 单位落在容量轴或重量轴之一，两轴不互转、不互比（密度换算 `g↔ml` 永不进行）。** `category` 的 Zod 类型为自由 `string`（缺省 `beverage`），透传时不做白名单校验。可能缺失的字段（`unitSize`/`quantity`/`totalAmount`/`packageUnit`）在 schema 中必须显式允许为空。解析必须先经 tier1 正则，再在 tier1 无法确定时经 tier2 LLM 补充；价格、单位换算、是否可比禁止由 LLM 决定。

#### 场景:tier1 正则解析干净标题

- **当** 输入标题为 `可口可乐 330ml*24听`、价格为 `40`
- **那么** tier1 正则必须直接解析出 `unitSize = {value: 330, unit: "ml"}`、`quantity = 24`、`packageUnit = "can"`、`totalAmount = {value: 7920, unit: "ml"}`，且不调用 LLM

#### 场景:单位别名归一

- **当** 标题中出现 `毫升`、`mL`、`升`、`L` 或 `听`/`罐` 等别名
- **那么** 系统必须把容量别名归一到规范符号（`毫升`/`mL` → `ml`，`升` → `L`，不做 `ml`↔`L` 换算），把包装单位归一到 `ParsedSpec.packageUnit` 的统一枚举（如 `can`）

## ADDED Requirements

### 需求:孤立重量单件视为数量 1

当 tier1 从标题解析出重量 `unitSize`（`unit ∈ {g, kg}`）、但标题中**除 size token 本身外无任何其他数字数量信号**（无 `*`/`×`/`x` 乘号、无 `数字 + 包装单位`、无其他游离数字计数）时，系统**必须**把该商品视为单件：`quantity = 1`、`totalAmount = unitSize`（**沿用 `unitSize` 的值与单位**，`kg` 保留为 `kg`，到 `g` 的换算交 `unit-price-calc` 内部进行——与容量轴「parsing 阶段不做跨档换算」一致），使其满足重量轴「计算必需集」可算出 `per100g`。该推断**必须**确定性进行、不调用 LLM。

本需求是「孤立容量单件视为数量 1」在**重量轴**的对称扩展：判据「除 size 外无其他数字数量信号」、推断标记 warning（「数量按单件推断为 1」）、「数量信号为非正时不推断」等口径与容量轴**完全一致**，仅 size 单位从 `{ml, L}` 换为 `{g, kg}`。**容量单件推断的既有行为不变**（不被本需求影响）。多包装重量品（数量在场，如 `300g*24`、`270g×15`）由既有乘号/包装计数抽取得 `quantity`，`quantity ≠ null`、**根本不进单件推断**——本需求只补「单件重量品」这一缺口。

#### 场景:单件重量品按数量 1 计算

- **当** 输入标题为 `水蜜黄桃 2kg`、价格为 `45`
- **那么** tier1 **必须**解析出 `unitSize = {value: 2, unit: "kg"}`、`quantity = 1`、`totalAmount = {value: 2, unit: "kg"}`（沿用 unitSize 单位、不在 parsing 阶段换算到 g），据此由 `unit-price-calc` 换算后算出 `per100g`，且不调用 LLM，并附「数量按单件推断为 1」warning

#### 场景:多包装重量品不走单件推断

- **当** 输入标题为 `有机玉米汁 300g*24`（乘号 `*24` 在场）
- **那么** 系统**必须**按真实数量解析 `quantity = 24`（`quantity ≠ null`、不进单件推断），`totalAmount = 300g × 24 = 7200g`，落重量轴

#### 场景:容量单件推断不受影响（回归）

- **当** 输入标题为 `MM 弱碱性饮用水 4L`（容量单件）
- **那么** 既有容量单件推断**必须**照旧 `quantity = 1`、`totalAmount = {value: 4, unit: "L"}`、落容量轴算 `per100ml`，行为与本需求引入前逐字节一致

#### 场景:件数游离数字仍保守留 null（已知残留）

- **当** 输入标题为 `MM 精选鲜鸡蛋 1.59kg(30枚)`（`30枚` 的 `枚` 不在包装单位集 `瓶/罐/支/盒/袋/听/提/箱` 内，`30` 作游离数字）
- **那么** `30` 命中数量信号判据 → 系统**不**触发单件推断、`quantity` 保持未定、`per100g = null`（与容量轴 `hasQuantitySignal` 残留同口径：游离数字难与数量区分，保守不算，本期不修）
