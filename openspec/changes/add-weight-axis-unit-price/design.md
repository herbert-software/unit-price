## 上下文

现状(读源码):
- `units.ts` 已定义 `WEIGHT_UNITS = {g, kg}`、`TO_BASE`(`g:1, kg:1000`)、`isVolumeUnit`、`toMl`(对非容量返回 `null`)。**重量单位「只识别、不计算」**——别名(`克→g`、`千克/公斤→kg`、`斤→500g`)已归一,但从不进单价。
- `calculator.ts`:`calculate(spec, price)` 先 price guard,再判 `totalAmount`/`unitSize` 是否容量;**非容量一律 `uncomputable(WARN_NON_VOLUME)`**。可计算时 `per100ml = price / totalMl * 100` + canonical formula,有一致性 gate 与置信度分档。
- `types.ts`:`UnitPriceSchema = { per100ml: number|null, formula: string|null }`。
- `parser.ts` 单件推断守卫:`quantity===null && unitSize!==null && isVolumeUnit(unitSize.unit)` —— **仅容量**触发,故单件重量品(`2kg`)`quantity` 留 `null`。

即:重量品的 size 已被正确抽取,缺的只是「放开 calculator 的容量门 + 单件推断扩到重量 + 加 per100g 字段/列」。

## 目标 / 非目标

**目标:** 总量单位 ∈ `{g,kg}` 的商品算出 `per100g = price / totalGrams * 100`(可回放 formula),与 `per100ml` 并列;单件重量品推断 `quantity=1`;容量商品行为**逐字节不变**;分轴比价、绝不跨轴。

**非目标:** ① 密度换算(g↔ml)——永久不做,两轴独立。② 件单价(每枚/每个)——本期重量品按 g/kg 算,忽略件数(鸡蛋 30 枚按 1.59kg 算 per100g)。③ 重写 tier1 正则。④ 改 tier2/去重/ingest 写路径主流程。

## 决策

**D1:`units.ts` 加 `isWeightUnit` + `toGrams`,镜像现有 `isVolumeUnit`/`toMl`。**
`isWeightUnit(unit) = WEIGHT_UNITS.has(unit)`;`toGrams(m)`:`isWeightUnit` 才转(`m.value * TO_BASE[m.unit]`),否则 `null`——与 `toMl` 对称。换算表 `TO_BASE` 已就绪(`kg:1000`),不新增常量。

**D2:`calculator.ts` 按「轴」分派,而非无条件拒绝重量。**
新增内部 `axisOf(spec)`:由**单一来源**定轴——优先 `totalAmount.unit`,缺则 `unitSize.unit`;`isVolumeUnit→'volume'`、`isWeightUnit→'weight'`、其它→`null`。
- `'volume'`:走**现有 per100ml 全路径,不改一行逻辑**(compute-required / 一致性 gate / formula / 置信度照旧),`per100g = null`。
- `'weight'`:镜像同一套——compute-required 用 `toGrams`、一致性 gate 用克、`per100g = price / totalG * 100`、formula 同构(展开式 `<price> / (<unitSizeG> * <quantity> * <multiplier>) * 100`,收缩式 `<price> / <totalG> * 100`),`per100ml = null`。
- `null` 轴(无 size / 未知单位):`uncomputable`(两轴皆空)。
不变量:`per100ml` 与 `per100g` **至多一个非空**(`axisOf` 单值保证);都空 = 不可算终态。

**D2 落地方式:抽公因子,不复制两份。** 把现有 per100ml 路径参数化为 `(toBase, isAxisUnit, per100Key, baseLabel)`——容量 `(toMl, isVolumeUnit, 'per100ml', 'ml')`、重量 `(toGrams, isWeightUnit, 'per100g', 'g')`。formula 渲染、置信度分档共用同一泛化实现,只换换算函数与字段名。避免「两套近似逻辑漂移」。

**D2 的容量门不止在 `calculator.ts`——三处独立硬编 `isVolumeUnit`/`toMl` 都必须按轴泛化**(横向扇出确认,缺一则重量品根本进不了计算分支):
- **`tiers.ts`**:`hasUsableTotalAmount`、`meetsComputeRequiredSet` 硬编 `isVolumeUnit(t.unit)`/`isVolumeUnit(u.unit)`——这是「计算必需集」的**唯一实现**,不泛化则 `meetsComputeRequiredSet` 对重量返 false → `WARN_NO_TOTAL` 终态。改为「`totalAmount.unit` 落在 `{ml,L}` **或** `{g,kg}` 任一轴且 base>0」。
- **`consistency.ts`**:`checkConsistency` 硬编 `toMl(unitSize)`/`toMl(totalAmount)`,重量 → 双 `null` → `'skipped'` → 永不进高档。改为按轴选 `toMl`/`toGrams`(同轴);跨轴仍 `'skipped'`(D2 单一来源轴保证不跨轴构造等式)。**重量满规格自洽品须与容量同样判 `'consistent'`、可上高档**(否则分档系统性偏低、与「镜像同一套」声称不符)。
- **`calculator.ts`**:`axisOf` 分派 + 删除「非容量无条件 `WARN_NON_VOLUME`」。
统一改法:`tiers`/`consistency`/`calculator` 都接受注入的 `toBase`+`isAxisUnit`(或内部按 `axisOf` 选),容量分支调用路径(`toMl`/`isVolumeUnit`)**输出逐字节不变**(既有 ml 测试零回退是硬锚)。

