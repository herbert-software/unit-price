## 为什么

对真实山姆数据(2026-06-09 手动抓包 HAR,440 个饮料商品)跑 tier1 校准显示:容量抽取 97.7%,但**数量召回仅 20.7%、完整可算规格仅 19.3%**(数量一旦抽到则 95.8% 正确——高精度低召回)。这实证了 tier1+tier2 分层的必要,也暴露真实标题远比构造样本脏。但目前**没有可量、可回归的准确率基线**:换模型、改 prompt、调正则时无法判断准确率是升是降——「可切换」尚不等于「可安全切换」。

山姆数据自带 ground truth(`smallPackageNum`=数量真值、`smallPackagePriceDisplay`=山姆自算单位价、`isCompare`),正好建黄金集。本变更把校准固化为工具:标注语料格式 + HAR 提取器 + 打分跑批 + 回归基线。

## 变更内容

新增一个离线、本地运行的评测工具(不触网、不抓取):

- **黄金集语料格式**:JSONL,每行 `{ title, priceCents?, 真值(samPkgNum/samPkgUnit/samUnitPrice/isCompare)?, 期望规格?, source }`,由 Zod 定义。
- **HAR → 语料提取器**:从抓包 HAR 的 `goods-portal/grouping/list` 等响应提取山姆商品,只取校准必需字段(标题/价格/山姆单位价字段),生成语料。
- **打分跑批器**:对语料逐条跑 `@unit-price/core` 的 tier1(及可选 tier1+tier2,有 key 时),计算指标——unitSize/quantity/totalAmount 召回率、quantity 相对 `samPkgNum` 的精度、per-unit 价相对山姆 `smallPackagePriceDisplay` 的误差、tier1-only vs tier1+LLM 对比;输出可读报告 + 机器可读 metrics。
- **回归基线**:把一次 metrics 快照存为 baseline,后续跑批与之对比,准确率回退即告警(供 CI / 本地回归门)。

## 非目标

- 不做任何自动抓取 / MITM 管道(那是 Phase 4 个人层),语料只来自用户手动提供的离线 HAR / 手填。
- 不重分发山姆商品数据:原始 HAR 与全量语料**不入库**(gitignore),仓库内最多放少量脱敏样例。
- 不改 tier1 parser / tier3 calculator / API 行为——本变更只**度量**,改进归 `tier1-real-data-fixes`。
- 不强制要 `OPENROUTER_API_KEY`:无 key 时跑 tier1-only;有 key 才评 tier2 那档。
- 不引入新可比单位(per-100g 等)。

## 功能 (Capabilities)

### 新增功能
- `eval-harness`: 离线评测工具——语料格式、HAR 提取器、tier1/tier2 打分跑批、相对山姆真值的指标、回归基线对比。

### 修改功能
本次为新增工具,无修改既有功能。

## 影响

- **新增 workspace**:`packages/eval`(CLI + 库,依赖 `@unit-price/core`、`apps/api` 的 SpecParserLLM port 用于可选 tier2;`zod`、`vitest`)。
- **新增配置**:`.gitignore` 增 `*.har`、语料/基线产物目录;eval 跑 tier2 时复用 `OPENROUTER_API_KEY`(可选)。
- **合规敏感面**:无服务端抓取;原始抓包数据本地、不入库、不重分发。
- **依赖**:与 `bootstrap-parse-skeleton` 已交付的 core 解析/计算复用;本工具是 `tier1-real-data-fixes` 的度量基线(后者据本工具数据验证改进不回退)。
