## 上下文

这是项目的第一条变更，承担双重职责：(1) 落地 TypeScript monorepo 骨架；(2) 用一条最窄的端到端「walking skeleton」压实核心架构缝。架构 SOT 见 `docs/architecture.md`。决策已在探索阶段定稿，本文记录这些决策的理由，供实现与后续加宽参考。

约束：`packages/core` 纯函数无 IO、双端可用；tier2 LLM 仅在 `apps/api`；Zod 为 schema 单一事实源；本次不触碰任何抓取/落库/众包面。

## 目标 / 非目标

**目标：**
- monorepo 骨架（pnpm workspace + TS project references）可构建、可测试。
- 打通 `POST /parse`：单饮料商品 → 每 100ml，经 tier1 → tier2(LLM) → tier3。
- 把会长期存在的接口形状一次定型：`SpecParserLLM` port、Zod schema、tier3 校验/warning 钩子。
- AI 接入经 Vercel AI SDK → OpenRouter，model 可配。

**非目标：**
- `/compare`、组合装、可比判断、缓存、级联升级、人工纠错、DB、客户端。
- eval 黄金集（紧随其后单独提）。
- 任何宽度（多品类、多规格形态、多 provider 实现）。

## 决策

### D1：竖向穿刺，不做横向地基 Phase 0
**选择**：用一条端到端最窄功能拉出地基，而非先铺多 provider 路由/缓存/全 schema。
**理由**：横向地基在没有消费者时设计抽象 = 过早抽象（违背项目反过度工程原则）。穿刺让架构缝被真实代码压过一遍。
**替代**：横向 Phase 0 —— 否决，先建抽象后找用途。

### D2：AI 框架 = Vercel AI SDK，上套自有 `SpecParserLLM` port；否决 LangChain
**选择**：两层缝——`SpecParserLLM`（领域 port，我们造，进 RawProduct 出 ParsedSpec）+ AI SDK `generateObject`（provider 抽象，买）。
**理由**：领域 port 保护「是否用 LLM」这件事，未来可换纯规则/微调分类器；provider 切换交给 AI SDK，不自己造。AI SDK 的 `generateObject` 直接吃 Zod schema 出结构化，与 SOT 天然契合。
**替代**：LangChain.js —— 否决，chain/agent 抽象对「单步文本结构化」是负担。手搓 fetch —— 否决，每 provider 重写一遍。

### D3：Provider 从第一天即 OpenRouter（OpenAI-compatible）
**选择**：AI SDK 的 OpenAI-compatible provider，`baseURL = https://openrouter.ai/api/v1`，`OPENROUTER_API_KEY` 一个 key；廉价档 model 常量 `deepseek/deepseek-chat`。
**理由**：一个 key 通全模型 →「换厂商」和「按难度级联」都退化成换 model 字符串；做 eval 时同代码横扫全模型。
**替代**：直连 DeepSeek —— 更便宜但锁单厂商，eval 不便。保留为后路：port 不变，规模化抠成本时在背后加直连 provider 作廉价档。

### D4：级联路由作为目标形状，本次只实现单档
**选择**：`SpecParserLLM` port 接口留好「升级档」位（校验失败 → 换强模型重试），但本次只接单档廉价模型。
**理由**：省钱靠 regex+缓存+廉价优先，准确靠 tier3 校验守门+升级+人工回流。级联是业务语义（tier3 校验驱动），留在领域层，不与 OpenRouter transport 层 fallback 冲突。
**替代**：首版就实现完整级联 —— 否决，无 eval 与缓存时无法验证收益，先留缝。

### D5：tier 边界与纯度
**选择**：tier1 正则 + tier3 计算/校验 → `packages/core`（纯函数、无 IO、双端、配单测）；tier2 LLM 编排 → `apps/api`。
**理由**：core 的可信度靠纯函数 + 单测保证；IO（网络/LLM）隔离在 api，便于测试与复用。

## 风险 / 权衡

- **OpenRouter margin** → 早期换零运维 + 全模型可试，值；规模化时按 D3 后路切直连。
- **廉价模型结构化输出不稳** → tier3 Zod 校验 + 一致性校验当守门员，不合 schema 直接拒绝并降置信度；`generateObject` 在不支持原生结构化时回退 prompt-based JSON。
- **穿刺过窄、像玩具** → 接受：宽度是 Phase 1 后续 change 的事；本次价值在「架构缝被验证」而非功能覆盖。
- **接口形状定型过早** → 用探索阶段已定稿的领域模型（见架构文档第三、五节）降低返工；仅定形状不定全实现。

## 未决问题

- 廉价档具体选哪个 OpenRouter 模型为默认（`deepseek-chat` vs `qwen-2.5-*`）——待 eval 黄金集那条 change 用数据定，本次先用 `deepseek-chat` 占位。
- `confidence` 的**档位边界已在 spec 固化**（高 ≥0.9 / 中 (0.5,0.9) / 低 ≤0.5，按字段分层判定）；**待细化的是档内的具体打分口径**（tier1 命中 vs LLM 自报 vs 校验加权），留后续 change。
- `multipliers` 本次重定义为「箱/提等额外层级乘数」恒 `[1]`，与 qa.md 早期把数量塞进 `multipliers:[24]` 的措辞不同——以本 spec 为准（`quantity` 与 `multiplier` 分列，formula 展开式已体现）。
- `formula` 字面以本 change 的 `unit-price-calc` spec 为准（含 `* multiplier` 项的展开式），`docs/architecture.md:46` 的旧示例 `40 / (330*24) * 100` 不含 multiplier，归档同步时再对齐 SOT。
