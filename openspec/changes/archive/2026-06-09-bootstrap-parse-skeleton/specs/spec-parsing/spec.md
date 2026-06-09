## 新增需求

### 需求:从标题与价格解析结构化规格

系统必须从 `RawProduct`（至少含 `title` 与 `price`）解析出结构化的 `ParsedSpec`，至少包含：单件容量 `unitSize`（value + unit）、数量 `quantity`、乘数数组 `multipliers`（本次恒为 `[1]`，标量乘数定义为 `multiplier = product(multipliers)`）、总量 `totalAmount`（value + unit）、包装单位 `packageUnit`（如 `can`/`bottle`）、品类 `category`、置信度 `confidence`。`ParsedSpec` 必须由 Zod schema 定义，TypeScript 类型从该 schema 推导，禁止手写重复 interface。`unitSize.unit` 与 `totalAmount.unit` 的 Zod 枚举必须为 `ml | L | g | kg`（容量 `ml`/`L`，重量 `g`/`kg`）。容量别名归一到规范单位 `ml` 或 `L`（`毫升`/`mL` → `ml`，`升` → `L`），**parsing 阶段不做 `ml`↔`L` 跨档换算**——`L` 保留为 `L`，到 `ml` 的换算只在 `unit-price-calc` 内部进行；重量别名归一到 `g`/`kg`（`斤` 按 `1斤 = 500g` 折算为 `g`），重量单位本次仅识别、不参与 per100ml 计算（一律走 `unit-price-calc` 的不可计算终态）。`category` 的 Zod 类型为自由 `string`（缺省 `beverage`），透传时不做白名单校验。可能缺失的字段（`unitSize`/`quantity`/`totalAmount`/`packageUnit`）在 schema 中必须显式允许为空。解析必须先经 tier1 正则，再在 tier1 无法确定时经 tier2 LLM 补充；价格、单位换算、是否可比禁止由 LLM 决定。

#### 场景:tier1 正则解析干净标题

- **当** 输入标题为 `可口可乐 330ml*24听`、价格为 `40`
- **那么** tier1 正则必须直接解析出 `unitSize = {value: 330, unit: "ml"}`、`quantity = 24`、`packageUnit = "can"`、`totalAmount = {value: 7920, unit: "ml"}`，且不调用 LLM

#### 场景:单位别名归一

- **当** 标题中出现 `毫升`、`mL`、`升`、`L` 或 `听`/`罐` 等别名
- **那么** 系统必须把容量别名归一到规范符号（`毫升`/`mL` → `ml`，`升` → `L`，不做 `ml`↔`L` 换算），把包装单位归一到 `ParsedSpec.packageUnit` 的统一枚举（如 `can`）

### 需求:字段分层定义（三 spec 共同引用的单一定义）

系统必须采用以下两层字段集的单一定义；`spec-parsing` 的置信度分档、`unit-price-calc` 的可计算性、`parse-api` 的 HTTP 状态判定一律引用本定义，禁止各自另立口径：

- **计算必需集**（仅字段在场性，**不含一致性**）：`totalAmount`（`unit ∈ {ml, L}` 且 `value > 0`），或 `unitSize` + `quantity`（可推出 `totalAmount`）；并叠加 `price > 0`。
- **完整规格集**（仅字段在场性）：`unitSize` + `quantity` + `totalAmount` 三者全在场。
- **一致性 gate**（独立于上述字段集）：当 `unitSize` 与 `quantity` 均在场时，校验总量自洽（容差比较，见 `unit-price-calc`）。`unit-price-calc` 的「可计算」严格定义为：满足**计算必需集** **且** 一致性 gate 未判失败——一致性是计算必需集之上的独立 gate，不并入计算必需集的定义。

#### 场景:仅有总量满足计算必需集

- **当** 仅解析出 `totalAmount = 6000ml`（缺 `unitSize`/`quantity`）、`price = 36`
- **那么** 该输入必须被判为满足「计算必需集」（可产出 per100ml）、但不满足「完整规格集」（缺项无法交叉校验）

