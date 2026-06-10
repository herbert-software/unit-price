## 新增需求

### 需求:schema 必须以 core 领域类型为单一事实源

`@unit-price/db` 落库的**领域字段必须**与 `@unit-price/core` 的 `RawProduct` / `ParsedSpec` / `CalcResult`(calculator 输出)字段**同名同义、无丢失**;各表可加**显式溯源/外键/时间戳增列**(`store`/`source`/`captured_at`/`raw_id` 等),这些**不属**领域类型、**必须**与领域列区分标注(不得用增列冒充领域字段,也**不得反过来声称表与领域类型「一一对应」**——表是领域字段的超集)。落库前**必须**用 core **已导出**的 Zod schema 校验领域部分:`RawProductSchema` / `ParsedSpecSchema` / 嵌套单价 `UnitPriceSchema` / `WarningsSchema`;`CalcResult` 在 core **无导出 schema**,其 `confidence` 按 `z.number().min(0).max(1)`、`warnings` 按 `WarningsSchema`、嵌套 `unitPrice` 按 `UnitPriceSchema` 校验。校验失败**必须**拒绝写入并抛出带字段路径的错误(禁止静默落脏数据)。Zod 校验始终对**领域对象**(解码后),而非对存储编码后的 JSON 串。`Measurement`(value+unit)**必须**拆成可查询的两列(`unit_size_value` REAL / `unit_size_unit` TEXT)。`multipliers` 与 `warnings` 数组**必须**以 **JSON-text(`TEXT` 列存 JSON 串)** 存储(**禁用**原生数组/jsonb,见可移植类型需求)、内容可无损往返(含空数组);两者**均为 `NOT NULL` 列**——`multipliers` 因 core 侧 `.default([1])`、`warnings` 因 `CalcResult.warnings` 恒非 null 数组且 `WarningsSchema` 拒 null,故都无可空态、**不引入「`[]` vs NULL」区分**(空数组存 JSON 串 `"[]"`)。`ParsedSpec` 的可选+可空字段(`unitSize`/`totalAmount`/`quantity`/`packageUnit`)落库时 `undefined`(字段缺失)与 `null` **均归一为列 NULL**;往返「相等」按此归一判定(读回为 `null`,与写入的 `undefined`-或-`null` 语义等价)。

#### 场景:Zod 校验通过则落库
- **当** repository 收到一个通过 `ParsedSpecSchema` 校验的对象
- **那么** 写入对应表,各字段按列映射,measurement 拆为 value/unit 两列,读回后能无损重建为同一 `ParsedSpec`(可选字段的 `undefined`/`null` 归一为 NULL,见上)

#### 场景:Zod 校验失败则拒写
- **当** 传入对象不满足 core schema(如 confidence 越界、unit 非法)
- **那么** repository **必须**抛出带字段路径的错误、**禁止**写入任何行

#### 场景:数组列无损往返
- **当** 落库 `multipliers=[1,2]`(用例仅验列往返能力,非 core 本期产值——本期恒 `[1]`)与 `warnings=[]`(均 NOT NULL)再读回
- **那么** 读回值内容与写入**严格相等**(空数组照常往返为空数组),两列均无 NULL 态

### 需求:schema 必须用 SQLite↔Postgres 可移植类型

