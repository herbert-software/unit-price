## 1. Monorepo 骨架

- [x] 1.1 初始化 `pnpm-workspace.yaml`，纳入 `packages/*` 与 `apps/*`
- [x] 1.2 根 `tsconfig.base.json` + TS project references；根 `package.json` 配 `zod`、`vitest`、TS、统一 build/test/lint 脚本
- [x] 1.3 创建 `packages/core` 与 `apps/api` 两个 workspace 的 `package.json` 与 `tsconfig.json`（core 被 api 引用）
- [x] 1.4 验证：`pnpm install` 通过，`pnpm -r build` 与 `pnpm -r test`（空测试）可跑

## 2. packages/core — Zod schema 与类型

- [x] 2.1 用 Zod 定义 `RawProduct`（title 非空, price 数字, categoryHint?）、`ParsedSpec`（unitSize?, quantity?, multipliers=[1], totalAmount?, packageUnit?, category, confidence∈[0,1]；unit 枚举 `ml|L|g|kg`）、`UnitPrice`（per100ml 可 null, formula 可 null）、响应顶层 `warnings: string[]`；可缺失字段显式 nullable/optional；types 从 schema 推导。**本次不含 comparable/excludedReason（非目标）**
- [x] 2.2 定义单位换算表与别名归一（ml/mL/毫升/L/升 → ml；斤 → g 按 1斤=500g；听/罐 → can 落入 packageUnit），`1L=1000ml`、`1kg=1000g`；重量单位仅识别、不进入 per100ml
- [x] 2.3 实现「字段分层」判定（计算必需集 / 完整规格集，单一定义），供 tier3 可计算性、置信度分档、API HTTP 状态共同引用

## 3. packages/core — tier1 解析与 tier3 计算（纯函数 + 单测）

- [x] 3.1 实现 tier1 正则解析器：抽取 `数字+单位 × 数量`，输出候选 `ParsedSpec`（含 packageUnit）+ 命中证据；干净标题不触发 LLM；category 由 categoryHint 透传、缺省 `beverage`、不由 LLM 决定
- [x] 3.2 实现 tier3 计算器：计算前先经换算表把 totalAmount 与 unitSize 归一到 ml；`per100ml = price / totalMl * 100`；产出 canonical `formula`：unitSize/quantity/multiplier 均知用展开式 `<price> / (<unitSizeMl> * <quantity> * <multiplier>) * 100`（multiplier=product(multipliers)），仅有 total 时用收缩式 `<price> / <totalMl> * 100`
- [x] 3.3 实现统一「不可计算」终态：unit∉{ml,L}（重量等）/ totalMl 缺失或≤0 / price≤0 / 一致性判为不一致 → per100ml=null、无 formula、warning、低置信，禁止 NaN/Infinity
- [x] 3.4 实现一致性校验钩子：容差 `abs(totalMl − unitSizeMl×quantity×multiplier) ≤ 1e-6×max(totalMl, unitSizeMl×quantity×multiplier)`，不一致→走不可计算终态；unitSize/quantity 缺项→跳过等式、用收缩式计算但置信不为高档+「规格不完整」warning（区分于不一致）
- [x] 3.5 单测（vitest）脏标题样本集断言 3.1–3.4：单位别名、`*N` 数量、ml 展开式 formula 与每100ml 数值、**L 单位换算后 formula、除零/null total、price≤0、重量单位不可计算、不一致抑制单价、小数容量浮点容差、缺项第三态收缩式、tier1 高置信≥0.9、降级中档置信**

## 4. apps/api — SpecParserLLM port（tier2）

- [x] 4.1 定义 `SpecParserLLM` 领域接口：`parse(RawProduct) => Promise<ParsedSpec | 失败信号>`（仅领域类型，不暴露 provider SDK；transport 失败以异常或 error 结果返回，不伪造 spec）
- [x] 4.2 用 Vercel AI SDK `generateObject` + `@ai-sdk/openai-compatible` provider 实现该接口，`baseURL` 指向 OpenRouter，`OPENROUTER_API_KEY` 读环境变量（缺失走启动期校验、与运行期 transport 失败可区分），model 取配置常量 `deepseek/deepseek-chat`
- [x] 4.3 LLM 返回结果用 `ParsedSpec` Zod 校验，不合则拒绝并把 confidence 置 ≤0.5（不静默采用）
- [x] 4.4 tier1 部分命中时仅补缺失字段（tier1 非空字段权威，忽略 LLM 对已填字段的值）并对合并结果 Zod 重校验；合并后仍缺必填按缺失语义处理
- [x] 4.5 留好升级位：接口/实现预留「校验失败 → 换强模型重试」的扩展点，本次只接单档

## 5. apps/api — POST /parse 编排

- [x] 5.1 起 Hono 应用骨架与 `POST /parse` 路由
- [x] 5.2 请求体/响应体用 Zod 校验；非法请求（缺/空 title、缺 price、price 非数字）返回 4xx 并说明
- [x] 5.3 编排链路：tier1（core）→ tier1 不足则 tier2（SpecParserLLM）→ tier3 计算+校验（core）→ 组装响应（spec / unitPrice.per100ml 可空 / unitPrice.formula / confidence / warnings）
- [x] 5.4 HTTP 状态语义：tier2 成功（含字段仍缺）/低置信/确定不可计算/缺项收缩式 → 200；非法请求 → 4xx；**当且仅当 tier2 transport 失败且 tier1 完全未抽到任何规格字段（`unitSize`/`quantity`/`totalAmount` 全空）→ 5xx**；运行期配置错误（如 key 缺失未在启动期拦截）→ 与「信息不足 5xx」可区分的明确 5xx；顶层 confidence 为单一权威值——由 spec-parsing 分档定义对最终合并结果判出的那一档决定（不取 min、无第二轴）；warnings 汇入单一 `string[]`；不伪造高置信

## 6. 端到端验证

- [x] 6.1 `pnpm --filter core test` 全绿（含 3.5 全部失败路径用例）
- [x] 6.2 本地起 `apps/api`，对 `{ "title": "可口可乐 330ml*24听", "price": 40 }` 调 `POST /parse`，确认 200 + `unitPrice.per100ml ≈ 0.505` + `unitPrice.formula = "40 / (330 * 24 * 1) * 100"` + `confidence ≥ 0.9`
- [x] 6.3 对缺 price 或空 title 的请求确认 4xx；对 `price: 0` 确认 200 + per100ml=null + warning
- [x] 6.4 更新 `TODO.md` 顶部「当前焦点」指向本 change，并勾选 Phase 1 已完成的 skeleton 项
