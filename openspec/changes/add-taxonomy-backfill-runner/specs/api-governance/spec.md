## 新增需求

### 需求:admin 运维端点必须经独立 admin 鉴权 tier 保护(与公共受保护集合分离)

运维端点 `POST /admin/backfill`(驱动存量打标签 backfill)**必须**经一个**独立的 admin 鉴权 tier** 保护:鉴权 against **独立白名单 `ADMIN_API_KEYS`**(与公共 `API_KEYS` **分离**),**禁止**复用众包 ingest 凭据授予全目录 derived 写能力。`/admin/*` 端点**不属于**公共受保护端点集合 `{/parse, /contribute, /ingest, /ingest/batch}`——本需求**不改变**该公共集合的枚举、其鉴权/限频/用量语义、以及 `/rankings` 作为集合外公开端点的豁免。admin 鉴权**必须**前置于任何 backfill 驱动:鉴权(含下述配置错误态)失败时**禁止**调用 `runBackfill`、**禁止**产生任何 tag / `product_tag` / `rankable` 写入。

admin gate **必须**是一个**专用 authenticate-only 中间件**(**不**复用公共 `governanceMiddleware`):只做鉴权 → 失败 return / 成功 `next()`,**不**经限频、**不**经用量计数(见下「admin tier 容器控制」需求)。它**共用**既有头解析与三态映射实现(`extractKey`:`Authorization` 权威不回退 `X-API-Key` / `BEARER_PREFIX` 大小写不敏感 / `KEY_FORMAT`)、与空 allowlist → `config-error` 分支,仅把 **allowlist 源**换成 `ADMIN_API_KEYS`;**禁止**复制/重写头解析(防 `Authorization` 回退绕过)。错误码语义复用公共(`auth-missing` `401` / `auth-malformed` `401` / `auth-forbidden` `403`)。

**且必须 fail-closed、按 admin 源判定**:`ADMIN_API_KEYS` **未配置 / 为空 / 全空白** = **配置错误**,**必须**返回 `500 config-error`(**对 `ADMIN_API_KEYS` 的空判定、非 `API_KEYS`**——否则 admin 在 `API_KEYS` 非空时假通过=fail-open),**禁止** fail-open 静默放行、**禁止**退化为空白名单把合法 key 误判 `403`。`config-error`(admin 源空)判定**必须前置于任何 `extractKey` 派生的 `auth-*` 映射**——即**不论请求头形态**(含 malformed `Authorization`),admin secret 未配/空时一律 `500 config-error`、**非** `401 auth-malformed`。**禁止**类比限频的 fail-open(KV 缺失即放行)在缺凭据源时放行 admin 写。**config-error 响应体对客户端必须泛化**(仅 `config-error` 码 + 通用 message,**不含** `ADMIN_API_KEYS`/`API_KEYS` 等 secret 名或配置细节;secret 名/「哪个源空」诊断仅入服务端日志),避免向匿名探测暴露 admin secret 名与未配窗口。

#### 场景:缺 admin key 时拒绝且不驱动
- **当** `POST /admin/backfill` 不带鉴权头
- **那么** 返回 `401 auth-missing`,且不调用 `runBackfill`、无任何打标签写入

#### 场景:格式非法 key → 401 auth-malformed 且不驱动
- **当** 带鉴权头但取不出合法 key 值(非 Bearer 形态 / 空 Bearer / 空 `X-API-Key`)
- **那么** 返回 `401 auth-malformed`,不驱动 backfill

#### 场景:不在 admin 白名单的 key → 403 且不驱动
- **当** 带格式合法但不在 `ADMIN_API_KEYS` 的 key(含一枚仅在公共 `API_KEYS` 登记的众包 ingest key)
- **那么** 返回 `403 auth-forbidden`,不驱动 backfill(权限分离:公共 ingest 凭据**无** admin 能力)

#### 场景:合法 admin key 放行并驱动
- **当** 带在 `ADMIN_API_KEYS` 登记的合法 key
- **那么** 放行并执行本次 backfill 游标区间

#### 场景:鉴权前置遮蔽 backfill 驱动
- **当** admin 鉴权阶段失败(`auth-missing` / `auth-malformed` / `auth-forbidden` / `config-error` 任一)
- **那么** 在任何 `runBackfill` 调用之前短路返回(中间件 fail 即 return、不 `next()`,沿用 `/ingest` 治理先于流水的模式),无任何打标签写入

#### 场景:未配置 ADMIN_API_KEYS → 500 config-error 且不驱动(fail-closed)
- **当** `ADMIN_API_KEYS` secret 未配置(首次部署常见、`bindings.ts` 新增字段缺省)
- **那么** 返回 `500 config-error`,**不** fail-open 放行、**不**调用 `runBackfill`;运维须先 `wrangler secret put ADMIN_API_KEYS` 方可驱动

#### 场景:ADMIN_API_KEYS 配为空串/全空白 → 500 config-error 且不驱动
- **当** `ADMIN_API_KEYS` 配置存在但解析出空 allowlist
- **那么** 返回 `500 config-error`(与公共 tier 空 `API_KEYS` 同构),**禁止**退化为「空集 → 每 key 403」或 fail-open 放行

#### 场景:malformed 头 + 未配 ADMIN_API_KEYS → 500 config-error(config-error 前置于 auth 三态)
- **当** `ADMIN_API_KEYS` 未配置/空,且请求带 malformed `Authorization`(非 Bearer / 空 Bearer)
- **那么** 返回 `500 config-error`(配置错误前置)、**非** `401 auth-malformed`;不驱动 backfill