引擎为 **Cloudflare D1(SQLite)**。schema **禁止**使用 Postgres-only 类型(原生数组、`jsonb`、`serial`、`numeric`),只用在 SQLite 与 Postgres 上**语义等价**的类型,使日后撑爆 D1 时可平滑迁 Postgres(repository 契约 + core Zod SOT 不变,仅换方言包壳)。类型映射**必须**为:
- **主键/外键**:**app 生成的 `TEXT` id(UUID 或 ULID)**,**禁用** `serial`/自增整数 PK(自增 PK 在 SQLite=`INTEGER PK`、PG=`identity/serial`,不可移植;app 生成 TEXT id 两边等价,且契合多源众包 ingest 无需中心自增)。`raw_id`/`product_id` 等 FK 同为 `TEXT`。
- 数组/JSON 载荷(`multipliers`/`warnings`/`corrected_spec`)→ JSON-text(`TEXT`)。
- 金额(`price`)→ **整数分(`INTEGER`,精确)**;换算**必须**为 `分 = Math.round(元 × 100)`、`元 = 分 / 100`,**禁止** `trunc`/`floor`/`| 0`(JS 浮点 `0.29 × 100 = 28.9999…`,截断会得 28、少计 1 分,需 `Math.round` 得 29;`0.57`/`1.13`/`19.90` 同类。注:`39.90 × 100` 恰为精确 3990,不是 off-by-one 例)。
- 派生比值(`per100ml`)→ `REAL`;`confidence` → `REAL`;时间戳 → `INTEGER` epoch(或 ISO `TEXT`);`category`/`store`/`store_sku`/`*_unit`/`formula` → `TEXT`。
数组/JSON 与金额在 repository 工具层做 `JSON.parse`/`stringify` 与 `Math.round` 分↔元换算——这是**存储定标编码**、**非领域计算**;core 仍是价格/单位换算/可比的**唯一来源**,repo 不引入任何领域判断。

#### 场景:无 Postgres-only 类型
- **当** 检查生成的迁移 SQL / schema
- **那么** **禁止**出现原生数组列(`...[]`)、`jsonb`、`serial`、自增整数 PK、`numeric` 等 SQLite 不支持或非等价的类型;主键为 app 生成 `TEXT` id

#### 场景:金额换算钉死四舍五入(防 off-by-one)
- **当** 落库 `price = ¥0.29`(`0.29 × 100 = 28.9999…` 的浮点漂移值)
- **那么** **必须**经 `Math.round` 存为 **29 分**(而非截断得 28),读回 `0.29`;`¥0.57 → 57`(截断会得 56)同为判别例;`¥39.90 → 3990`(此值 trunc=round 恰精确,仅作 passthrough 断言)。**禁止**用 float 存金额或用截断换算

### 需求:product_raw 必须落地每次上报并按去重键收敛

`product_raw` **必须**存下每次抓取/录入的原始商品(`store`、`store_sku`、`title`、`price`、`category_hint`(可空,映射 `RawProduct.categoryHint`)、`source`、`source_url`、`captured_at`),作为 ingest 的落地表。去重键**必须**为 `(store, store_sku)`(确定性、与价格无关——价格变动算同款更新而非新行)。`store`/`store_sku` 是溯源增列、**不在** `RawProductSchema` 内,故 `upsertRaw` **必须额外**校验二者非空(空串/缺失即拒写)、且两列在 schema 中为 `NOT NULL`——否则空 `store_sku` 会让无 SKU 上报坍缩成一行、破坏键的确定性。`title`/`price` 属 `RawProductSchema` 必填(`z.string().min(1)`/`z.number()`),其列亦**必须**为 `NOT NULL`——使列约束与 core 非空事实源在 schema 层(而非仅 repository parse)闭合,旁路直写也不能落空 title/price。注:`RawProductSchema.price=z.number()` **放行 ≤0/负价**(正价约束属 core 计算层——负价/0 价由 core 路由到 per100ml=null,**非落库层**职责);`product_raw` 忠实存原始观察(含异常价),`price` 列只 `NOT NULL`、不强制正值。同键再次上报**必须** upsert(更新 `price`/`captured_at` 等而非堆叠重复行),保留 `captured_at` 以追溯最近一次观察。本表**禁止**做规格解析或单价计算(只存原始事实)。

#### 场景:同款商品重复上报
- **当** 同一 `(store, store_sku)` 的商品被上报两次
- **那么** `product_raw` 中只保留一行,`captured_at` 与价格更新为最近一次

#### 场景:原始表不含派生字段
- **当** 检查 `product_raw` 的列
- **那么** 其中**禁止**出现 `per100ml`、`unit_size` 等解析/计算派生字段(这些归 `product`/`unit_price`)

