## 上下文

P2 落地了 taxonomy v1 的表/种子/打标签管线(`apps/api/src/tagging.ts`:`tagProduct`/`listProductsForBackfill`/`runBackfill`,均配单测)。但 `index.ts` 仅 re-export 这些函数,`routes.ts` 无路由驱动——生产从未跑过 backfill,prod ~445 个 `product` 全是「待人工」、`product_tag` 空、`rankable` 未重算。category-tagging 主 spec 早有「现有库存必须 backfill」要求,缺的是**生产可触发的入口**。

约束(已核实):
- backfill 逻辑是 **TS**(tier1 关键词规则 + 闭包组合 + 三态原子收敛),**不能**降级为纯 SQL。
- 生产 D1 是 `unit-price-prod`(Worker binding `DB`);公共治理用 `API_KEYS` 白名单 + `GOVERNANCE_KV`,限频 60/key/60s(`governance.ts:24`,且 **fail-open**:KV 缺失/抖动时放行)。
- `listProductsForBackfill`(`tagging.ts:189`)当前 `.from(product).innerJoin(productRaw…)` **无 `orderBy`**;`product.id` 是 `text('id').primaryKey()`(app 生成、非单调,`schema.ts:64`)。
- Worker 子请求上限:**free-plan 50/请求**;`/ingest/batch` 据此把 `MAX_BATCH=40`,注释明示「升到 100+ 须先确认生产 Worker 为 PAID(1000)」(`routes.ts:92-97`)。本设计**默认按 free-plan 50**,不擅自假设 paid。
- 每个 `tagProduct`(`tagging.ts:99`)对 D1 的子请求 ≈ `resolveComparableUnit`(1 读)+ `reconcileCategory`(product 存在性读 + `loadCategoryLeafTagIds` + 每个 leaf/pending/**每属性** slug 的 `loadTagBySlug` + 末尾 `batch()`),**实测口径 ~5–9 子请求/商品**。
- store-map 本期惰性:无 ingest 字段承载山姆 native 分类 id,`nativeCategoryId=null`,tier1 为唯一活跃路径(P2 既定,本变更不改)。

## 目标 / 非目标

**目标:**
- 提供一个独立 admin 鉴权层保护、可在生产驱动的 backfill 入口,对存量打标签 + 补闭包 + 重算 `rankable`。
- 用**确定性全序游标**保证分块**完整覆盖**(不漏标/不假完成),且单块子请求**有界、外部输入不可绕过**。
- admin 写能力与众包 ingest 凭据**权限分离**。
- 不改 backfill 业务语义,只补「触发 + 安全分块 + 治理/审计」。

**非目标:**
- **不**激活 store-map(无 native-id ingest 字段是另一变更)。
- **不**做 dry-run(确定性游标覆盖 + 幂等 + 计数返回已足够安全;dry-run 需 `tagProduct` 无写模式,超范围)。
- **不**改 `/rankings` 入榜判据(仍 `per100ml IS NOT NULL`;`rankable` 接入是 P3 收敛,本期 `rankable` 为过渡期 derived 列、写入但暂无 reader——已知过渡态、不在本期消解)。
- **不**做 ingest 后**自动**重标(事件/队列/调度驱动)——显式后续项;本期入口是手动可重复驱动的 bootstrap + ad-hoc。
- **不**重放 ingest、**不**触 tier2 LLM、**不**发起任何出站 fetch。

## 决策

### D1:入口 = Worker 内 admin 鉴权 route,而非本地连远程 D1 脚本
- **选** `POST /admin/backfill`(Worker 路由,运行在 CF 网络,原生持 prod `DB` binding)。
- **弃** 本地 Node 脚本连远程 D1:① backfill 是 TS、`wrangler d1 execute --remote` 只能跑 SQL,跑不了规则逻辑;② 本地进程拿不到远程 D1 的 better-sqlite3 式连接,D1 的远程接口只有 Worker binding 与 REST/HTTP API,要在本地驱动 TS repo 得自写一层 D1-over-HTTP driver shim——比加一个 Worker 路由新增面更大、且每次查询都是本地↔CF 往返,慢且脆。
- **弃** 纯 SQL 迁移:逻辑含 tier1 规则与三态原子收敛,不可表达为确定 DML。
- **弃** 队列/调度自动化(Queues/Workflows/scheduled):对**首轮 bootstrap**(一次性扫 ~445 行)过重;但「ingest 后自动重标」的**复发**需求确实更适合事件驱动 → 列为显式后续项(非目标),本期不把手动循环钉成终态。

### D2:确定性全序 keyset 游标分块(取代位置 offset)——修 review BLOCKER
- **问题**:原方案让每次独立 HTTP 调用各自**无 ORDER BY 全量重读**再按位置 `offset` 切片。SQLite 无 `ORDER BY` 时行序实现定义,跨调用(尤其每块还做 `reconcileCategory` 写、扰动扫描页)行序会漂移 → 某行从已过窗口滑回 → **静默漏标**,而 `nextOffset=null` 假报完成。幂等只救「重复处理」,救不了「漏处理」。
- **选** keyset/seek 游标:`listProductsForBackfill` 下推 `WHERE product.id > :cursor ORDER BY product.id LIMIT :n`,返回本块最后一行 id 作 `nextCursor`;读到的行数 `< limit` ⇒ 游标耗尽 ⇒ `nextCursor=null`(覆盖完成的**真**信号)。
- **为何优于「加 ORDER BY 仍用 offset」+ 并发语义的精确边界**:offset 在续跑期间并发 `/ingest` 插新行(text id 非单调,可能落已过区间之前)时整体错位、会漏/重**快照行**;keyset 游标只前进,对**起始快照行**的覆盖**不损坏**——快照行恰被处理一次、无重叠无跳跃。但并发插入的**新行**不是「免疫」而是**有定义的二分**:其 id 文本序若**排在当前游标之后** → 本轮后续块纳入;若**排在游标之前(已过区间)** → 本轮**不覆盖、顺延下一轮 sweep**(非漏标,是确定性延后)。即:覆盖完整性保证的对象是「sweep 起始快照」,不是「运行期实时全表」。
- `runBackfill` 增可选 `{ cursor?, limit? }`:无参 = 单次全序全量(等价旧 `runBackfill` 行为,保持现签名与既有单测);带参 = 处理 `(cursor, +limit]` 区间。`BackfillResult` 增 `nextCursor: string | null`(无参全量 → `null`)。`nextCursor` **必须**严格 `> 入参 cursor`(取本块最大已处理 `product.id`),保证单调前进、不原地踏步。`product.id` 是 text,游标按数据库**文本**排序、不可数值解析。分块逻辑收敛在 `runBackfill`/`listProductsForBackfill` 一处,路由只解析参数 + 调用 + 投影返回。
- **无参全量是库函数/单测契约、不暴露为 HTTP 行为**(修 review BLOCKER:无参 `runBackfill()` 单次扫全表 ~445 × ~5–9 子请求 ≈ 2000–4000 子请求,远超 free-plan 50、必炸,且绕过 D3 的 `limit` 护栏)。**route 永远走分块**:`POST /admin/backfill` 在调用方省略 `limit` 时**注入服务端默认有界 `limit`**(见 D3),**禁止**把缺省 body 透传成 `runBackfill()` 无参全量。无参分支只保留给进程内单测(无 Worker 子请求约束)。
- **末块边界**:存量恰为 `limit` 整数倍时,末个满块后多一次读到 0 行的空读才置 `nextCursor=null`——`limit>0` 下读 0 行是正常耗尽终止(与 `limit=0` 空块死循环相区别)。
- spec 层**只声明**「确定性全序游标 + 完整覆盖 + 游标耗尽才算完成」抽象不变量,**不写死** `nextCursor` 等令牌名;但游标**键**钉死为 `product.id`(本期唯一可用的稳定全序键,属域不变量、非机制细节)。

### D3:`limit` 严格校验 + 服务端上界 clamp(子请求护栏不可被外部绕过)——修 review MAJOR
- `limit`:正整数 `>=1`(拒 `0`〔否则 `(cursor,+0]` 空块、`nextCursor` 不前进 → 死循环〕、负数、非整数〔负/小数喂 slice 错切〕),严格 parse,仿 `RankingsQuerySchema`(`routes.ts:166`,其 `limit` 亦 `positive()` + `Math.min(n,200)` clamp)。
- **缺省即注入默认**:调用方省略 `limit` 时,route 注入 `ADMIN_BACKFILL_DEFAULT_LIMIT`(走分块、不退化无参全量)。
- **服务端硬上界 clamp**:`limit = min(请求值, ADMIN_BACKFILL_MAX_LIMIT)`,上界按**子请求预算**派生 = `floor((free_plan_50 − 读开销) / 每商品最坏子请求数)` 留 headroom。每商品最坏子请求数须含 `resolveComparableUnit` 沿 is-a 树**逐级上行**找最近非空 `comparable_unit` 的跳数(`repository.ts`,非固定 1 读)+ `reconcileCategory` 的 product 存在性读 + `loadCategoryLeafTagIds` + 每 leaf/pending/**每属性** slug 的 `loadTagBySlug` + 末尾 batch ⇒ 实测口径 ~5–9。**公式定常量**:`1(读) + limit × 9 ≤ 50` ⇒ `limit ≤ 5`(`limit=6` 即 55 超线)。**5 是待 task 1.4 实测定稿的临时上限、非已定常量**(每商品最坏数含 `resolveComparableUnit` 沿 is-a 树深度的逐级读,实测若 >9 则 limit 须下调);实现**不得**在 1.4 实测前把 5 当 load-bearing。确认生产 Worker 为 PAID(1000)后方可调高,**显式标注、不默认**(对齐 `MAX_BATCH` 注释纪律)。
- 外部传超大 `limit` 被 clamp,**无法**绕过子请求护栏退化成超额单块;缺省 `limit` 被注入默认,**无法**触发无参全量单扫(D2)。

### D4:独立 admin 鉴权 tier(`ADMIN_API_KEYS`),与公共 `API_KEYS` 权限分离——修 review MAJOR(authz + ADDED/MODIFIED 一并解决)
- **问题**:复用公共 `governanceMiddleware`(单一扁平 `API_KEYS`)= 任何众包 ingest key 自动可驱动全目录 derived 写,越权;且把 `/admin/backfill` 塞进公共「受保护端点集合」会让既有 4 条枚举该集合的 api-governance 需求自相矛盾(必须 MODIFIED 5 处)。
- **选** 独立 admin gate:鉴权 against **独立白名单 `ADMIN_API_KEYS`**(新 secret,`bindings.ts` 加字段)。`/admin/*` 属公共受保护集合**之外**的独立 tier → 公共 4 元枚举与 `/rankings` 豁免**保持不变**,api-governance 增量是**纯 ADDED**(正确)、无需 MODIFIED 公共集合。
- **接缝精确拆分(修 review MAJOR:原「参数化 `createRealGovernance` 注入 allowlist 源 + 是否计限频」措辞错位——`checkRateLimit` 在 `governanceMiddleware` 无条件跑〔`governance.ts:256`〕、不在 factory;且 `parseAllowlist` 硬读 `env.API_KEYS`〔`:100`〕,原样复用 config-error 分支会校验**错** secret)**。两条接缝分别处理:
  - **接缝① allowlist 源参数化**:把 `parseAllowlist` 的 `env.API_KEYS` 硬读改为接受**源选择**(binding 名或解析后字符串),`authenticate` 据此读对应 secret;公共调用点传 `API_KEYS`、admin 传 `ADMIN_API_KEYS`。`extractKey`(`Authorization` 权威不回退 / `BEARER_PREFIX` / `KEY_FORMAT`)、三态映射、**空 allowlist → `500 config-error`** 分支(`:123`)由二者**共用同一实现**。**共享方式选「封装式」(经参数化 factory / 单一内部 helper 被公共中间件与 admin gate 同调),不裸 `export` 头解析器**——裸 export 会永久放大 `governance.ts` 公共面、引第三方 caller 重新引入回退绕过风险;封装式保持 `extractKey`/`parseAllowlist` 私有、源选择内部化。**禁止**复制粘贴/重写头解析(否则丢「Authorization 不回退」→ CWE-287 绕过)。
  - **config-error 判定次序**:**按 admin 源判定**(检 `ADMIN_API_KEYS` 空、非 `API_KEYS`,否则 admin 在 `API_KEYS` 非空时假通过=fail-open);且 config-error(admin 源空)**必须前置于任何 `extractKey` 派生的 `auth-*` 映射**——即**不论请求头形态**(含 malformed `Authorization`),admin secret 未配/空时一律 `500 config-error`、**非** `401 auth-malformed`(与 `governance.ts:122-130` 先查 allowlist.size 再 dispatch kind 的语句序同构)。
  - **泛化 message**:共享 config-error 分支当前 message 字面含 `API_KEYS`(`governance.ts:128`)。重构后该分支**对两个 tier 都输出泛化 client message**(如 `service configuration error`),secret 名/「哪个源空」诊断仅入服务端日志;**不得**把 `:128` 旧字面原样回给客户端(否则 admin 泄 secret 名、public 也续泄)。注:既有公共 governance 测试只断言 error **code**(`'config-error'`)、**不**断言 message body 字串,故泛化 message **不破**既有断言——本变更是**新增**一条「响应体不含 secret 名」的泛化断言(tasks 3.2),非改既有。
  - **接缝② admin gate = 专用 authenticate-only 中间件**(**不**复用 `governanceMiddleware`):只跑 `authenticate(admin 源)` → 失败 return / 成功 `next()`,**不**调 `checkRateLimit`、**不**调 `recordUsage`、**不**设 `govKey`。如此 admin **结构上永不抵达限频/用量门**——「admin 不计公共限频」是**不变量**(非 factory flag),也不误消耗公共 `rl:`/`usage:` KV 槽,且天然回避公共限频 fail-open。容器控制 = D3 `limit` clamp + D5 幂等有界写。
- **fail-closed**:`ADMIN_API_KEYS` 未配置 / 空 = `500 config-error`(复用 config-error 分支、**按 admin 源判定**),`config-error` 前置于 `auth-*` 三态;**禁止** fail-open 放行、**禁止**类比 `checkRateLimit` 的 KV-缺失-fail-open(`:147`)。新 secret 首次部署常缺失,这条不可留给实现者类比。**config-error 响应体对客户端泛化、不含 secret 名**(secret 名/诊断细节仅入服务端日志),避免向匿名探测暴露 admin secret 名与未配窗口。
- **鉴权前置遮蔽写**:gate 失败(含 config-error)即 `c.json(...)` return、不 `next()` → handler 不执行 → `runBackfill` 不被调用(与 `/ingest` 同构,`governance.ts:247`)。Hono 精确路径匹配 → `app.use('/admin/backfill', adminGate)` 须注册于 `app.post('/admin/backfill',…)` 前。鉴权失败侧不新增日志,沿用既有 governance 失败短路无日志行为(失败=4xx/5xx 短路、零写,可观测性非本期项)。
- **`/admin/*` 不变量**:Hono `app.use(path)` 精确匹配(`routes.ts:631` 注释自陈 `/ingest` 不覆盖 `/ingest/batch`)→ 立「每个 `/admin/*` 路由必须各自挂 admin gate、无前缀 catch-all」的 spec 不变量,防未来 admin 路由默认裸奔。

### D5:幂等 + 写集封闭 + 审计(blast radius 控制)
- 幂等沿用既有:`tagProduct` 同输入同输出、`product_tag (product_id,tag_id)` 唯一、`rankable`/`pending` 覆写收敛;单商品三态写在单事务/批原子(`spec:142`),分块只是少调几次、每次仍整商品原子,**不破坏**原子性。
- **写集封闭**:直接写集 = `product_tag`(kind=category 叶 **+ attribute 正交边**——`tagProduct` 既写品类叶也写属性标签边,沿用 P2「获得品类归属**与属性标签**」契约,不可窄到只剩 category 叶)+ `product.{pending_category_tag_id, rankable}`;`category_closure` 种子期物化在 tag 轴、靠叶 attach 间接命中、**不写 closure 行**(`tagging.ts:17-21` docstring)。**禁止**触原始 raw/价格/`product.category`、不读写外部、不出站。即便凭据误用,最坏 = 从既有快照**重导可重算数据**,无 PII 外泄/无数据丢失/无原始记录损坏。该「无损坏」结论依赖 D2 强制分块(无参全量旁路若可达,中途失败会留半写假象)——已由「HTTP 入口恒分块」封堵。
- **审计**:每次**经放行**的调用 emit 一条结构化日志(沿用 `console.warn` 结构化先例,`routes.ts:580`),含 `{ key 标识(**仅** keyed 哈希——`HMAC-SHA256(key, 服务端 secret)` 或部署 salt,定长截断;**禁止**明文或任何 key 子串/前缀,因 `ADMIN_API_KEYS` 低熵长寿命、裸 digest 可离线爆破)、cursor、limit、total/classified/pending/manual/rankable、时间戳 }`。鉴权失败在 gate 层短路、不进 handler,其可观测性由 gate 负责、不由本日志承担。
- **响应投影**:只回计数 + `nextCursor`,**不**回 `results[]`(避免响应体随存量无界 + 避免一次导出全表 product→verdict 映射)。

## 风险 / 权衡

- [子请求上限:大块超 free-plan 50 致中途失败] → D3 默认/上界按 free-plan 50 + 每商品实测子请求数派生(初定 limit≈5、上界 clamp)+ 游标分块使任意块可原样重跑;升 limit 须显式确认 PAID(对齐 `MAX_BATCH` 纪律)。
- [小 limit → 调用数多(~90 次扫 445 行)] → admin tier 不受公共 60/60s 限频约束(D4),运维以脚本循环自动驱动到 `nextCursor=null`,~90 次顺序调用可接受;非人工逐次。
- [公共限频 fail-open、非硬上界] → 已知:admin 不依赖限频做容器控制,容器 = `limit` clamp(D3)+ 幂等有界写(D5);design 不把 60/window 当 admin DoS 边界。
- [admin **调用频次**无硬上界(不计公共限频)——主动接受的权衡] → 单次调用 blast radius 由有界 `limit` + 幂等封死;调用频次的唯一控制 = `ADMIN_API_KEYS` 白名单保密 + 审计。对受信运维的 ~数十次 bootstrap 循环可接受;若日后 admin 暴露面扩大,再引入 admin 专属限频。显式 own 此决策、非疏忽。
- [admin 端点长期暴露面] → 独立 `ADMIN_API_KEYS` 白名单(fail-closed:未配/空 → config-error,D4)+ 审计 + 写集封闭幂等;`/admin/*` 各自挂 gate 不变量防裸奔。定位为可重复驱动的受控入口、非一次性遗留路由;合规上仅对已落库数据重算、不抓取、不外发。
- [store-map 仍惰性,部分仅靠 native id 可判定的商品落「待人工」] → P2 既定边界,非本变更回归;软饮经 tier1 关键词即可归类,P3 浏览主路径不受影响。
- [`rankable` 重算后仍不接入 `/rankings`,写入暂无 reader] → 过渡态(P3 收敛两套判据);本期只保证 `rankable` 算对、落列,不消解孤儿写——已在非目标声明,避免本变更膨胀。
- [并发 `/ingest` 续跑期改变存量] → keyset 游标保证**起始快照行**覆盖不损坏(恰一次、不漏不重);并发插入新行按 id 相对游标**确定性二分**(之后纳入本轮、之前顺延下轮),非「免疫」而是有定义的延后(D2);「增量可再驱动」语义 = 从 `cursor=null` 起一次全新全序 sweep(幂等),非续旧游标。
