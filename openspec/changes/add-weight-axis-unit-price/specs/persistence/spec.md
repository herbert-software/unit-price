## 修改需求

### 需求:unit_price 必须存计算结果并保留可空与留痕

`unit_price` **必须**关联 `product` 存 **`CalcResult`(calculator 输出)**:嵌套单价 `per100ml`(可空 `REAL`)/`per100g`(可空 `REAL`)/`formula`(可空 `TEXT` 公式留痕)对齐 `UnitPrice`,加 `CalcResult` 的 `confidence`(**最终权威置信 band**,`REAL`,与 `product.confidence` 的解析置信是不同的值)与 `warnings`(JSON-text 数组)。`per100ml`/`per100g` **必须从 core 的 `CalcResult` 输出直存**,**禁止**在 repo 层用库内整数分 `price` 重算(core 从原始元价算出,重算会引入单位/精度错)。`per100ml` 与 `per100g` 表达商品所属**轴**:容量轴 `per100ml` 非空、重量轴 `per100g` 非空,二者**恰一非空**(都为 NULL = 该商品确定不可计算)、**禁止**两列同时非空(一个商品至多一条轴)。落库前的 `CalcResult` 校验门(`repository.ts` 的 `CalcResultGate`)**必须**把既有「`per100ml` 与 `formula` 同空同设」不变量推广为:**`formula` 非空 当且仅当 `per100ml`/`per100g` 之一非空**(可算→该轴单价与 `formula` 同设、另一轴 NULL;不可算→`per100ml`/`per100g`/`formula` 三者全 NULL),且 `per100g` 非空时**必须**有限(`Number.isFinite`,禁 `NaN`/`Infinity`)、`per100ml`/`per100g` **禁止**同时非空。**禁止**沿用仅校验 `per100ml⟺formula` 的旧门(会把重量可算结果`{per100ml:null, per100g:非空, formula:非空}`误判为非法而拒写)。`formula` 是 core 原样留痕、内嵌**元**价(如 `"39.9 / 660 * 100"`),自包含、可独立回放;它与 `price` 列的整数分口径差 `price/100`(回放用 formula 串本身,不代入 price 列);两套金额(formula 内元价 vs price 列分值)**各自独立留痕、不做跨表交叉校验**。「确定不可计算」**必须**以 `per100ml = per100g = NULL` 表达(禁止用 0 或缺行冒充)。`per100ml`/`per100g` 列**必须**可被索引/数值排序(支撑未来分轴榜单查询;`REAL` 数值排序而非字典序)。

#### 场景:容量轴可算商品

- **当** core 算出 `per100ml` 与 `formula`(容量轴)
- **那么** 落 `unit_price` 一行,`per100ml`/`formula` 非空、`per100g` 为 NULL,confidence/warnings 一并存

#### 场景:重量轴可算商品

- **当** core 算出 `per100g` 与 `formula`(重量轴,如 `水蜜桃 2kg`)
- **那么** 落 `unit_price` 一行,`per100g`/`formula` 非空、`per100ml` 为 NULL,confidence/warnings 一并存

#### 场景:确定不可计算

- **当** core 判定 `per100ml = per100g = null`(如价格≤0、无 size 或未知单位)
- **那么** `unit_price.per100ml` 与 `per100g` 列均为 NULL、`formula` 为 NULL,**禁止**写成 0