### 需求:品类来源确定且不由 LLM 决定

`ParsedSpec.category` 必须由确定性程序赋值，禁止由 LLM 自由判定（品类是可比判断的前置，属红线）。本次取值规则：当请求带 `categoryHint` 时透传为 `category`；缺省时恒为常量 `beverage`（本穿刺线只服务饮料）。本次 `category` 仅为信息性字段、不作为计算 guard——是否产出 per100ml 的操作性判据是 `unit-price-calc` 的「可计算条件」（容量单位限制），而非 `category` 值；因此 `categoryHint` 为非饮料时不会被误算（非容量单位会走不可计算终态）。

#### 场景:category 缺省为 beverage

- **当** 请求未提供 `categoryHint`
- **那么** `ParsedSpec.category` 必须为 `beverage`，且该值不得来自 LLM 输出

#### 场景:categoryHint 透传为 category

- **当** 请求提供 `categoryHint = "beverage"`
- **那么** `ParsedSpec.category` 必须透传为 `beverage`，仍不得来自 LLM 输出

### 需求:tier1 部分命中时的合并语义与终态

当 tier1 仅解析出部分字段（如有 `unitSize` 无 `quantity`）时，系统必须调用 `SpecParserLLM` 仅补充**缺失**字段，并对合并后的结果用 `ParsedSpec` 的 Zod schema 重新校验。合并冲突规则：tier1 已解析出的非空字段为权威，LLM 对这些已填字段返回的值必须被忽略（LLM 只能填 tier1 留空的字段）。若合并后仍未达到「计算必需集」，按 `unit-price-calc` 的不可计算终态处理；达到「计算必需集」但非「完整规格集」时，按缺项第三态处理（收缩式计算 + 中档置信）。

#### 场景:tier1 部分命中由 tier2 仅补缺

- **当** tier1 解出 `unitSize = 330ml` 但未解出 `quantity`
- **那么** 系统必须调用 LLM 仅补 `quantity`，合并后经 Zod 重校验再采用；LLM 若同时返回了不同的 `unitSize`，该值必须被忽略（tier1 权威）

### 需求:SpecParserLLM 领域端口

系统必须提供 `SpecParserLLM` 领域端口：输入 `RawProduct`，输出经 Zod 校验的 `ParsedSpec` 或可区分的失败信号。端口实现底层必须经 Vercel AI SDK 的 OpenAI-compatible provider 接入 OpenRouter，使用的模型必须由配置（model 字符串 + `OPENROUTER_API_KEY`）决定，禁止硬编码到调用点。tier2 LLM 解析必须只存在于 `apps/api`，禁止进入 `packages/core`。当底层调用发生 transport 失败（超时 / 网络错 / 5xx / 空响应）时，端口必须以可区分的失败信号返回（抛异常或返回显式 error 结果），禁止伪造或返回编造的 `ParsedSpec`。`OPENROUTER_API_KEY` 缺失属**配置错误**，必须在启动期校验暴露、或以与运行期 transport 失败**可区分**的错误返回，禁止与「重试可能恢复」的瞬态失败混为一类。当 LLM 返回结构合法但字段全空的对象时，该对象按解析结果进入下游分层判定（多半落入不可计算终态），不视为 transport 失败。端口的接口形状必须预留「模型档位 / 升级」扩展位（如可选的档位参数），使后续「校验失败 → 换强模型重试」无需改签名即可接入；本次仅实现单档，传与不传该参数均须合法。

#### 场景:模型经配置切换

- **当** 配置中的廉价档 model 字符串从 `deepseek/deepseek-chat` 改为另一个 OpenRouter 模型
- **那么** 解析链路必须无需改动业务代码即切换到新模型

#### 场景:transport 失败返回可区分信号

