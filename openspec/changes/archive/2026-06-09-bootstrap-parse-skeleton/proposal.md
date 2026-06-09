## 为什么

整个系统的可信度建立在「AI 把脏规格文本结构化、确定性程序算单价并留痕」这条链路上。在加宽任何品类、客户端或品类规则之前，必须先用一条最窄的端到端「穿刺线」把这条脊柱压实——验证 monorepo 联动、`SpecParserLLM` 领域缝、三段式解析的接口形状是否成立。先建横向地基（在没有消费者时设计多 provider 路由/缓存）会陷入过早抽象；竖向穿刺让地基由真实功能拉出来。

## 变更内容

搭建 TypeScript monorepo 骨架，并打通**单个饮料商品 → 每 100ml 单价**的完整链路：

- 建立 `pnpm` workspace + TypeScript project references，初始化 `packages/core` 与 `apps/api` 两个 workspace。
- `packages/core`：用 Zod 定义 `RawProduct` / `ParsedSpec` / `UnitPrice` 的最小字段；实现单位换算、tier1 正则解析（`数字 + 单位 × 数量`）、tier3 每 100ml 确定性计算 + `formula` 留痕 + 一致性校验钩子。纯函数、无 IO、配单测。
- `apps/api`（Hono）：暴露 `POST /parse`，编排 tier1 → tier2(LLM) → tier3。
- `SpecParserLLM` 领域 port：输入 `RawProduct`，输出 `ParsedSpec`（Zod 校验）。底层用 **Vercel AI SDK** 的 OpenAI-compatible provider 指向 **OpenRouter**（一个 key，model 字符串可配），先接单档廉价模型（`deepseek/deepseek-chat`）。
- 接口形状一次到位：port 接口、Zod schema、tier3 校验钩子都按最终设计定型，仅实现先做单档、单品类、单单位。

## 非目标（本次不做）

- `POST /compare`、多商品排名、自然语言 summary。
- 单位口径仅 `per100ml`；`per_liter`/`per_bottle`/`per_can` 等其他可比单位留后续。
- `comparable`/`excludedReason` 字段与可比性判断；不可计算情形仅以 `per100ml=null + warning + 低置信` 表达。
- 组合装 / 多箱 / 促销解析、可比性判断与 `excludedReason`。
- 缓存（Redis）、置信度门控的级联升级、人工纠错回流。
- 数据库落库、众包上报、榜单。
- 任何客户端（插件 / 小程序 / Surge）与任何形式的抓取。
- eval 黄金集（紧随其后单独提，本次只把 port 形状留好）。

## 功能 (Capabilities)

### 新增功能
- `spec-parsing`: 从 `RawProduct`（标题 + 价格）解析出结构化 `ParsedSpec`——tier1 正则 + tier2 LLM(经 `SpecParserLLM` port)，含单位归一与置信度。
- `unit-price-calc`: 由 `ParsedSpec` + 价格确定性计算每 100ml 单价，产出 `formula` 留痕并做 `total == unit × qty` 一致性校验。
- `parse-api`: `apps/api` 的 `POST /parse` 接口，编排上述两个能力并返回结构化结果。

### 修改功能
本次为项目首个变更，无既有规范，故无修改功能。

## 影响

- **新增 workspace**：`packages/core`、`apps/api`（monorepo 骨架首次落地）。
- **新增依赖**：`zod`、`hono`、`ai`（Vercel AI SDK）、OpenAI-compatible provider；测试用 `vitest`。
- **新增配置**：`OPENROUTER_API_KEY` 环境变量、廉价档 model 字符串常量。
- **合规敏感面**：无——本次仅按需计算，不抓取、不落库、不众包。
- **预留缝**：`SpecParserLLM` port 留好升级位（级联 / 直连 provider），tier3 校验钩子留好 warning 通道，供后续 Phase 加宽时复用，不需重构。
