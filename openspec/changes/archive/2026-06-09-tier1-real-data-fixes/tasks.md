## 1. 前置

- [x] 1.1 确认 `bootstrap-parse-skeleton` 已归档(或其 `spec-parsing` 规范已同步为基线),使本变更的增量可叠加
- [x] 1.2 确认 `add-eval-harness` 已就位并有 tier1 基线,作为本次改进的回归度量

## 2. 孤立容量单件 → 数量 1

- [x] 2.1 在 `packages/core/src/parser.ts`:当解析出容量 `unitSize(ml/L)` 且标题**除 size 外无其他数字数量信号**(无 `*×x` 乘号、无 `数字+包装单位`(`瓶/罐/支/盒/袋/听/提/箱`)、无游离数字计数)时,置 `quantity=1`、`totalAmount=unitSize`(**沿用 unitSize 单位、不在 parser 换算 L→ml**),附信息性 warning「数量按单件推断为 1」(档位不变);有数量信号但未解析出时维持原缺项路径(不强置 1);**乘号在场但数量≤0(如 `330ml*0`)不触发单件推断**,按 quantity≤0 交下游零总量终态
- [x] 2.2 单测:`MM 弱碱性饮用水 4L`→qty=1/total={4,L}(不换 ml)/带单件推断 warning/高档;`星巴克能量饮料 4.104升`→qty=1/total={4.104,L};`330ml*24听`→qty=24(不覆盖、无推断 warning);`MM 现泡铂金黑咖啡 15瓶`(有包装计数无 size)→不误置 1;`整箱24听 可乐 330ml`→不触发单件(有 `24听` 数字信号)→缺项/tier2;`农夫山泉 330ml*0`→不推断、qty=0→下游 per100ml=null
- [x] 2.3 注意与既有 parser 的 totalAmount 派生口径对齐:归档实现对 `1L*6` 曾派生 `{6000,ml}`(实跑可见),而主规范文本要求 parser 不换算 L→ml。本任务统一为「parser 沿用单位、不跨档换算」,实现时一并校正既有派生路径,使 ml/L 输入口径一致(由 calc 统一换算);eval 的 per100ml 数值回归兜底

## 3. 数量前置提取(count-before-size)

- [x] 3.1 在 `parser.ts`:SIZE_RE 命中后,数量优先在 size 之后子串搜(现行);后侧无则在 size **紧贴之前**的窗口找 `(\d+)\s*[*×x]\s*$` 前置形态;**不**放开全标题搜索
- [x] 3.2 单测:`阿尔卑斯山气泡水 FONTE LINDA 24x500mL`→unitSize=500ml/qty=24/total=12000ml;`24×500mL` 同;`可口可乐X20 330ml*6听`→qty=6(X20 不被当数量,回归);`330ml*24听`→24(后置不退化);**`24x500mL*6`→qty=6(前后并存取后侧,不相乘成 144)**

## 4. 回归与度量

- [x] 4.1 `pnpm --filter @unit-price/core test` 全绿(新增用例 + 既有 50 测试不回归)
- [x] 4.2 用 `add-eval-harness` 对同一真实 HAR 语料重跑:数量召回较基线明显上升、数量精度(对 `samPkgNum`)不下降;刷新基线
- [x] 4.3 更新 `TODO.md` 相应进度备注(tier1 真实数据召回改进)