#### 场景:config-error 响应体不向匿名探测泄露 secret 名
- **当** 任一匿名/未授权请求触发 admin config-error(secret 未配)
- **那么** 返回给客户端的响应体**泛化**(仅 `config-error` 码 + 通用 message,**不含** `ADMIN_API_KEYS` 等 secret 名或配置状态);secret 名与诊断细节仅写入服务端日志

#### 场景:公共受保护集合枚举与 /rankings 豁免不受影响
- **当** 引入 `/admin/backfill` 这一 admin tier 端点后
- **那么** 公共受保护端点集合仍恰为 `{/parse, /contribute, /ingest, /ingest/batch}`(其鉴权/挂载顺序/限频/用量需求不变),`/rankings` 仍为该集合外的公开只读豁免端点

### 需求:admin tier 的容器控制为 limit clamp + 幂等有界写,不纳入公共固定窗口限频

admin gate 是专用 authenticate-only 中间件、**结构上不抵达**公共限频与用量门,故 admin tier **不**纳入公共 60/60s 固定窗口限频计数、**不**写公共 `rl:` / `usage:` KV 槽(那会与有界 `limit` 放大的调用数〔分块扫全量约数十次顺序调用〕相冲突而自锁;且公共限频 fail-open、本就不是写端点的容器控制)。admin 写端点的容器控制**必须**为:① route 强制有界 `limit`(见 category-tagging「`limit` 有界」需求)+ ② 幂等有界写(单块子请求受限、可安全重跑)。「不计公共限频」是**结构不变量**(admin gate 不调 `checkRateLimit`),**禁止**未来「好心」给 admin 端点加公共限频而触发自锁。

#### 场景:admin 端点不被公共限频计数阻断
- **当** 运营以脚本循环顺序驱动 admin backfill 至 `nextCursor=null`(可达数十次调用)
- **那么** 这些调用**不**消耗也**不**受公共 60/60s 限频窗口阻断;单次调用的资源边界由有界 `limit` + 幂等写保证

### 需求:每个 admin 路由必须各自挂 admin gate(无前缀 catch-all)

因 Hono `app.use(path)` 按**精确路径**匹配(既有代码注释自陈 `/ingest` 中间件不覆盖 `/ingest/batch`),`/admin/*` 命名空间**禁止**依赖前缀级 catch-all 鉴权:**每个** `/admin/*` 路由**必须**各自挂载 admin gate,且 gate **必须**注册于同路径 handler 之前。新增一个未自挂 admin gate 的 `/admin/*` 路由 = 缺陷(默认裸奔)。

#### 场景:admin gate 精确覆盖其路由
- **当** 为 `POST /admin/backfill` 挂 `app.use('/admin/backfill', adminGate)` 且注册在 `app.post('/admin/backfill', …)` 之前
- **那么** 该端点的鉴权生效;若未来新增 `/admin/<other>` 路由,**必须**为它单独挂 admin gate,**不得**指望 `/admin/backfill` 或任何前缀挂载顺带覆盖

### 需求:admin backfill 调用必须留审计痕迹、响应不外泄全量逐项映射

每次**经鉴权放行**的 `POST /admin/backfill` 调用**必须**输出一条结构化审计日志,含 `{ key 标识(**必须**为 **keyed 哈希**——`HMAC-SHA256(key, 服务端 secret)`、定长截断;`ADMIN_API_KEYS` 是低熵长寿命高权限凭据,裸 `SHA-256` digest 可从泄露日志离线爆破,故须 keyed;**禁止**记录明文或任何 key 子串/前缀), cursor, limit, total/classified/pending/manual/rankable 计数, 时间戳 }`,供事后归因大规模改判。**keyed 哈希所需的服务端 secret(`AUDIT_LOG_HMAC_SECRET`)是必需配置**:未配 / 为空时**必须 fail-close 返回 `500 config-error`(响应体泛化、不含 secret 名;诊断入服务端日志)、禁止驱动 backfill**——**禁止**退化为源码常量盐运行(那不是「服务端 secret」、抗爆破等同无盐)。响应体**必须**只回计数 + `nextCursor`,**禁止**回传逐商品 `results[]` 数组(避免响应体随存量无界膨胀、避免一次性导出全表 product→verdict 映射)。鉴权失败(含 config-error)的调用在 gate 层短路、不进 handler,**本期不为该失败侧新增日志**(沿用既有 governance 失败短路无日志行为;失败=4xx/5xx 短路、零写,可观测性非本期项),故本审计日志**只**覆盖经放行的调用、不与「鉴权前置遮蔽」的不进 handler 语义打架。

#### 场景:经放行的调用产生审计日志(key 仅定长哈希)
- **当** 一次经 admin 鉴权放行的 backfill 调用
- **那么** emit 一条结构化日志含上述字段;key **仅**以定长哈希记录,**禁止**明文或任何前缀子串

#### 场景:未配 AUDIT_LOG_HMAC_SECRET → fail-close 500 config-error
- **当** admin 鉴权放行,但 `AUDIT_LOG_HMAC_SECRET` 未配 / 为空
- **那么** 在驱动 `runBackfill` **之前**返回 `500 config-error`(响应体泛化不含 secret 名),**不**以源码常量盐弱化运行、**不**驱动 backfill;诊断(哪个 secret 缺)仅入服务端日志

#### 场景:响应只回计数 + 游标
- **当** backfill 区间执行完返回
- **那么** 响应体含计数(total/classified/pending/manual/rankable)+ `nextCursor`,**不含**逐商品 `results[]`