#### 场景:去重键字段为空则拒写
- **当** 上报的 `store` 或 `store_sku` 为空串/缺失
- **那么** `upsertRaw` **必须**拒写并抛错(禁止用空 `store_sku` 落库,以免坍缩破坏去重键确定性)

### 需求:product 必须存规范商品且预留品类扩展位

`product` **必须**由 `ParsedSpec` 派生落库(`unit_size_value`/`unit_size_unit`、`quantity`、`multipliers`、`total_amount_*`、`package_unit`、`category`、`confidence`),并**必须**经 `raw_id` 外键关联到产生它的 `product_raw` 行。此处 `confidence` 为 **`ParsedSpec.confidence`(解析置信,中间值)**,与 `unit_price` 的最终权威置信(见下需求)是**两个不同的值**、语义不同。本次 `category` **必须**保持为现有的自由 string(恒 `beverage`),**禁止**建 `tag`/`product_tag`/`store_category_map`/`category_closure` 表或品类外键(留给 `category-tagging`)、亦**禁止**建 `comparison_group` 表(改动态查询,见 taxonomy §九);可空字段**必须**用 nullable 列,使部分 tier1 命中能落库。

#### 场景:部分规格命中也能落库
- **当** 一个只命中 `unitSize`、`quantity` 为 null 的 `ParsedSpec` 落库
- **那么** 写入成功,`quantity` 列为 NULL,读回得到同一部分规格

#### 场景:product 关联其来源 raw
- **当** 落一个 `product`
- **那么** 其 `raw_id` **必须**指向真实存在的 `product_raw` 行,可经 product 取回原始上报

#### 场景:不引入品类表
- **当** 应用本次迁移后检查 schema
- **那么** 不存在 `tag` / `product_tag` / `store_category_map` / `category_closure` / `comparison_group` 表

### 需求:unit_price 必须存计算结果并保留可空与留痕

`unit_price` **必须**关联 `product` 存 **`CalcResult`(calculator 输出)**:嵌套单价 `per100ml`(可空 `REAL`)/`formula`(可空 `TEXT` 公式留痕)对齐 `UnitPrice`,加 `CalcResult` 的 `confidence`(**最终权威置信 band**,`REAL`,与 `product.confidence` 的解析置信是不同的值)与 `warnings`(JSON-text 数组)。`per100ml` **必须从 core 的 `CalcResult` 输出直存**,**禁止**在 repo 层用库内整数分 `price` 重算(core 从原始元价算出,重算会引入单位/精度错)。`formula` 是 core 原样留痕、内嵌**元**价(如 `"39.9 / 660 * 100"`),自包含、可独立回放;它与 `price` 列的整数分口径差 `price/100`(回放用 formula 串本身,不代入 price 列);两套金额(formula 内元价 vs price 列分值)**各自独立留痕、不做跨表交叉校验**。「确定不可计算」**必须**以 `per100ml = NULL` 表达(禁止用 0 或缺行冒充)。`per100ml` 列**必须**可被索引/数值排序(支撑未来榜单查询;`REAL` 数值排序而非字典序)。

#### 场景:可算商品
- **当** core 算出 `per100ml` 与 `formula`
- **那么** 落 `unit_price` 一行,两列非空,confidence/warnings 一并存

#### 场景:确定不可计算
- **当** core 判定 `per100ml = null`(如价格≤0 或非容量品)
- **那么** `unit_price.per100ml` 列为 NULL、`formula` 为 NULL,**禁止**写成 0

### 需求:corrections 必须沉淀人工纠错样本

`corrections` **必须**记录人工纠错(关联 `product`/`product_raw`、`corrected_spec`、`parse_source = manual_corrected`、时间戳),供未来作为 few-shot 样本与 eval 真值。`corrected_spec` **必须**为一个 **`ParsedSpec` 形 JSON(JSON-text,`TEXT` 列)**——即纠错后的规范规格,落库前**必须**过 `ParsedSpecSchema` 校验(故 `saveCorrection` 的入参是类型化的、与 core 类型对齐,不是无定形载荷)。纠错**禁止**就地覆盖原 `product_raw`/`product`(原始事实与原解析不可篡改),**必须**以独立纠错行表达。

