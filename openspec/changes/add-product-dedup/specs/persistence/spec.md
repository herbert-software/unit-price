## 新增需求

### 需求:product 必须按去重键收敛、相同结果只保留最老一条

`saveParsed` 落库 `product` 时**必须**对「同一来源 + 相同解析结果」去重:**禁止**为等价的重复输入堆叠多条 `product` 行(否则同一款被未来榜单重复计数/排序、污染真实单价榜)。

**去重键必须为 `(rawId + 规范化 ParsedSpec)`、与价格无关。** 键字段为 `rawId`、`unit_size_value`、`unit_size_unit`、`quantity`、`total_amount_value`、`total_amount_unit`、`category`、`multipliers`、`package_unit`;**禁止**纳入 `per100ml`/`formula`(价格派生值),且键**禁止**涉及 `unit_price` 表任何列(含其 `confidence`/`warnings`)——价格变动属同款更新、不应制造新「结果」行(与 `product_raw` 去重键「与价格无关」同口径)。`ParsedSpec.confidence`(`product.confidence` 列)**亦排除**:它是解析中间置信、非「结果结构」一部分,同 rawId 同 spec 结构、不同 confidence(如 tier2 复算)**必须**判为同款重复、保留最老(不因置信抖动堆叠新行)。键**必须**由确定性纯函数构造(IO 层 / `packages/db` 的独立模块,**禁止**污染 `core`、**禁止**塞入 `codec`):相同 `ParsedSpec` 结果**必须**得相同键、不同结果**必须**得不同键;`null` 与 `undefined` 可空字段**必须**归一为 JSON `null`(**禁止**用字符串哨兵——会与真值字符串碰撞误去重;JSON 规范区分 `null`/数字/字符串);measurement/JSON 序列化**必须直接调用**落库所用的 `encodeMeasurement`/`encodeJson`(**禁止**另写等价序列化,以免漂移);最终键**必须**以结构化数组整体序列化产出(**禁止**裸字符串拼接,以免 `"a|b"` 分隔歧义)。

**保留最老一条必须由数据库唯一约束保证。** `product` 表**必须**新增 `dedupe_key`(`TEXT NOT NULL`)列与其 **`uniqueIndex`**——**首个成功插入的行赢、后到等价行被拒/no-op**,「保留最老」由唯一约束天然保证,**禁止**依赖应用层 rowid 比较或读后写时序。`dedupe_key` 是溯源/收敛增列(类同 `raw_id`),**非**领域字段、不进 `ParsedSpec`。

**双驱动写路径必须各自保证首插原子 + 不留孤儿(机制不同但等效)。**
- **sqlite 驱动**(单连接、无真并发):`saveParsed` **必须**在单个 `transaction` 内 `insert(product)` 用 `onConflictDoNothing(target dedupe_key)` 并判 `changes`/`returning`——真插入(`changes=1`)→同事务内插 `unit_price`、返回新对;命中既有(`changes=0`)→`SELECT` 既有 `product`+`unit_price`、返回既有对、**不**插 unit_price。两插同事务,首插原子。
- **D1 驱动**(有真并发):`saveParsed` **必须** SELECT-first(`SELECT product by dedupe_key`)——命中→返回既有对、不写;未命中→`batch([insert product, insert unit_price])` 原子写,其中 product **必须用裸 `insert`、禁止 `onConflictDoNothing`**。**禁止**对 D1 path 的 product insert 用 `onConflictDoNothing`:它会吞掉唯一冲突使 `batch` 不抛错、`unit_price` 照插成孤儿。并发抢插时裸 insert 命中唯一索引**抛错** → `batch` 全成全败、整体回滚 → `saveParsed` **必须**捕获该错并回退到「SELECT 既有并返回」分支(此时先提交方已落库、必查到)。首插原子由 `batch` 保证。

**去重命中时禁止留孤儿、必须返回既有最老行;回退查空即数据损坏必须抛错。** 命中既有 `dedupe_key` 时,`saveParsed` **必须不**插入新 `unit_price`,而**必须**查既有 `product` 及其 `unit_price`、返回**既有(最老)** 的 `{productId, unitPriceId}`。其中 `SELECT unit_price by product_id` 若**查空**(既有 product 无配对 unit_price)= 数据已损坏,**必须抛错**(与 `getProduct` 既有不变量一致);首插原子性保证该分支理论上不可达。`saveParsed` 返回值结构不变,但等价重复调用**必须**返回**同一对** id(幂等)。

