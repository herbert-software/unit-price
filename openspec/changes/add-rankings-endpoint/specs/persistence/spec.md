## 新增需求

### 需求:repository 必须提供 listRankings 只读榜单查询契约

`@unit-price/db` 的 repository **必须**新增只读方法 `listRankings({ limit, offset, category })`，为榜单消费（`rankings-api` 的 `GET /rankings`）提供按可比单价升序的分页查询。该方法是既有「至少 `upsertRaw`/`saveParsed`/`getProduct`/`saveCorrection`」契约的**扩充**（既有方法语义不变）。

**只读与不重算**：`listRankings` **必须只读**——禁止写库、禁止触发解析/计算。投影中的 `per100ml`、`formula`、`confidence`、`warnings` **必须直接取 `unit_price` 已存储列**，**禁止**在读路径用库内整数分 `price` 重算（与既有「`per100ml` 必须从 `CalcResult` 直存、禁止 repo 重算」同口径，保证留痕一致）。

**入榜过滤与轴**：**必须**以 `WHERE unit_price.per100ml IS NOT NULL` 过滤（容量轴单轴）；`per100ml` 为 NULL 的行（重量轴 per100g-only 项、确定不可计算项）**必须排除**。这是 v1 **唯一**的入榜判据（对齐 rankings-api「禁止改用 category 字段判定」）。`category` 参数**本期不下推到 SQL 谓词**：`product.category` 恒 `beverage`，下推是 no-op 且**经实测会令 SQLite 规划器改以 `product` 为驱动表 + `USE TEMP B-TREE FOR ORDER BY`、弃用 `unit_price_per100ml_idx`**（见排序与索引段）；故 v1 仅在 **API 层**校验 `category=beverage`（非法→400），`listRankings` **不**按 category 过滤（结果与下推等价，因全为 beverage）。`category` 入参保留为 v2 真品类预留——届时下推谓词并配套复合索引（如 `(category, per100ml, id)`）。

**排序与索引**：**必须**按 `unit_price.per100ml` 升序为主排序键，**`unit_price.id` 升序为次级排序键**（同表列，保证同值分页确定、稳定；`unit_price.id` 为 TEXT 主键、`ASC` 即字典序，对固定快照构成确定全序）；**禁用**跨表 `product.id` 作 tiebreak（不与 `per100ml` 同表、无法被 per100ml 索引覆盖）。主排序**必须能走** `unit_price` 上 `per100ml` 的数值升序索引 `unit_price_per100ml_idx`（REAL 数值序、非字典序）满足主序与 `per100ml IS NOT NULL` 过滤，**禁止全表扫描后把全量行取入应用内存排序**；二级键 `unit_price.id` 不在该单列索引内，引擎可能对其做一次轻量临时排序——**可接受**（主序与过滤仍由索引承担，非全表内存排序）。**实测前提**：要让规划器以 `unit_price` 为驱动表、命中 `unit_price_per100ml_idx`，查询**必须不含** `product.category` 等值谓词（该谓词会使规划器改以 `product` 驱动并放弃该索引，见入榜过滤段）——这正是 v1 不下推 category 的索引收益。如未来同值段巨大需完全索引覆盖、或 v2 引入 category 下推，可增 `(per100ml, id)` 或 `(category, per100ml, id)` 复合索引，非 v1 必需。

**投影形状与校验口径**：`listRankings` 返回的是一个**反规范化只读投影**（join `unit_price ⋈ product ⋈ product_raw` 后取展示列：来自 `unit_price` 的 `per100ml`/`formula`/`confidence`/`warnings`、来自 `product_raw` 的 `title`/`price`(整数分)/`store`/`store_sku`/`source_url`），**不是**领域对象（`ParsedSpec`/`CalcResult`）。故既有「`getProduct` 读出对象必须经 Zod 再校验」是对**领域对象读取**的要求；榜单投影的契约校验由消费端 `rankings-api` 的 `RankingsResponseSchema` 在 API 层承担。**本 ADDED 需求不修改**既有「数据访问层必须提供类型化契约且配置缺失时显式失败」需求——其中「读出对象必须经 Zod 再校验」对领域对象读取（`getProduct`/`saveCorrection` 等）**仍完全有效**；`listRankings` 是新增的**非领域投影**方法、其校验落在 API 层，与既有需求**并存不冲突**（故用 ADDED 而非 MODIFIED）。`confidence` **必须**取 `unit_price.confidence`（最终权威 band）、**禁止**误取 `product.confidence`（解析中间值）——二者同名异义、SQL 投影必须显式限定 `unit_price.confidence`。`warnings` 以 JSON-text 存储，投影**必须**经 `decodeJson`（`encodeJson` 的对称解码、`packages/db` 既有 codec）还原、并以 `WarningsSchema` 校验为 `string[]`（`decodeJson` 返回 `unknown`，故 `string[]` 的类型保证由该校验闭合），**禁止**把原始 JSON 串透出——否则到 API 层 `RankingsResponseSchema` 的 `warnings: string[]` 会因拿到 string 而校验失败。**损坏列 fail-closed**：若某行 `warnings` 列损坏（非法 JSON 或非 `string[]`），`decodeJson`/`WarningsSchema` 校验失败必须**抛错**（致 `listRankings` 整体抛 → handler 映射 `500`），**禁止**透出原始串、**禁止**静默丢该行或返回部分结果。此为**不可达路径**（写路径 `encodeJson` + `CalcResultGate` 已在落库时校验 warnings），但契约要求 fail-closed（与项目「显式失败、禁止静默落/出脏数据」一致），并应有回归测试锁定该行为。

#### 场景:按 per100ml 升序分页且排除 null

- **当** 调用 `listRankings({ limit: 50, offset: 0, category: 'beverage' })`，库中含若干 `per100ml` 非空行与若干 `per100ml = NULL` 行
- **那么** **必须**只返回 `per100ml` 非空的行、按 `per100ml` 升序、同值按 `unit_price.id` 升序，切片 `[offset, offset+limit)`；`per100ml = NULL` 行（含 per100g-only 重量品）**必须不出现**

#### 场景:per100ml/formula/confidence 取存储值不重算且 confidence 取权威列

- **当** 某行 `unit_price.per100ml = 0.505`、`formula = "40 / (330 * 24 * 1) * 100"`、`unit_price.confidence = 0.95`，而其 `product.confidence`（解析中间值）= `0.5`
- **那么** 投影行的 `per100ml`/`formula` **必须**等于 `unit_price` 存储值（未重算），`confidence` **必须**等于 `0.95`（`unit_price.confidence`），**禁止**返回 `0.5`（`product.confidence`）

#### 场景:同 per100ml 分页稳定走索引

- **当** 多行 `per100ml` 相同，分两次 `listRankings`（`offset=0` 与 `offset=N`，limit=N，**两次间数据不变**）
- **那么** 两次结果**必须**按 `unit_price.id` 升序不重叠不遗漏地覆盖这些同值行；查询的主排序**必须可走** `unit_price_per100ml_idx`、不对全量结果做内存排序