- **当** LLM 调用超时或返回空响应
- **那么** 端口必须以失败信号返回（异常或 error 结果），禁止把它当作一次成功解析、禁止编造 `ParsedSpec` 字段

#### 场景:升级扩展位形状预留

- **当** 调用方调用端口时传入或不传入可选的「模型档位」参数
- **那么** 两种调用都必须合法（本次仅实现单档行为），接口签名无需为后续升级而改动

#### 场景:端口对业务暴露领域语言

- **当** `apps/api` 的编排代码调用解析能力
- **那么** 它必须只依赖 `SpecParserLLM` 的领域接口（进 `RawProduct`、出 `ParsedSpec`），禁止直接依赖具体 provider SDK 类型

### 需求:置信度取值域与分档阈值

`confidence` 必须为 `[0, 1]` 区间的数值。分档**只由最终结果质量决定，与证据来源（tier1/tier2）、与 tier2 是否运行或复核无关**——证据来源差异只影响是否附 warning，不影响档位。本次采用最简可判分档（档内具体打分留后续 change）。各档区间连续无重叠、互斥（端点 `0.5` 归低档、`0.9` 归高档），任一最终结果恰好命中一档：

- **高档 `≥ 0.9`**：满足「完整规格集」**且**一致性 gate 通过。
- **中档 `(0.5, 0.9)`**（开区间）：满足「计算必需集」但**不**满足高档条件（典型为缺项收缩式——缺 `unitSize`/`quantity`、未能交叉校验自洽性）。
- **低档 `≤ 0.5`**：**已能给出确定结论**但不满足「计算必需集」——确定不可计算（非容量单位、`price ≤ 0`、tier2 成功但字段仍空等）、规格不一致、或 LLM 被拒绝。注意区分：当 tier1 **完全未抽到任何规格字段**（`unitSize`/`quantity`/`totalAmount` 全空）**且** tier2 transport 失败、连「能否计算」都判不了时，属「信息不足」——**不进入 confidence 分档**，按 `parse-api` 走 5xx（错误响应无 `confidence`）。

顶层 `confidence` 为**单一权威值**，由对**最终结果**（合并后的 spec + 计算与一致性结论）按上述分档判出的唯一一档决定——不存在第二根独立的「计算档」轴、也无 `min` 合并。`ParsedSpec` 内部可携带解析阶段的中间置信，但响应顶层 `confidence` 以最终分档为准。tier2 不可用（transport 失败）时，若 tier1 独立结果已落某档，则维持该档并附「未经 LLM 复核」降级 warning——**不因 tier2 缺席而下调档位**。

#### 场景:完整规格集为高档（与字段来源无关）

- **当** 结果满足「完整规格集」且一致性通过——无论由 tier1 独立解出（如 `可口可乐 330ml*24听`，此时直接跳过 tier2），还是 tier2 补全后达成
- **那么** `confidence` 必须 `≥ 0.9`（档位只看最终结果质量，与字段来自 tier1 还是 tier2 无关）

#### 场景:计算必需集但非完整规格集为中档

- **当** 结果满足「计算必需集」但缺 `unitSize`/`quantity`（仅有 `totalAmount`，走收缩式、未校验自洽性）
- **那么** `confidence` 必须落在 `(0.5, 0.9)` 并附「规格不完整」warning

#### 场景:OPENROUTER_API_KEY 缺失为可区分配置错误

- **当** `OPENROUTER_API_KEY` 未配置
- **那么** 系统必须以与瞬态 transport 失败**可区分**的方式暴露（启动期 fail-fast 或显式 config-error），禁止退化为「重试可能恢复」的瞬态语义

#### 场景:LLM 输出不合 schema 时拒绝并降低档

- **当** `SpecParserLLM` 返回的对象无法通过 `ParsedSpec` 的 Zod 校验
- **那么** 系统必须拒绝该结果（不得静默采用），并使最终 `confidence` 落入低档 `≤ 0.5`
