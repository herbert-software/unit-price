## 修改需求

### 需求:现有库存必须 backfill 打标签(不重放 ingest、单归属收敛、幂等)

**必须**对已落库的 `product` 跑 backfill:经打标签管线产出品类归属(叶 `product_tag` / `pending_category_tag_id`)、重算 `rankable`、补 `category_closure` 命中。backfill **必须**经一个受控入口落地(迁移 / 脚本 / 鉴权运维端点之一),**禁止**重放 `/ingest`(first-write-wins、不覆写)。

- **写路径三态 reconcile(单归属收敛 + 落叶清 pending)**:每次写品类归属,**必须**把三态字段(`kind=category` 叶 `product_tag` 与 `pending_category_tag_id`)**整体收敛到本次裁决**,使任一时刻商品恰落三态之一、**绝不**出现「有叶 ∧ pending 非空」的越界态:
  - 裁决 = **叶**:先删该 `product` 既有 `kind=category` 叶 `product_tag`、插新叶,**并置 `pending_category_tag_id=NULL`**(落叶必清 pending,对齐 taxonomy §二「转为正式叶标签、清 pending」)——规则升级改判 A→B 后只剩叶 B、不残留 A;
  - 裁决 = **待细化**:删既有 `kind=category` 叶、写 `pending_category_tag_id`(非叶节点);
  - 裁决 = **待人工**:删既有 `kind=category` 叶、置 `pending_category_tag_id=NULL`。
  (只动 `kind=category` 轴,**不误删** attribute / brand / product_line 正交标签。)
- **幂等**:同一数据快照重跑结果一致——`product_tag` `(product_id, tag_id)` 唯一防重复;仲裁为纯函数(同输入同输出);`rankable` / `pending` 为覆写、收敛到同值。

#### 场景:现有商品获得品类归属与属性标签
- **当** 对现有库存(生产现状约 **445** 个 `product` 全量,含 per100ml 不可算行)跑 backfill
- **那么** 可判定项获叶 category + 适用 attribute 标签且 `category_closure` 填充(含到 root);`rankable` 按规则重算

#### 场景:不可判定项落待人工、不强归
- **当** backfill 遇 tier1 与 store-map 都无确定叶的商品
- **那么** 其**品类归属留空** + 待人工,**禁止**强归、**禁止**改 `product.category` 列

#### 场景:规则升级改判后单归属收敛(无残留旧叶)
- **当** tier1 规则升级使某商品从叶 A 改判叶 B,随后重跑 backfill
- **那么** 该 `product` 的 `kind=category` 叶 `product_tag` **必须**只剩叶 B、**不得**残留叶 A;`rankable` 随之重算

#### 场景:待细化命中叶后清 pending、落已分类态(无越界)
- **当** 一个「待细化」商品(`pending_category_tag_id` 非空、无叶)经规则升级 / 人工命中叶
- **那么** 写叶的同时 `pending_category_tag_id` **必须**置 `NULL`,该商品恰落「已分类(叶)」态,**禁止**出现「有叶 ∧ pending 非空」的越界态;反向(叶 → 待人工 / 待细化)亦**必须**删除既有叶,不留残叶

#### 场景:backfill 重跑幂等
- **当** 对同一数据快照重复跑 backfill
- **那么** 结果**必须**一致:不重复挂同一 `(product_id, tag_id)`、归属与 `rankable` 收敛到同值

#### 场景:三态写归属必须原子收敛(无部分写越界态)
- **当** 写一次品类归属(经 reconcile:删旧叶 + 挂新叶/属性 + 设 pending + 重算 rankable)
- **那么** 这组写**必须**在单事务(sqlite)/ 批(D1)内**整体提交或整体回滚**,即便中途失败也**禁止**留下「有叶 ∧ pending 非空」的越界态;且原语**必须**在写前校验 kind(叶位只接 category 叶、pending 只接非叶 category、属性非 category),非法 slug / 缺失 product → 抛错而非静默假成功

#### 场景:本期 backfill 对 store-map 惰性、tier1 为活跃路径
- **当** 本期对现有库存跑 backfill
- **那么** 因现状无 ingest 字段承载 store 原生品类 id(`category_hint` 是 `product.category` 透传源、恒 `beverage`,**非**原生 `categoryIdList` 叶 id),backfill **不喂 store-map**(tier1 关键词规则为本期活跃分类路径);`store_category_map` seed + 仲裁 store-map 分支为后续阶段轨道、由单测覆盖,待 ingest 新增**专用** native-id 字段后接通;**禁止**复用 `category_hint` 承载原生 id(污染 `product.category`)

## 新增需求

### 需求:存量 backfill 必须有可在生产驱动的受控入口(确定性全序游标分块 + 完整覆盖)

