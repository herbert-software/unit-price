## 为什么

生产库 129 个商品中 30 条不可算(`per100ml = null`),抽查归类后 **26 条(87%)是按重量(g/kg)定价的生鲜/食品**——水蜜桃 2kg、鲜鸡蛋 1.59kg(30枚)、樱桃番茄果蔬汁 270g×15、有机玉米汁 300g×24 等。tier1 **已正确抽出 g/kg 的 `unitSize`**,但 `unit-price-calc` 仅支持容量单位,把重量单位统一路由到不可计算终态(warning「本次仅支持容量单位的饮料」)。

这不是脏标题问题(无需 LLM),而是**缺一条确定性的重量计价轴**。这些商品在重量轴内完全可比(¥/100g),却因系统只有容量轴而全部落空。补上重量轴是当前转化率最高的一期——一次把最大的「不可算」桶(87%)的绝大多数变为可比(其中**件数游离数字**如 `鸡蛋 1.59kg(30枚)` 的 `30` 仍按既有残留规则留 `null`,约 25 条转化)。

## 变更内容

- **新增「每 100g 重量轴单价」`per100g`**:当商品的总量单位 ∈ `{g, kg}` 时,确定性计算 `per100g = price / totalGrams * 100`(`kg→g` 在 calculator 内换算,`1kg = 1000g`),产出可回放 `formula`。一个商品**只在一条轴上可算**(体积 XOR 重量,由 size 单位决定);容量商品 `per100ml` 行为完全不变。
- **单件推断扩展到重量单位**:tier1 的「孤立 size 单件视为数量 1」推断当前仅对容量单位生效;扩展到重量单位,使「水蜜桃 2kg」这类单件按重量品推断 `quantity = 1`、`totalAmount = size`(沿用 g/kg、不在 parsing 阶段做 g↔kg 跨档,与现有 ml/L 处理一致)。多包装重量品(`270g×15`、`300g×24`)的数量抽取本已工作,只是此前被 calculator 的容量门挡下。
- **分轴比价、绝不跨轴**:`per-100ml` 饮料与 `per-100g` 食品在不同物理轴上,**不互转、不互比**(符合「不追求万物可比」)。展示与排序按轴分组。
- **schema 与 persistence**:`UnitPrice` 增 `per100g`(可空);`unit_price` 表加 `per100g` REAL 列(可空);`per100ml` 与 `per100g` **恰一个非空**表达该商品所属轴(都为空 = 两轴皆不可算)。迁移为新增可空列,不破既有行。

## 功能 (Capabilities)

### 新增功能
<!-- 无新建 capability;作为现有 parsing/calc/persistence 能力的增量修改 -->

### 修改功能
- `unit-price-calc`: 从「仅每 100ml」泛化为「**按总量单位分派:容量轴 `per100ml` XOR 重量轴 `per100g`**」。可计算条件、canonical formula、不可计算终态、**规格一致性校验(按轴换算基准单位)** 均推广到重量轴;重量单位不再无条件走不可计算终态,而是产出 `per100g`。
- `spec-parsing`: ①「孤立容量单件视为数量 1」推广为「**孤立容量/重量单件视为数量 1**」(ADDED 重量需求,不动容量行为);②「字段分层定义」计算必需集扩展为「`∈ {ml,L}` 容量轴 或 `∈ {g,kg}` 重量轴」;③「从标题与价格解析结构化规格」需求里「重量单位仅识别不计算、一律走不可计算终态」的陈旧表述改为「重量参与重量轴 `per100g` 计算」。
- `persistence`: `unit_price` 表加 `per100g` 可空 REAL 列;写路径(`saveParsed`)落 `per100g`;`per100ml`/`per100g` 恰一非空表达轴归属;**`CalcResultGate` 落库校验门**从「`per100ml⟺formula`」推广为「`formula` 非空 ⟺ 两轴之一非空」(否则重量可算结果被拒写)。
- `parse-api`: HTTP 状态语义里「裸 `2kg` = 确定不可计算」的示例与场景更新为「`2kg` 走重量轴算 `per100g`(确定结论、200)」;「确定不可计算但 tier1 有字段→200」改用 `鸡蛋 1.59kg(30枚)` 残留例。5xx/200 边界本身**不变**(重量 tier1 有字段→确定结论→200)。

## 影响

- **代码**(横向扇出确认的全部容量门):`packages/core` —— `units.ts`(`isWeightUnit` + `toGrams`)、`tiers.ts`(`meetsComputeRequiredSet`/`hasUsableTotalAmount` 按轴)、`consistency.ts`(`checkConsistency` 按轴换算)、`calculator.ts`(`axisOf` 分派 + 公因子)、`parser.ts`(**两处** `isVolumeUnit` 门:单件推断守卫 + `totalAmount` 派生块)、`types.ts`(`UnitPriceSchema` 加 `per100g`);`packages/db`(`unit_price.per100g` 列 + 迁移 + `repository.ts` `CalcResultGate` 门推广);`apps/api`(`orchestrate.ts` `mergeSpecs` 派生 + `tier1YieldsDeterminate` 语义同步、`saveParsed` 落列);`packages/core`/`packages/eval` 测试样本。
- **数据**:新增可空列、不破既有行;parser+calc 上线后,新采集的重量品按 `(store,storeSku)` upsert 覆盖、补算 `per100g`;历史重量类假 null 行随重采刷新。
- **不触碰**:tier2 LLM、去重收敛逻辑(`dedupeKey`,与单价轴正交)、ingest 写路径主流程(仅加列与计算分派)。
- **合规面**:无(纯确定性计价准确率)。
- **非目标 / 已知边界**:① **绝不做密度换算**(g↔ml):水以外 `1g ≠ 1ml`,两轴永久独立、不互转不互比。② **不做「每枚/每个」件单价**(鸡蛋 30 枚、按个卖的水果)——件单价是第三条轴,留后续;本期重量品一律按 g/kg 算 per100g,忽略件数。③ 不重写 tier1 正则(g/kg size 已能抽);裸编号、**件数游离数字**(如 `鸡蛋 1.59kg(30枚)` 的 `30`——`枚` 不在包装单位集、`30` 作游离数字抑制单件推断)、标题完全无 size 者仍 `null`(已知残留,与容量轴 `hasQuantitySignal` 同口径,本期不修)。
