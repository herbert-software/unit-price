## 1. tier1 parser 修复(packages/core）

- [x] 1.1 `packages/core/src/parser.ts`:新增 `CONTENT_TOKEN_RE = /\d+(?:\.\d+)?\s*(?:%\s*vol|%vol|vol|度|°|%)/gi`(global;匹配「数字 + 含量后缀」:酒精度 `度`/`°`、`%vol`、百分比 `%`)
- [x] 1.2 `hasQuantitySignal(rest)` 改为先剥含量 token 再判:`return QTY_SIGNAL_RE.test(rest.replace(CONTENT_TOKEN_RE, ''))`。注释说明:含量描述符(`NN度`/`NN%vol`/`NN%`)非数量,排除后剩余无数量信号才推断单件;剥离**只**在此判据、不改 `rest` 本身或其它抽取
- [x] 1.3 确认 `hasQuantitySignal` 是单件推断的唯一 call site(grep `hasQuantitySignal`);改它只影响单件推断、不波及 size/乘号(`QTY_RE`)/包装计数(`PKG_COUNT_RE`)/数量前置(`QTY_BEFORE_RE`)抽取(它们在单件推断之前已定)

## 2. packages/core 单测(脏标题样本集)

- [x] 2.1 测度数单瓶可算 `汾酒沪上青花 清香型白酒 53度 500mL`(价 30)→ `quantity=1`/`totalAmount={500,ml}`;calculator 得 `per100ml=6`(`30/500*100`);附「数量按单件推断为 1」warning
- [x] 2.2 测 `%vol` 单瓶可算 `汾酒 55%vol清香型白酒 950ml`(价 95)→ `quantity=1`/`total={950,ml}`/`per100ml=95/950*100=10`(**禁止** null)
- [x] 2.3 测百分比含量单瓶可算 `NFC 100%果汁 300ml` → `quantity=1`/`total={300,ml}`/per100ml 非 null
- [x] 2.4 测 `°` 写法 `白酒 52° 500ml` → `quantity=1`/`total={500,ml}`(覆盖 `°` 分支)
- [x] 2.5 测含量数字不干扰真实数量计数 `白酒 53度 500ml*6瓶`(数量后置)→ `quantity=6`/`total={3000,ml}`(`*6` 经 QTY_RE 抽取、`quantity≠null` 不进单件推断;`53度` 不干扰);另测前置 `白酒 53度 6瓶 500ml`(`6瓶` 前置不被 PKG_COUNT_RE 抽取)→ `quantity=null`/`per100ml=null`(不被误推单件为 1——既有前置限制,本变更不引入也不修)
- [x] 2.6 测裸编号残留留 null `LFE 进口埃德华兹900单一葡萄园干红葡萄酒 750mL` → `quantity=null`、终态 `per100ml=null`(`900` 无含量后缀,保守不推断——已知残留)
- [x] 2.7 回归:`MM 弱碱性饮用水 4L`→`quantity=1`(无数字单件不变)、`330ml*24听`→`quantity=24`(乘号不变)、`24x500mL`→`quantity=24`(前置不变)、`整箱24听 可乐 330ml`→不推单件(游离 `24听` 不变)、`可口可乐X20 330ml*6听`→`quantity=6`(品名噪声不变)、`330ml*0`→不推单件(乘号在场不变)、`2.1L(100mL×21)`→`quantity=21`(总量复述不变)
- [x] 2.8 `pnpm --filter @unit-price/core test` 全绿(既有脏标题样本零回退)

## 3. eval 样本入库(防未来漂移,非本次修复验收）

> ⚠️ 验收锚点是第 2 节 core 单测(对 quantity/total/per100ml 值做真断言)。`packages/eval/score.ts` 当前不消费 `expected` 值,3.x 仅为防漂移、**不得**作为「修复已验证」证据。

- [x] 3.1 把 `汾酒…53度 500mL`、`55%vol…950ml`、`埃德华兹900…750mL`(残留)加进 `packages/eval` corpus(含 ground-truth `expected`)备未来用
- [x] 3.2 确认 `pnpm --filter @unit-price/eval test` 仍绿(纯追加、不破既有指标断言)

## 4. 收尾

- [x] 4.1 `pnpm -r test` + `pnpm -r build` 全绿
- [x] 4.2 `openspec-cn validate fix-single-unit-content-tokens --strict` 通过
