## 1. core 单位与类型（packages/core）

- [x] 1.1 `units.ts`:新增 `isWeightUnit(unit) = WEIGHT_UNITS.has(unit)` + `toGrams(m)`(镜像 `toMl`:`isWeightUnit` 才返 `m.value * TO_BASE[m.unit]`,否则 `null`)。不新增换算常量(复用 `TO_BASE` 的 `g:1`/`kg:1000`)
- [x] 1.2 `types.ts`:`UnitPriceSchema` 增 `per100g: z.number().nullable()`(types 从中推导;API/客户端共用)。确认 `UnitPrice` 类型含 `per100g`

## 2. tier3 计算必需集/一致性/calculator 轴分派（packages/core，三处容量门同步）

- [x] 2.1 `tiers.ts`:`hasUsableTotalAmount`/`meetsComputeRequiredSet` 硬编 `isVolumeUnit` 改为「`unit` 落在 `{ml,L}`(容量)**或** `{g,kg}`(重量)任一轴、且 base>0」(计算必需集的唯一实现,不改则重量品根本进不了计算分支 → `WARN_NO_TOTAL`)。容量判定路径行为不变
- [x] 2.2 `consistency.ts`:`checkConsistency` 硬编 `toMl(unitSize)`/`toMl(totalAmount)` 改为**按轴**选 `toMl`/`toGrams`(同轴比较);跨轴 → `'skipped'`。**重量满规格自洽品须判 `'consistent'`、可上高档**(不得因换 `toGrams` 而退为 skipped);容量比较路径(`toMl`)逐字节不变
- [x] 2.3 `calculator.ts`:新增 `axisOf(spec)`(优先 `totalAmount.unit`、缺则 `unitSize.unit`;`isVolumeUnit→'volume'`、`isWeightUnit→'weight'`、其它/缺失→`null`,单一来源定轴防跨轴);把 per100ml 路径**参数化抽公因子** `(toBase, isAxisUnit, per100Key, baseLabel)`;formula 渲染/置信度分档共用泛化实现。**容量分支(`toMl`/`per100ml`)输出与重构前逐字节等同**(既有 ml 测试零回退是硬锚)
- [x] 2.4 `'weight'` 轴产出 `per100g = price/totalG*100` + 同构 formula(展开 `<price>/(<unitSizeG>*<quantity>*<multiplier>)*100`、收缩 `<price>/<totalG>*100`),`per100ml=null`;`'volume'` 轴 `per100g=null`(不变量:`per100ml`/`per100g` 恰一非空)
- [x] 2.5 不可计算终态:`per100ml=per100g=null` + 无 formula + warning + 低置信;无轴(无 size/未知单位)、总量≤0、price≤0、不一致均走此终态。删除「重量无条件 `WARN_NON_VOLUME`」逻辑(重量改为可算轴)

## 3. tier1 单件推断 + total 派生扩到重量（packages/core + apps/api，两处独立门）

- [x] 3.1 `parser.ts` **单件推断守卫**(`parser.ts:229`):`isVolumeUnit(unitSize.unit)` → `|| isWeightUnit(unitSize.unit)`。单件重量品 `quantity=1`、warning「数量按单件推断为 1」照旧
- [x] 3.2 `parser.ts` **`totalAmount` 派生块**(`parser.ts:246`,**独立的第二个 `isVolumeUnit` 门**):`if (unitSize && quantity!==null && isVolumeUnit(unitSize.unit))` → `|| isWeightUnit`。**不改此块 → 单件/多包装重量品 `totalAmount=null`**(4.1/4.2 断言不可达)。`totalAmount` 沿用 g/kg、不跨档
- [x] 3.3 `apps/api/src/orchestrate.ts:56` `mergeSpecs` 的 total 兜底派生硬编 `isVolumeUnit` → 扩到重量(tier2 补出 unitSize+quantity 重量品的合并完整性)
- [x] 3.4 `orchestrate.ts:98` `tier1YieldsDeterminate`:重量品仍判「tier1 定论 → 跳过 tier2」(结果安全),但判据/注释(line 92-96「non-volume→certain null」、line 103-104 非容量分支)同步为「重量→定论(可算 per100g 或确定 null)」;**line 108 的 derivable-but-non-positive 守卫**(`isVolumeUnit(u.unit) && (u.value<=0||quantity<=0)`)亦扩重量等价分支,保持「tier1 重量定论即跳过 tier2」注释自洽。避免归档后语义陈旧
- [x] 3.5 确认不影响容量单件推断既有行为(`isVolumeUnit` 分支逐字节不变)、不波及含量 token 剥离(`hasQuantitySignal` 与轴无关)

## 4. packages/core 单测（脏标题样本集，验收锚点）