打标签管线逻辑已就位,但生产**必须**有一个可触发它的受控入口,否则上条「现有库存必须 backfill」在生产里落空。该入口**必须**满足:① 鉴权保护(见 api-governance 的 admin tier);② **确定性全序游标分块**——按稳定全序键(`product.id`)的 keyset 游标推进、**禁止**依赖无序读 + 位置 offset 切片;③ **完整覆盖**——分多次驱动**必须**等价于对存量恰好一次全覆盖,**禁止**漏处理或在仍有未处理行时误报完成;④ `limit` **有界**——正整数下界 + 服务端上界 clamp,外部输入**禁止**绕过子请求安全护栏,**且 HTTP 入口在调用方不传 `limit` 时必须注入服务端默认有界 `limit`、恒走分块,禁止把「无参全量单次扫」暴露为生产 HTTP 行为**(无参全量仅为库函数/单测契约,见下方场景);⑤ 幂等;⑥ 纯确定性:**禁止** tier2 LLM、**禁止**任何出站 fetch;⑦ **写集封闭**——直接写集 = `product_tag`(kind=category 叶 **+ attribute 正交边**,沿用既有「品类归属与属性标签」契约)+ `product.{pending_category_tag_id, rankable}`,**禁止**触原始 raw / 价格 / `product.category`(`category_closure` 为种子期物化在 tag 轴、靠叶 attach 间接命中,backfill **不**写其行);⑧ **禁止**重放 ingest;⑨ 对 store-map 惰性。该入口为**可重复驱动**的受控入口(bootstrap + ad-hoc 重标);「ingest 后自动重标」的事件/调度化为后续项、不在本需求范围。

#### 场景:经受控入口驱动存量打标签
- **当** 持 admin 凭据调用 backfill 入口
- **那么** 对存量 `product` 执行打标签:写 `product_tag`(category 叶 + 适用 attribute 边)、补 `category_closure` 命中(经叶 attach、不写 closure 行)、按归属重算 `rankable`,三态由字段可判别
- **那么** 不重放 ingest、不调用 LLM、不发起任何出站请求,直接写集**不超出** `product_tag`(category 叶 + attribute 边)+ `product.{pending_category_tag_id, rankable}`

#### 场景:确定性全序游标分块、完整覆盖、真完成信号
- **当** 入口按稳定全序键(`product.id`,数据库**文本**排序)的 keyset 游标分块驱动(每块 `WHERE id > :cursor ORDER BY id LIMIT :limit`,处理游标之后的至多 `limit` 行)
- **那么** 跨多次独立调用的处理集合**必须**等价于对存量的一次全序全覆盖:**禁止**因行序漂移漏处理某行,**禁止**重叠重复;每块返回的游标**必须**严格大于入参 cursor(取本块最大已处理 `id`),保证游标**单调前进、不原地踏步**
- **那么** **完成信号必须由游标耗尽(本次读到行数 < limit)给出、而非位置比较**;存量恰为 `limit` 整数倍时,末个满块后**多一次读到 0 行的空读**才置完成——`limit>0` 下读到 0 行是**正常耗尽终止、非缺陷**(与 `limit=0` 的空块死循环相区别),误报「已完成」即缺陷

#### 场景:`limit` 有界、非法值被拒、超大值被钳制
- **当** 调用方传 `limit`
- **那么** `limit` **必须**为正整数(`>=1`):`0` / 负数 / 非整数 → 拒(`400`,与 `/rankings` 同款严格 parse),`limit=0` 尤其**禁止**(空块、游标不前进 → 死循环)
- **那么** 超过服务端子请求安全上界的 `limit` **必须**被 clamp 到该上界(按 Worker 子请求上限与每商品实测子请求数派生),**禁止**因外部传入超大值退化成超额单块

#### 场景:无参全量仅为库函数/单测契约、不暴露为 HTTP 行为
- **当** 在**库内 / 单测**直调 `runBackfill(repo, db)` 不带游标 / limit
- **那么** 对全部存量执行一次全序 backfill(等价于现有 `runBackfill` 行为,保持现两参签名与既有单测),此路径**仅**供进程内调用(无 Worker 子请求上限约束)

#### 场景:HTTP 入口即使调用方不传 limit 也恒分块、不触发全量单扫
- **当** `POST /admin/backfill` 的调用方省略 `limit`(空 body 或缺字段)
- **那么** 入口**必须**注入服务端默认有界 `limit`(并 clamp 到上界)、走 keyset 分块路径,**禁止**把缺省透传成 `runBackfill` 的无参全量单次扫(那将一次性扫全表 ~445 × 每商品多次子请求、超 Worker 子请求上限、中途失败留半写假象)

#### 场景:任意区间重跑幂等、并发 ingest 下快照行不漏不重
- **当** 同一快照下对某游标区间重复驱动,或续跑期间并发 `/ingest` 落新 `product`
- **那么** 结果与单次驱动一致(单归属收敛、无残留旧叶、`product_tag` 不重复挂);**完整覆盖保证的对象是 sweep 起始快照行**——快照行恰被处理一次、keyset 游标只前进不损坏其覆盖
- **那么** 并发插入的**新行**按其 `product.id` 文本序相对当前游标**确定性二分**:排在游标**之后** → 本轮后续块纳入;排在游标**之前(已过区间)** → **顺延下一轮 sweep**(确定性延后、非漏标)。「增量可再驱动」= 从头一次全新全序 sweep、而非续旧游标

#### 场景:入口对 store-map 惰性
- **当** 驱动 backfill 时无承载山姆 native 分类 id 的 ingest 字段
- **那么** 每条输入以 `nativeCategoryId=null` 喂入,tier1 关键词规则为唯一活跃分类路径;仅靠 native id 才能判定的商品落「待人工」,不强归(沿用 P2 既定边界,本入口不激活 store-map)
