## 1. packages/eval 骨架

- [x] 1.1 创建 `packages/eval` workspace(`package.json`:name `@unit-price/eval`、type module、依赖 `@unit-price/core`、`zod`、devDep `vitest`;`tsconfig.json` extends base、references core)
- [x] 1.2 加 CLI 入口骨架(如 `src/cli.ts`:子命令 `extract` / `score` / `baseline`),`pnpm -r build`/`test` 纳入
- [x] 1.3 `.gitignore` 增 `*.har`、`packages/eval/corpus/*`(语料产物)、保留 `*.sample.jsonl` 与 `baseline.json`

## 2. 语料格式与加载

- [x] 2.1 用 Zod 定义语料样本 schema(`title` 非空、`source`、可选 `priceCents`/`samPkgNum`/`samPkgUnit`/`samUnitPrice`/`isCompare`/`expected`),types 推导
- [x] 2.2 实现 JSONL 加载器:逐行校验,缺/空 `title` 行报明确行号错误,不静默跳过
- [x] 2.3 落少量脱敏样例 `*.sample.jsonl`(几条)供 smoke

## 3. HAR 提取器

- [x] 3.1 实现 `extract`:解析 HAR,定位山姆商品列表响应(`goods-portal/grouping/list`),按 `spuId` 去重
- [x] 3.2 仅提取校准必需字段 → 语料行,`source="har:<file>"`;`price` 按「分」解析为整数 `priceCents`(`"10990"`→10990),`priceInfo` 空/`price` 非数值→`priceCents` 置空仍入语料;`smallPackagePriceDisplay`(展示串 `￥18.32/瓶`)解析为**数值** `samUnitPrice`,解析失败(促销/区间/缺失)→置空、计「无单价真值样本」(与 priceCents 对称);忽略非商品响应、不写原始响应/鉴权字段
- [x] 3.3 单测:构造 HAR 断言去重(同 spuId 保留首条)、字段提取、`price` 分解析与空价格容错、跳过非商品、**截断/非 JSON body → 跳过且计数、不崩**

## 4. 打分跑批器

- [x] 4.1 实现 `score`:对语料逐条跑 `core` tier1 + tier3;有 `OPENROUTER_API_KEY` 时另跑 tier1+tier2(`SpecParserLLM` 经**动态 import**,不作常驻依赖;无 key 不加载 apps/api)
- [x] 4.2 指标:unitSize/quantity/totalAmount 召回率;**可算率**(tier3 产出非空 per100ml 的样本占比,消费 tier3 结论);quantity 相对 `samPkgNum` 精度(0/错值/null 均计错误);per-unit 价误差 = 自算 `evalPerUnit=(priceCents/100)/quantity` 比 `samUnitPrice`,**仅 quantity>0 且有 samUnitPrice 时计入**(quantity≤0/null 排除,杜绝除零);per100ml 无外部真值、不做精度断言;tier1-only vs tier1+tier2 对比
- [x] 4.3 无 key 时仅跑 tier1-only、报告标注「tier2 未评(无 key)」、不报错退出;任一指标分母为 0 → 记 `n/a`(非 0/NaN)、不入回归
- [x] 4.4 输出机器可读 metrics(JSON)+ 人可读摘要(含失败样本清单 + per100ml 无外部真值标注)
- [x] 4.5 单测:构造小语料断言召回/精度/per-unit 误差计算正确;无 key 路径不崩;空语料/零合格样本 → n/a 不除零

## 5. 回归基线

- [x] 5.1 实现 `baseline`:保存当前 metrics 为 `baseline.json`(显式动作)
- [x] 5.2 `score` 与基线对比:正向指标(召回/精度)低于基线−阈值、反向指标(误差)高于基线+阈值 → 判回退、非零退出 + 列新增失败样本;首跑无 baseline.json → 输出指标 + 退出 0 + 标注「无基线」;阈值可配
- [x] 5.3 单测:正向指标回退、反向误差升高均断言非零退出;无基线断言退出 0 不算回退;不低于基线断言通过

## 6. 端到端验证

- [x] 6.1 `pnpm --filter @unit-price/eval test` 全绿;`pnpm -r build` 不回归
- [x] 6.2 用用户提供的真实 HAR 跑 `extract` → `score`,产出 tier1-only 真实指标报告(复现本次校准:容量召回~98%、数量召回~21%、数量精度~96%),存首个 `baseline.json`
- [x] 6.3 更新 `TODO.md`:Phase 1「最小客户端/eval 验证」项标注本 change 已交付 eval 基线