- [x] 4.1 单件重量品 `水蜜黄桃2kg`(价 45)→ `quantity=1`/`totalAmount={2,kg}`/`per100g=45/2000*100=2.25`/`per100ml=null`;附「单件推断」warning
- [x] 4.2 多包装重量品 `MM 有机玉米汁 300g*24`(价 60)→ `quantity=24`/`total={7200,g}`/`per100g=60/7200*100≈0.833`/`per100ml=null`(乘号抽取、不进单件推断)
- [x] 4.3 `g×N` 写法 `樱桃番茄NFC复合果蔬汁 270gx15`(价 X)→ `quantity=15`/`total={4050,g}`/`per100g` 非 null
- [x] 4.4 `kg` 单件 `妃子笑荔枝 2.5kg`(价 50)→ `quantity=1`/`total={2.5,kg}`/`per100g=50/2500*100=2`/`per100ml=null`(单件推断;干净 kg 单件、无游离件数)
- [x] 4.5 formula 留痕:重量展开式 `60/(300*24*1)*100`、收缩式与 kg 换算 `45/(2000*1*1)*100`(g 基准、禁止用未换算字面 `2`)
- [x] 4.6 轴互斥不变量:任一可算商品 `per100ml`/`per100g` 恰一非空;断言重量品 `per100ml===null`、容量品 `per100g===null`
- [x] 4.7 **容量回归(零误伤)**:`矿泉水 4L`→`per100ml` 不变/`per100g=null`、`啤酒 500ml*12`→per100ml 不变、`葡萄酒 750mL`→per100ml 不变、`330ml*24听`→per100ml 不变;既有 ml 展开/收缩 formula 全不变
- [x] 4.8 不可算残留:无 size(`现泡黑咖啡 15瓶`)、裸编号(`埃德华兹900 750mL`)、**件数游离数字 `MM 精选鲜鸡蛋 1.59kg(30枚)`(`枚` 不在包装单位集、`30` 作游离数字抑制单件推断,同裸编号类)** 仍 `per100ml=per100g=null`;价≤0 走终态
- [x] 4.9 **重量满规格自洽品上高档**(pin `consistency.ts` 重量分支):`unitSize=300g`/`quantity=24`/`totalAmount=7200g`(自洽)→ `checkConsistency='consistent'`、`confidence≥0.9`(与容量满规格同档,**断言 confidence 值**,防重量品被错降为 skipped/中档)
- [x] 4.10 **重量不一致抑制单价**:`unitSize=300g`/`quantity=24`/`totalAmount=3600g`(不自洽)→ `per100g=null`、低置信 + 不一致 warning
- [x] 4.11 `pnpm --filter @unit-price/core test` 全绿(既有样本零回退)

## 5. persistence（packages/db + apps/api）

- [x] 5.1 `packages/db/src/schema.ts`:`unit_price` 表加 `per100g` REAL 可空列 + 数值排序索引(对称 `per100ml` 索引);`drizzle-kit generate` 产出可复现 sqlite 迁移(新增可空列、不破既有行)
- [x] 5.2 `packages/db/src/repository.ts` `CalcResultGate.superRefine`:把 `(per100ml===null)!==(formula===null)` 门推广为「`formula` 非空 ⟺ `per100ml`/`per100g` 之一非空」+ `per100g` 非空须 `Number.isFinite` + 两轴禁同时非空。**不改此门 → 重量可算结果 `{per100ml:null,per100g:非空,formula:非空}` 被旧门误判非法、`saveParsed` 抛错**
- [x] 5.3 `saveParsed`(写路径)落 `per100g`;`CalcResult` 拆校验过 `UnitPriceSchema`(已含 `per100g`)+ 推广后的 `CalcResultGate`;读出经 Zod 再校验
- [x] 5.4 `packages/db` 单测:重量品落库 `per100g` 非空/`per100ml` NULL、容量品反之、不可算两列均 NULL;**重量可算结果不被 `CalcResultGate` 拒写**(回归 5.2);`pnpm --filter @unit-price/db test` 全绿
- [x] 5.5 `apps/api` 测试:`POST /parse` 重量品(`2kg` 价 45)端到端 → `200`/`per100g=2.25`/`per100ml=null`;`saveParsed` 重量品落 `per100g`;鸡蛋(30枚)→ 200/两轴 null;`pnpm --filter @unit-price/api test` 全绿

## 6. eval 样本（防漂移，非验收）

- [x] 6.1 把 `水蜜桃2kg`、`玉米汁300g*24`、`鸡蛋1.59kg` 加进 `packages/eval` corpus(含重量轴 ground-truth `expected`,字段含 `per100g`)
- [x] 6.2 确认 `pnpm --filter @unit-price/eval test` 仍绿(纯追加)

## 7. 收尾

- [x] 7.1 `pnpm -r test` + `pnpm -r build` 全绿
- [x] 7.2 `openspec-cn validate add-weight-axis-unit-price --strict` 通过
