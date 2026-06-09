## 上下文

`bootstrap-parse-skeleton` 已交付 core 解析/计算 + `/parse`。对真实山姆 HAR(440 商品)的临时校准显示 tier1 完整率仅 ~19%、数量召回 20.7%(精度 95.8%)。本变更把这次性校准固化为可回归工具。语料来自用户手动提供的离线 HAR(个人抓包,合规最低风险层),不做任何自动抓取。

## 目标 / 非目标

**目标:**
- 让解析准确率可量化、可回归——换模型/改 prompt/调正则后能立即看出升降。
- 复用山姆自带 ground truth(`smallPackageNum`/`smallPackagePriceDisplay`),零额外标注即可评 quantity 精度与单价误差。
- 无 key 也能跑(tier1-only),有 key 才评 tier2。

**非目标:**
- 自动抓取/MITM 管道;改 parser/calculator(归 `tier1-real-data-fixes`);新可比单位;重分发山姆数据。

## 决策

### D1:独立 `packages/eval` workspace
**选择**:新建 `packages/eval`(库 + CLI),依赖 `@unit-price/core`;tier2 评测时依赖 `apps/api` 导出的 `SpecParserLLM`。
**理由**:评测是开发期工具,与运行时 core/api 解耦;放 workspace 内可复用类型与 NodeNext 配置。
**替代**:塞进 apps/api —— 否决,污染运行时包。
**依赖方向**:`packages/eval` 对 `@unit-price/core` 是常驻依赖;对 tier2 的 `SpecParserLLM`(在 apps/api)**仅在有 key 的可选 tier2 路径用动态 import**,不作为常驻 workspace 依赖,避免「工具包反向硬连应用包」的分层异味。无 key 时(tier1-only)不加载 apps/api。

### D2:ground truth 优先用山姆自带字段
**选择**:`samPkgNum`→quantity 真值;`smallPackagePriceDisplay`→per-unit 价误差基准;`expected`(人工标注)为可选补充。
**理由**:零成本拿到 48+ 条带真值样本;人工标注按需增量。
**诚实边界**:山姆只给 per-瓶/罐 单位价,不给 per-100ml;故 per-100ml 本身无外部真值,只能用「quantity 对 + 容量解析对 → 推导 per-100ml 可信」间接验证,并对照 per-unit 价交叉校验。

### D3:原始数据不入库
**选择**:`.gitignore` 排除 `*.har` 与语料/全量产物;仓库内仅留少量脱敏样例 + 可入库的 metrics 基线快照。
**理由**:山姆商品数据非我方可重分发资产;基线是派生指标,入库安全且利于回归。

### D4:key 可选、tier2 不阻塞
**选择**:无 key → 仅 tier1-only,报告标注 tier2 未评,不报错。
**理由**:tier1 评测是主价值且零成本;tier2 评测花钱、按需。

### D5:回归门为显式阈值
**选择**:基线对比超阈值回退 → 非零退出;刷新基线需显式动作。
**理由**:防准确率静默劣化;防误把回退当通过。

## 风险 / 权衡

- **per-100ml 无外部真值** → 用 quantity/容量解析正确性 + per-unit 价交叉校验间接保证,文档显式声明非完备。
- **HAR 字段随山姆改版漂移**(字段名/结构变) → 提取器对缺字段容错(跳过、计入「无真值」样本),不硬崩。
- **语料样本偏** → 单次 HAR 只覆盖抓取时的品类;基线注明语料规模与来源,扩样本即重建基线。

## 未决问题

- quantity 精度/单价误差的「显著回退」阈值具体取值(如绝对 -2% 还是相对)——首版给保守默认,跑几次后校准。
- 是否把少量脱敏样例语料入库作 smoke 用——倾向是(几条即可),具体条数实现时定。
