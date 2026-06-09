# CLAUDE.md

本文件给 Claude Code 提供项目级协作指引。**不在此复制架构内容**——架构的单一事实源是 [`docs/architecture.md`](docs/architecture.md)，开工前先读它。`openspec/config.yaml` 的 context 也派生自该文档（供 OpenSpec 生成工件时用），三者不要各写一份。

## 必读

1. [`docs/architecture.md`](docs/architecture.md) — 架构蓝图（SOT）：定位、monorepo 布局、core 设计、API、四个客户端、合规分层、分期路线。
2. [`qa.md`](qa.md) — 需求源讨论：数据模型 JSON、AI prompt 设计、促销分层、反套路提示样例。

## 不可动摇的工程约定

- **三段式解析**：tier1 正则（`packages/core`，客户端+服务端双跑）→ tier2 AI（仅 `apps/api`）→ tier3 确定性计算+校验（`packages/core`）。
- **AI 只理解，不计算**：价格、单位换算、是否可比，一律由 `packages/core` 的确定性程序决定。LLM 只负责把脏文本结构化输出。
- **计算留痕**：每个单价结论带可回放的 `formula` 字符串。
- **schema 单一事实源**：用 Zod 定义，types 从中推导；API 校验、LLM 结构化输出、客户端校验共用同一份。不要手写重复类型。
- **core 是纯函数、无 IO**：必须配完整单测（脏标题样本集）。任何 IO（网络、DB、LLM 调用）放 `apps/api`。
- **数据合规**：按需计算（无状态）永远可用；中心库只收用户主动贡献的众包数据，**不做服务端主动全站爬取**。
- **不追求万物可比**：不可比的商品要明确标注 `comparable=false` 和 `excludedReason`。

## 协作方式

- 用 **OpenSpec** 管理变更：先 `/openspec-propose` 出提案，再实现。提案聚焦单个 Phase / 单个能力。
- 改动跨多文件且重复同一模式时，描述模式 + 代表路径即可，不逐行枚举。
- 文档/注释里不要写开发过程语境（P1/P2、review、本次修改等）。