#### 场景:提交一次纠错
- **当** 用户提交一个纠错后的 `ParsedSpec`
- **那么** 新增一行 `corrections`(`corrected_spec` 经 `ParsedSpecSchema` 校验、parse_source=manual_corrected),原 `product_raw`/`product` 行保持不变

### 需求:数据访问层必须提供类型化契约且配置缺失时显式失败

`@unit-price/db` **必须**导出类型化 repository 接口(至少:`upsertRaw`、`saveParsed`、`getProduct`、`saveCorrection`),入参/出参类型与 core 的 Zod 推导类型一致,读出对象**必须**经 Zod 再校验。`saveParsed` 入参**必须**含 `ParsedSpec` + `CalcResult` + `raw_id` 关联,落库前**必须**分别校验(`ParsedSpec` 过 `ParsedSpecSchema`;`CalcResult` 拆开过 `UnitPriceSchema`/`WarningsSchema`/`z.number().min(0).max(1)`),并在**单事务内**写 `product` + `unit_price`(全成或全败,不留孤儿)。`getProduct` 的「关联」**必须**明确为:返回 `product`(类型化 `ParsedSpec`)+ 其 `unit_price`(`CalcResult` 形)+ 可追溯的 `raw_id`。DB 连接(D1 binding 或本地 SQLite 句柄)缺失/打不开时,repository 初始化**必须**抛出明确错误(禁止静默连空库或假成功)。repository **必须**接受注入连接(D1 binding 或 sqlite 句柄),不在本层耦合 binding 获取方式。错误的 HTTP 状态分类(4xx/5xx)归 `public-deploy`,本层只抛类型化错误。

#### 场景:连接串缺失
- **当** 初始化 repository 时未提供有效 DB 连接(D1 binding/SQLite 句柄缺失或打不开)
- **那么** **必须**抛出指明连接缺失的错误,**禁止**返回一个看似可用的空实例

#### 场景:读出对象类型化
- **当** `getProduct` 返回一行
- **那么** 返回值是经 Zod 校验的 `ParsedSpec` + 其 `unit_price`(`CalcResult` 形)+ `raw_id`,而非裸数据库行

### 需求:迁移必须可复现且本地测试不依赖外部数据库

变更**必须**提供 Drizzle 迁移(sqlite 方言,可由 schema 生成、可应用),并提供本地测试基座(in-memory SQLite,如 `better-sqlite3`/`@libsql/client`,或 Miniflare D1),使 `pnpm -r test` 在 CI/本地**无需**外部托管数据库即可跑通持久层测试,且与生产 D1 同方言(SQLite)。测试基座**必须**显式 `PRAGMA foreign_keys=ON`(裸 SQLite 默认 OFF、驱动行为可能随版本/换型漂移,显式 ON 与 D1 强制 FK 对齐)——否则 `saveParsed` 单事务的 FK 回滚原子性会**假绿**(测试库不校验 FK 则回滚断言测不出);单事务原子性测试的失败注入**必须**用在测试库上确实生效的手段(`mock` 抛错或 NOT NULL/FK 约束,且 FK 已开)。重复运行迁移**必须**幂等——幂等由 **drizzle migration journal**(`__drizzle_migrations` 记录已应用的迁移、再次 `drizzle-kit migrate` 时跳过)保证,**而非**依赖 `CREATE TABLE IF NOT EXISTS`(drizzle-kit 默认生成裸 `CREATE TABLE`)。

#### 场景:本地跑持久层测试
- **当** 在干净环境执行 db 包测试
- **那么** 测试自带/拉起本地 SQLite 实例完成,不要求预置任何外部托管数据库

#### 场景:迁移可重放
- **当** 对同一数据库**重复运行 `drizzle-kit migrate`**
- **那么** migration journal 跳过已应用迁移,schema 收敛到同一状态、不报重复建表错误(不重放同一 SQL 文件)
