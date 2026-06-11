## 上下文

`parseTier1`(`packages/core/src/parser.ts`)的单件推断(L216-231):

```js
if (quantity === null && unitSize !== null && isVolumeUnit(unitSize.unit)) {
  const rest = title.slice(0, sizeMatch.index) + title.slice(sizeEnd);
  if (!hasQuantitySignal(rest)) { quantity = 1; warnings.push(WARN_INFERRED_SINGLE); }
}
```

`hasQuantitySignal(rest)`(L87)= `QTY_SIGNAL_RE.test(rest)`,其中
`QTY_SIGNAL_RE = /[*×x]|(\d+)\s*(瓶|罐|支|盒|袋|听|提|箱)|\d/i`(L77)。

末尾的 `|\d`(任意游离数字)是 catch-all——它让 `55%vol`、`53度`、`埃德华兹900` 的数字都判为「有数量信号」,抑制了单件推断。`hasQuantitySignal` **仅被单件推断调用**(全仓唯一 call site),故改它只影响该推断、不波及 size/乘号/包装计数抽取主路径。

## 目标 / 非目标

**目标:** 单瓶烈酒/百分比含量饮料(`53度 500mL`、`55%vol 950ml`、`100%果汁 300ml`)正确推断 `quantity=1` → 可算 per100ml;真实数量信号(乘号、数字+包装单位)仍抑制推断;裸品名编号保守留 null。

**非目标:** 不重写 tier1 正则;不改 size/乘号/包装计数抽取;不改 tier2/计算/去重/persistence;不识别裸品名编号(无 %/度/vol 后缀)为非数量。

## 决策

**D1:`hasQuantitySignal` 在判定游离数字前剥离「含量描述符」token。**
新增 `CONTENT_TOKEN_RE = /\d+(?:\.\d+)?\s*(?:%\s*vol|%vol|vol|度|°|%)/gi`(global,可多次出现),`hasQuantitySignal(rest)` 改为 `QTY_SIGNAL_RE.test(rest.replace(CONTENT_TOKEN_RE, ''))`。即:先把 `55%vol`/`53度`/`100%`/`53°` 整段抹掉,再判剩余是否还有数量信号。
- 顺序:`%vol`/`%\s*vol` 在 `%` 之前(`55%vol` 整段抹,不留 `vol`);`vol` 单列兜底 `55vol`(罕见)。`度`/`°` 覆盖白酒度数两种写法。
- 剥离只在 `hasQuantitySignal` 内(单件推断判据),**不**改 `rest` 本身、**不**影响其它抽取(size/乘号/包装计数都在此之前已定)。
- 备选(否决):在主 `QTY_SIGNAL_RE` 里用负向断言排除 `\d(?=%|度|°)`。否决——负向断言对 `55%vol` 这种「数字+多字符后缀」表达繁琐易错;先 `replace` 再 `test` 更直观、可读、可单测。

**D2:剥离不误删真实数量信号。**
`CONTENT_TOKEN_RE` 只匹配「数字 + 含量后缀(`%`/`vol`/`度`/`°`)」,**绝不**匹配乘号 `[*×x]`、`数字+包装单位`(`6瓶`/`24听`——`瓶`/`听` 非含量后缀)、或裸游离数字(无含量后缀)。两条路径保证不误推单件:
- **真实数量在 size 之后**(realistic 山姆形态,如 `白酒 53度 500ml*6瓶`):既有 `QTY_RE`(扫 `title.slice(sizeEnd)`)抽出 `quantity=6`,此时 `quantity≠null`、**根本不进单件推断**(单件推断仅 `quantity===null` 时跑)——含量剥离与否都不影响,`度` 不干扰正常数量抽取。实测:`53度 500ml*6瓶`/`500ml 6瓶`/`500ml*6` 均 `quantity=6`/`total=3000ml`。
- **真实数量在 rest 里但未被抽取**(如前置 `6瓶 500ml`,`PKG_COUNT_RE` 只扫 size 之后、不抽前置包装计数):进单件推断时,`rest` 含 `6瓶`,剥度数后 `6瓶` 仍命中 `QTY_SIGNAL_RE` → `hasQuantitySignal=true` → **不推断单件**,`quantity` 保持 `null`(不被误推为 1、不误价;前置包装计数不被抽取是既有限制、本变更不引入也不修)。
- **裸编号**(`埃德华兹900` 的 `900`,无含量后缀):不被剥 → `\d` 仍命中 → 保守抑制单件、留 null(R2 残留)。
验证:已用 node 探针 + 当前 parser 实测——含量单瓶(`53度 500mL`/`55%vol 950ml`/`100%果汁 300ml`/`52° 500ml`)触发单件;`500ml*6瓶` 等真实计数 `quantity=6`;`6瓶 500ml`(前置)与 `埃德华兹900` 留 null;行为全符合。

**D3:推断后的下游不变。** 推断成功(`quantity=1`)后,`totalAmount = unitSize`(沿用值与单位,`L` 不跨档)、`WARN_INFERRED_SINGLE` 照旧附上;calculator 算 `per100ml = price / totalMl * 100`。本变更只放开「被含量数字误抑制」的推断,不改推断后的派生。

## 风险 / 权衡

- **[R1 误剥真实「数字%/度」数量]** 极不可能——饮料标题里 `NN%`/`NN度` 一律是含量(酒精度、果汁浓度),不会是数量(数量用 `*N`/`N瓶`/`N听`)。即便某标题用 `%` 表数量(无此先例),剥离只影响单件推断、最坏退回 null(保守),不产生错误单价。
- **[R2 裸编号残留]** `埃德华兹900` 的 `900` 无含量后缀,仍抑制推断 → null。本变更不修(无法可靠区分品名编号与数量),proposal 非目标已承认。与「宁可不算也不算错」一致。
- **[R3 与既有单件推断行为兼容]** 剥离后仅「含量数字是唯一『信号』」的标题从 null 转为 `quantity=1`;凡有乘号/包装计数/裸编号的标题行为**完全不变**。既有脏标题样本集全跑回归 + 新增样本固化。
- **[R4 `度` 作为单位的歧义]** `度` 在本项目单位集里**不是**容量/重量单位(单位集 `ml|L|g|kg`),故 `53度` 的 `53` 不会被 `SIZE_RE` 当 size 抽取;它只在 `hasQuantitySignal` 的游离数字判定里作梗。剥离 `度` token 是安全的(它从不参与 size/quantity 的正向抽取)。