**去重只作用于 `product`/`unit_price` 派生层。** **禁止**因去重改动 `product_raw` 原始留痕或其 `(store, store_sku)` 去重键(原始观察忠实保留);亦**禁止**做跨 `raw` 的「同商品不同标题」实体归一(不同 `rawId` 即不同键、不去重,属已知非目标)。

迁移**必须**经 `drizzle-kit generate` 产出可复现的 sqlite 方言迁移(新增 `dedupe_key` 列 + 唯一索引),沿用既有 `wrangler d1 migrations apply` 路径应用;幂等由 drizzle journal 保证。**空表是唯一自动支持路径**:对空表(生产将整体删除重录的默认路径、harness 用 `:memory:` 空库)直接加 `NOT NULL` 列 + 唯一索引即成功。**非空旧库**(本地已有数据、可能含等价重复行)**不在自动迁移支持范围**——SQLite 非空表加 `NOT NULL` 无 DEFAULT 列直接报错、回填亦撞唯一索引;**禁止**期望 drizzle 单步迁移自动回填/去重(drizzle-kit 不生成数据迁移)。非空旧库**必须**手动处置:直接 drop & re-migrate,**或**先跑可选清理脚本——该脚本**必须在应用层**读每行 `product` 的 spec、调去重键函数算键、按算出的键分组保留 `MIN(rowid)`、删其余及其 `unit_price`,**禁止「按 `dedupe_key` 列分组」**(清理发生在加列之前、该列尚不存在)。清理脚本作为**可选**附件、**禁止**纳入自动部署路径。

#### 场景:同结果重复落库只保留最老一条

- **当** 对同一 `rawId` 用相同 `ParsedSpec` 结果调用 `saveParsed` 两次(同款重复提交)
- **那么** 仅落库一条 `product`(及一条 `unit_price`),第二次调用**不**新增行、返回与第一次**相同**的 `{productId, unitPriceId}`(最老一条);`product` 表该 `dedupe_key` 仅一行

#### 场景:不同解析结果不去重

- **当** 同一 `rawId` 先后产生**不同** `ParsedSpec` 结果(如解析逻辑升级后 `unitSize`/`quantity` 变化)
- **那么** 两者去重键不同、**各自落库**一条 `product`(不互相去重)——去重只收敛「相同结果」

#### 场景:去重键与价格无关

- **当** 同一 `rawId` 同一 `ParsedSpec`、但价格变动导致 `per100ml`/`formula` 不同
- **那么** 去重键**不变**(不含价格派生值)、判为同款重复、保留最老一条;**禁止**因价格抖动堆叠新「结果」行

#### 场景:去重命中不留 unit_price 孤儿(sqlite path)

- **当** sqlite 驱动 `saveParsed` 在事务内 `insert product onConflictDoNothing` 命中既有 `dedupe_key`(`changes=0`)
- **那么** **不**插入新 `unit_price`(避免指向未插入 product 的孤儿),`SELECT` 既有 `product` 与其既有 `unit_price`、返回既有 id 对

#### 场景:D1 并发等价提交保留最老且不留孤儿

- **当** D1 驱动下两个等价提交并发到达(均 SELECT-first 未命中、都进 `batch`),product 用裸 `insert`(无 `onConflictDoNothing`)
- **那么** 先提交方落库(最老);后提交方裸 insert 命中唯一索引**抛错** → 其 `batch` 整体回滚(不留 `unit_price` 孤儿)→ `saveParsed` 捕获后回退 `SELECT` 既有、返回先提交方(最老)的 id 对;**禁止**用 `onConflictDoNothing` 吞冲突(会使 batch 不抛错、unit_price 成孤儿)

#### 场景:解析置信(confidence)不进去重键

- **当** 同一 `rawId` 同一 `ParsedSpec` 结构、但 `ParsedSpec.confidence` 不同(如 tier2 复算给出不同置信)
- **那么** 去重键**不变**(`confidence` 排除)、判为同款重复、保留最老一条(不因置信抖动堆叠新行)

#### 场景:可空字段归一

- **当** 两次 `saveParsed` 的 `ParsedSpec` 在某可空字段上一为 `null`、一为 `undefined`(其余相同)
- **那么** 二者去重键**相同**、判为同款重复(`null`/`undefined` 归一),只保留最老一条
