## 1. tier1 parser 修复(packages/core)

- [x] 1.1 `packages/core/src/parser.ts`:`QTY_RE`(跑在 `title.slice(sizeEnd)`)命中乘号 `[*×x]<N>` 后,**乘号绝对位 = `sizeEnd + qtyMatch.index`**(`qtyMatch.index` 相对 `qtySearch`,必须 `+sizeEnd`);取窗口 `title.slice(0, sizeEnd + qtyMatch.index)`,用 **global SIZE 正则**(`SIZE_RE` 现非 global → `new RegExp(SIZE_RE.source,'ig')` + `matchAll`/循环)取窗口内**最靠后**的 size = `nearestVol`
- [x] 1.2 仅当 `nearestVol` 存在且**不是**第一个 size(`nearestVol.index > 第一个 sizeMatch.index`,即有更早的 `leadingVol`)时,**先过自洽门**(注意:`SIZE_G.matchAll` 也会匹配**重量** token `2kg`/`100g`,故 `nearestVol`/`leadingVol` 可能是重量,须由下面 (a) 体积子检查挡掉)。门四条按**短路顺序**(比较放最后防 NaN/Infinity):(a) `leadingVol` 与 `nearestVol` 都 `isVolumeUnit`;(b) `toMl(leadingVol) > 0`(除零守卫,`0L` 等不进除法);(c) `N > 0`;(d) `|toMl(nearestVol)×N − toMl(leadingVol)| / toMl(leadingVol) ≤ 0.1`
- [x] 1.3 **门四条全满足**(自洽,真总量复述)→ `unitSize ← nearestVol`、`quantity ← N`、`totalAmount ← nearestVol × N`(沿用现有派生)。**任一不满足**(非体积 / 非正前导 / N≤0 / 不自洽)→ **不重绑**,保持既有「`unitSize`=第一个 size、`quantity`=N」(`leadingVol` 视为品名噪声)。**禁止**不自洽时仍采纳括号拆解;**禁止**对 `toMl(leadingVol)≤0` 求相对误差
- [x] 1.4 确认前置 `24x500mL`(QTY_BEFORE_RE 回退)、前后乘号并存 `24x500mL*6`(后侧优先)、品名噪声 `可口可乐X20 330ml*6听`(`X20` 非 size)三条既有路径**不被本改动吞并**(乘号在 size 之前 vs 之后位置互斥;单件推断与本规则因 `quantity===null` vs `quantity≠null` 互斥)

## 2. packages/core 单测(脏标题样本集)

- [x] 2.1 测自洽改绑 `多维刺梨柠檬饮 2.1L(100mL×21)`(价 69.9,100×21=2100≈2100)→ `unitSize=100ml`/`quantity=21`/`totalAmount=2100ml`;calculator 得 `per100ml≈3.33`(**禁止** 2.1L/44.1L/0.159)
- [x] 2.2 测取整标签自洽改绑 `2L装可乐 330ml*6`(2000 vs 1980,1%≤10%)→ `unitSize=330ml`/`quantity=6`/`total=1980ml`(而非把品名 `2L装` 当 unitSize 算 12L)
- [x] 2.3 测**不自洽(品名噪声)不改绑** `550mL便携装 1.5L*6`(550 vs 9000,严重不符)→ 保持 `unitSize=550ml`/`quantity=6`(`1.5L` 视噪声不参与);**禁止**误重绑为 1.5L 单件
- [x] 2.4 测非体积前导不改绑 `某蛋白粉 2kg(100g×20)`(重量,`toMl` 返 null 无法校验)→ 不重绑;终态 `per100ml=null`
- [x] 2.4b 测前导重量+真体积单件不改绑 `2kg礼盒 330ml*6`(前导 `2kg` 非体积)→ 不重绑、`unitSize` 仍为 `2kg`(首个 size)、`quantity=6`、终态 `per100ml=null`(保守静默 null,已知非目标)
- [x] 2.4c 测除零守卫 `0L(100mL×21)`(前导 `toMl=0`)→ **断言门决策**:**不重绑**(`unitSize` 仍为首个 `0L`、`quantity` 仍为 QTY_RE 原值,而非被改绑成 `100ml`/21)、结果 `per100ml` 为 null 或有限值(**绝不 NaN/Infinity**)。注:守卫 (b)「不对 `toMl(前导)=0` 求除法」是**短路顺序的代码属性**(`Infinity≤0.1=false` 与下游 `isFinite` 使「有无 (b) 守卫」黑盒输出相同),故本测验的是门决策正确(不误改绑)+ 无 NaN emit;「无瞬态除法」由代码审查保证、不靠黑盒断言
- [x] 2.4d 测 3-size 窗口「中间 size 忽略」`2.1L 礼盒1L 100mL×21`(前导=首个 `2.1L`、单件=最靠后 `100mL`、中间 `1L` 忽略;100×21=2100≈2100 自洽)→ `unitSize=100ml`/`quantity=21`/`total=2100ml`
- [x] 2.5 测单 size 不变:`可口可乐 300mL*24` → `300ml`/`24`/`7200ml`(回归)
- [x] 2.6 测数量前置不变:`阿尔卑斯山气泡水 24x500mL` → `500ml`/`24`/`12000ml`;`24x500mL*6` → `quantity=6`(后侧优先,经新规则仍不变)
- [x] 2.7 测品名噪声不变:`可口可乐X20 330ml*6听` → `quantity=6`(取紧贴 size 的 *6,不取 X20)
- [x] 2.8 测单件不变:`MM 弱碱性饮用水 4L` → `quantity=1`/`total=4L`(单件推断,新规则不进入);`可口可乐 330ml*24听` → `330ml`/`24`/`7920ml`(单 size 不变)
- [x] 2.9 `pnpm --filter @unit-price/core test` 全绿(既有脏标题样本零回退)

## 3. eval 样本入库(防未来漂移,**非本次修复验收**)

> ⚠️ **本次修复的验收锚点是第 2 节 core 单测**(它们对 `unitSize`/`totalAmount`/`per100ml` 值做真断言)。`packages/eval` 的 `score.ts` 当前**只**消费 `recall`(布尔命中)/`quantityAccuracy`(vs `samPkgNum`)/`computability`(per100ml 非空)/`perUnitError`(`price/quantity` vs `samUnitPrice`),**不消费** `expected` 的 `unitSize/total/per100ml` 值;本 bug 修复前后这些指标全不动(`quantity` 恒 21、per100ml 恒非空)→ eval 基线对本 bug **vacuous-green**。故 3.x 仅为「样本入库防未来漂移」,**不得**作为「修复已验证」的证据。

- [x] 3.1 把 `多维刺梨柠檬饮 2.1L(100mL×21)` + 品名噪声样本(`2L装…330ml*6`、`550mL便携装 1.5L*6`)加进 `packages/eval` corpus(含 ground-truth)备未来用;**不依赖 eval 断言本次修复**
- [x] 3.2 (可选/超范围)若要让 eval 真能验证值级修复,另起变更给 `score.ts` 增加消费 `expected.per100ml`/`unitSize` 的值精度指标——**本变更不做**,只确保 core 单测(第 2 节)是验收锚点、`pnpm --filter @unit-price/eval test` 仍绿(不回退既有指标)

## 4. 收尾

- [x] 4.1 `pnpm -r test` + `pnpm -r build` 全绿
- [x] 4.2 `openspec-cn validate fix-total-with-unit-breakdown --strict` 通过