**D3:`parser.ts` 的**两处**容量门都扩到重量(横向扇出确认是两个独立 block)。**
- **单件推断守卫**(`parser.ts:229`):`isVolumeUnit(unitSize.unit)` → `isVolumeUnit(unitSize.unit) || isWeightUnit(unitSize.unit)`。单件重量品 `quantity=1`。
- **`totalAmount` 派生块**(`parser.ts:246`,**独立的第二个 `isVolumeUnit` 门**):`if (unitSize && quantity!==null && isVolumeUnit(unitSize.unit)) totalAmount = ...` 同样扩到 `|| isWeightUnit`。**只改单件守卫、不改派生块,会让单件重量品 `quantity=1` 但 `totalAmount=null`**(多包装重量品 `300g*24` 亦然 total=null)→ tasks 4.1/4.2 断言的 `totalAmount` 不可达。两门必须同步扩。
`totalAmount=unitSize`(沿用 g/kg,不在 parsing 阶段 g↔kg 跨档,与 ml/L 一致)。`hasQuantitySignal` 含量剥离判据与轴无关、不变(`度/%vol` 仅出现在酒类容量品)。**`orchestrate.ts:56` `mergeSpecs` 的 total 派生(tier1+tier2 合并后兜底)亦硬编 `isVolumeUnit`,须同步扩到重量**——否则 tier2 补出 unitSize+quantity 的重量品在合并层不派生 total(tier1 自身派生已由上述 parser 派生块覆盖,此为 tier2 补缺路径的完整性)。

**D4:schema + persistence 加 `per100g`。**
`UnitPriceSchema` 加 `per100g: z.number().nullable()`(types 从中推导,API 校验/客户端共用)。`unit_price` 表加 `per100g` REAL 可空列 + Drizzle 迁移(新增可空列、不破既有行)。`saveParsed` 落 `per100g`。轴判别 = `per100ml`/`per100g` 恰一非空(查询/展示据此分组)。`unit_price_per100ml_idx` 之外可加 `per100g` 排序索引(对称)。

**D5:展示/排序分轴分组。** 体积轴按 `per100ml` 升序、重量轴按 `per100g` 升序,**永不混排**。本提案定语义;具体客户端展示属各客户端能力,不在 core 范围内强约束,但 `comparable` 的轴维度由「同轴才可比」界定。

**D6:`repository.ts` 的 `CalcResultGate` 落库校验门必须按轴推广(横向扇出确认)。**
现 `CalcResultGate.superRefine`(`repository.ts:81`)断言 `(per100ml===null) !== (formula===null)`——即 `per100ml` 与 `formula` 同空同设。重量可算结果 `{per100ml:null, per100g:2.25, formula:"..."}` 会命中:`per100ml===null` 真、`formula===null` 假 → 校验失败 → **每个重量品 `saveParsed` 抛错**。改为:`formula` 非空 **当且仅当** `per100ml`/`per100g` 之一非空;`per100g` 非空须 `Number.isFinite`;`per100ml`/`per100g` 禁同时非空。这是 D4 schema 改动在**写校验层**的必配套(只加列、不改门 = 写不进)。

**D7:`orchestrate.ts` tier2 跳过语义同步(行为安全、注释/归因须更新)。**
`tier1YieldsDeterminate`(`orchestrate.ts:98`)现以 `非容量单位 → certain null` 判「tier1 已定论、跳过 tier2」。改后重量可算,但 tier1 对重量品**仍是定论**(算出 `per100g` 或确定 `null` 如鸡蛋残留)→ 跳过 tier2 的**结果仍正确**(tier2 改不动确定性重量结论)。故 return 值不变、行为安全;但判据从「非容量→null」改为「重量→定论(可算 per100g 或确定 null)」、相关注释(line 92-96「non-volume → certain null」)须同步,避免归档后语义陈旧误导。`parse-api` 的 5xx/200 边界因此**不变**(重量 tier1 有字段 → 确定结论 → 200,与既有一致)。

## 风险 / 权衡

- **[R1 跨轴泄漏]** 若某标题 `unitSize` 是容量、`totalAmount` 是重量(或反之),`axisOf` 以**单一来源**(优先 totalAmount)定轴,避免两半混算;一致性 gate 在同轴内做等式校验,跨轴构造不出等式 → 走缺项/不一致终态。实测山姆数据未见混轴标题,属防御。
- **[R2 容量回归]** `'volume'` 分支复用现有实现、不改逻辑,既有 ml 测试零回退是硬验收(矿泉水/啤酒/葡萄酒 per100ml 不变)。泛化抽公因子时以「容量分支输出逐字节等同重构前」为锚。
- **[R3 件数被忽略]** 鸡蛋 1.59kg(30枚)按重量算 per100g(忽略 30 枚)——这是**有意**:重量轴对「按重量卖」语义正确;件单价是后续独立轴。已在非目标声明。
- **[R4 `斤` 等别名]** `1斤=500g` 已在 `normalizeMeasurement` 归一为 g,重量轴自然纳入,无需额外处理。
- **[R5 两轴都不可算 / 件数游离数字残留]** 标题完全无 size(`现泡黑咖啡 15瓶`)、裸编号(`埃德华兹900`)、**件数游离数字**(`鸡蛋 1.59kg(30枚)` 的 `30`——`枚` 不在包装单位集 `瓶/罐/支/盒/袋/听/提/箱` 内,`30` 落游离数字 → `hasQuantitySignal=true` → 抑制单件推断 → `quantity=null`)仍 `per100ml=per100g=null` + warning。这是容量轴 `hasQuantitySignal` 残留规则在重量轴的**对称继承**(单件推断扩到重量、但判据不变),本提案不改、与既有终态一致。已用 node 探针对真实 parser 实测:`水蜜桃2kg`/`西瓜4.5kg`/`荔枝2.5kg`/`苹果2.7kg` 等干净单件触发推断,`鸡蛋1.59kg(30枚)` 因 `30` 留 null。
