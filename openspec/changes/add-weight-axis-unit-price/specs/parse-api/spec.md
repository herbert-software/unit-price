## 修改需求

### 需求:POST /parse 接口

`apps/api` 必须提供 `POST /parse` 接口，接收 `{ title, price, categoryHint? }`，编排 tier1 正则解析 → tier2 LLM 补充 → tier3 确定性计算与校验，返回结构化结果。请求体与响应体必须由 Zod schema 校验：`title` 必须为非空字符串、`price` 必须为数字。响应必须包含 `spec`（ParsedSpec）、`unitPrice`（含 `per100ml` 可为 `null`、`per100g` 可为 `null`、`formula` 可为 `null`）、顶层 `confidence`、以及顶层 `warnings`（结构为 `string[]`，各阶段——解析降级 / 不可计算 / 一致性——的 warning 一律汇入此单一数组）。顶层 `confidence` 为**单一权威值**，等于 `spec-parsing` 分档定义对**最终结果**判出的那一档（无 `min` 合并、无第二根置信度轴）。

HTTP 状态语义必须明确且与各 spec 一致（「计算必需集」引用 `spec-parsing` 字段分层定义）。关键区分：**「信息不足、无法判定能否计算」才是服务端错误（5xx）；「已确定不可计算」是确定结论（200 + `per100ml = per100g = null`）**：
- **`4xx`**：请求体不合法（缺/空 `title`、缺 `price` 或 `price` 非数字）——不进入解析链路。
- **`5xx`（信息不足）**：当且仅当 tier2 发生 transport 失败**且** tier1 单独**完全未抽到任何规格字段**（`unitSize`/`quantity`/`totalAmount` 全空，如纯品名），即连「能否计算」都无法判定。注意：只要 tier1 抽到任一规格字段（哪怕是裸 `unitSize=2kg`——重量轴算出 `per100g`，或 `unitSize=1.59kg` + 游离件数 `30枚` 留确定 `null` 这类）就能给出**确定结论**（可算的数或确定的 `null`），属 `200`，不报 5xx。
- **`5xx`（配置错误）**：运行期配置错误（如 `OPENROUTER_API_KEY` 缺失而未在启动期 fail-fast）必须返回明确的 `5xx`，且错误体须与「信息不足 5xx」**可区分**（如不同 error code）。推荐 key 缺失在启动期 fail-fast，使 `/parse` 运行期不暴露此分支。
- **`200`**：其余全部情形。包括——可计算结果（容量轴 `per100ml` 或重量轴 `per100g`）；**已确定不可计算**（无 size / 未知单位、件数游离数字残留、`price ≤ 0`、规格不一致、tier2 成功但字段仍空等，给出 `per100ml = per100g = null` 的确定结论）；缺项收缩式；低置信度。即只要能给出**确定结论**（可算的数或确定的 null），一律 `200`，绝不报 5xx。

#### 场景:解析单个饮料商品

- **当** 客户端 POST `{ "title": "可口可乐 330ml*24听", "price": 40 }`
- **那么** 接口必须返回 `200`、`spec`（含 `totalAmount = 7920ml`）、`unitPrice.per100ml ≈ 0.505`、`unitPrice.formula = "40 / (330 * 24 * 1) * 100"`、`confidence ≥ 0.9`

#### 场景:请求体不合法时拒绝

- **当** 请求缺少 `price`、`price` 非数字、或 `title` 缺失/为空字符串
- **那么** 接口必须返回 `4xx` 错误并说明校验失败，禁止进入解析链路

#### 场景:价格非正时如实降级

- **当** 请求 `price` 为 `0` 或负数（合法 number 但语义无效）
- **那么** 接口必须返回 `200`、`unitPrice.per100ml = null`、低 `confidence` 与 warning，禁止返回 `0`/负单价作为有效结果

#### 场景:低置信度结果如实返回

- **当** 解析链路无法确定规格或一致性校验失败
- **那么** 接口必须返回 `200`，如实给出低 `confidence`、`unitPrice.per100ml = null`（如适用）与对应 `warnings`，禁止伪造高置信度或编造缺失字段

#### 场景:tier2 失败且 tier1 提取不到任何规格信息时报 5xx

- **当** 输入纯品名无任何规格（如 `农夫山泉`、`price = 5`），`SpecParserLLM` 又 transport 失败——tier1 完全未抽到任何规格字段（`unitSize`/`quantity`/`totalAmount` 全空），连能否计算都判不了
- **那么** 接口必须返回明确的 `5xx` 错误状态，禁止返回伪造的成功结果

#### 场景:tier1 抽到重量 size 时给确定结论返回 200（重量轴可算）

- **当** tier1 提取出 `unitSize = 2kg`（单件重量品、推断 `quantity = 1`、`totalAmount = 2kg`），即便 `SpecParserLLM` 同时 transport 失败
- **那么** 接口必须返回 `200`、重量轴算出 `unitPrice.per100g`（非空，如价 `45` → `per100g = 2.25`）、`per100ml = null` + formula（这是确定结论、非服务故障），禁止报成 `5xx`

#### 场景:tier1 抽到字段但确定不可计算时返回 200 而非 5xx

- **当** tier1 提取出 `unitSize = 1.59kg`（如 `鲜鸡蛋 1.59kg(30枚)`，游离件数 `30` 抑制单件推断 → `quantity` 未定、无总量 → **确定不可计算**），即便 `SpecParserLLM` 同时 transport 失败
- **那么** 接口必须返回 `200`、`unitPrice.per100ml = per100g = null` + warning（这是确定结论，非服务故障；tier1 已抽到 `unitSize` 字段，故能判定「能否计算」），禁止报成 `5xx`

#### 场景:tier2 失败但 tier1 有部分规格时降级 200

- **当** tier1 已抽到部分规格但**未独立满足「计算必需集」**（有 shape，如有 `unitSize` 无 `quantity`，故会去调 tier2 补缺），而 `SpecParserLLM` transport 失败
- **那么** 接口必须返回 `200`，`confidence` 按 `spec-parsing` 分档由最终结果质量决定（通常因仍缺字段而落中/低档），并附「未经 LLM 复核」warning，不报 5xx——档位只看最终结果质量，不因 tier2 缺席额外下调

> 注：当 tier1 已独立满足「计算必需集」时，实现直接跳过 tier2（干净标题不触发 LLM），不存在「tier2 失败」一说，该结果按其最终质量分档（完整且自洽→高档），不带「未经 LLM 复核」warning。重量轴可算的干净标题（如 `2kg`）同样在 tier1 即确定、跳过 tier2。

#### 场景:tier2 成功但字段仍缺失时返回 200

- **当** tier2 成功返回（非 transport 失败）但合并后仍未达「完整规格集」
- **那么** 接口必须返回 `200`（缺项收缩式或低置信）+ warning，禁止报成 `5xx`
