# api-governance 规范

## 目的
待定 - 由归档变更 public-deploy 创建。归档后请更新目的。
## 需求
### 需求:受保护端点必须做 API key 鉴权

受保护端点集合 `{/parse, /contribute, /ingest, /ingest/batch}` 中的**每个**端点都必须要求合法 API key 方可访问。key 经约定请求头（`Authorization: Bearer <key>` 或 `X-API-Key`）传入。鉴权失败必须按下表返回**确定**的 HTTP 状态与 error code（不得二选一），错误体须含该 error code 说明原因，且**禁止**进入该端点的业务链路（`/parse` 的解析链路、`/contribute`/`/ingest`/`/ingest/batch` 的「落 raw → orchestrate → 落 parse」流水均不得进入，亦**禁止**消耗 LLM 调用；对 `/ingest`/`/ingest/batch` 亦**禁止**触发后台解析）：

| 情形 | HTTP | error code |
|---|---|---|
| 未携带 key（无鉴权头） | `401` | `auth-missing` |
| 携带了 key 但格式非法（空/非法字符/非 Bearer 形态） | `401` | `auth-malformed` |
| key 格式合法但不在 allowlist（未登记/已吊销） | `403` | `auth-forbidden` |

这三个 error code 必须与 `parse-api`/`contribute-ingest` 既有码（`invalid-request`/`config-error`/`insufficient-information`/`internal`/`persistence-error`）**两两不同**，使「鉴权失败」与「请求体不合法 4xx」「config/persistence/internal 错误 5xx」在 error code 层面**可区分、可断言**。`auth-missing` vs `auth-malformed` 的判定对**两种头来源统一**：完全无鉴权头 → `auth-missing`；头存在但取不出合法 key 值（`Authorization` 非 Bearer 形态如 `Basic …`、或 `Authorization: Bearer ` 空值、或 `X-API-Key` 为空串/含非法字符）→ `auth-malformed`。同时携带 `Authorization` 与 `X-API-Key` 时以 `Authorization: Bearer` 优先，且**严格优先不回退**——优先源存在但取值非法（如空 Bearer）时直接判 `auth-malformed`，**不**回退去读 `X-API-Key`（消除「优先源取值失败时是否回退次源」的歧义，使断言有唯一期望）。鉴权语义对集合内**每个**端点**完全一致**（同样的头解析、同样的三态判定）。`/health` 必须**豁免整条治理链**（鉴权 + 限频 + 用量均不适用），供存活探测无 key 高频访问。

#### 场景:缺 key 时拒绝
- **当** 客户端 POST `/parse` 未携带任何鉴权头
- **那么** 必须返回 `401` + error code `auth-missing`，**禁止**进入 tier1/tier2/tier3，**禁止**消耗 LLM 调用

#### 场景:/contribute 缺 key 时拒绝
- **当** 客户端 POST `/contribute` 未携带任何鉴权头
- **那么** 必须返回 `401` + error code `auth-missing`，**禁止**进入 ingest 流水（**禁止** `upsertRaw`、**禁止**消耗 LLM 调用）

#### 场景:/ingest 缺 key 时拒绝
- **当** 客户端 POST `/ingest` 未携带任何鉴权头
- **那么** 必须返回 `401` + error code `auth-missing`，**禁止**进入 ingest 流水（**禁止** `upsertRaw`、**禁止**触发后台解析、**禁止**消耗 LLM 调用）

#### 场景:/ingest/batch 缺 key 时拒绝
- **当** 客户端 POST `/ingest/batch` 未携带任何鉴权头
- **那么** 必须返回 `401` + error code `auth-missing`，**禁止**进入批量 ingest 流水(**禁止**对**任何**条目 `upsertRaw`、**禁止**排程后台解析、**禁止**消耗 LLM 调用)

#### 场景:格式非法 key → 401 auth-malformed
- **当** 客户端携带一个格式非法的 key（如空字符串、非 Bearer 形态）
- **那么** 必须返回 `401` + error code `auth-malformed`，与 `parse-api` 的 `invalid-request`(400) 可区分

#### 场景:未登记 key → 403 auth-forbidden
- **当** 客户端携带一个格式合法但不在 `API_KEYS` allowlist 内的 key（未登记/已吊销）
- **那么** 必须返回 `403` + error code `auth-forbidden`

#### 场景:合法 key 放行
- **当** 客户端携带 allowlist 内的 key POST 一个有效请求（`/parse`、`/contribute`、`/ingest` 或 `/ingest/batch`）
- **那么** 鉴权中间件必须放行，请求按该端点既有语义处理，响应契约不变

#### 场景:鉴权前置遮蔽 config-error
- **当** 服务端缺 `OPENROUTER_API_KEY`、且客户端也未携带 API key 的请求到达 `/parse`
- **那么** 必须**先**在鉴权环返回 `401 auth-missing`，`config-error`(500) 分支不被评估——状态码先后由中间件顺序确定

#### 场景:health 豁免整条治理链
- **当** 探测器 GET `/health` 不带 key
- **那么** 必须返回 `200`，不受鉴权/限频/用量任一环节拦截或计数

### 需求:GET /rankings 为受保护集合之外的公开只读端点

`GET /rankings` 必须被归类为**受保护端点集合 `{/parse, /contribute, /ingest, /ingest/batch}` 之外**的公开只读端点，**豁免整条治理链**（鉴权、限频、用量），语义与 `/health` 的豁免同性质：无需 API key 即可访问，不消耗限频计数，不记用量。

该归类**不改变**受保护端点集合的既有治理行为——`{/parse, /contribute, /ingest, /ingest/batch}` 仍各自要求合法 API key、按 key 限频与计量，行为不变。豁免理由：`/rankings` 是只读端点，**禁止**写入、**禁止**调用 LLM、**禁止**触发后台任务，纯读已沉淀的公开众包数据，无写滥用与 LLM 成本面，强制鉴权只增摩擦而无防护收益。

> 备注：本期 `/rankings` 不挂任何限频闸。若未来实测出现读滥用，可另行引入「集外端点的可选宽松限频」，但不在本变更范围。

#### 场景:GET /rankings 不带 key 时放行

- **当** 客户端 `GET /rankings` 不携带任何鉴权头
- **那么** 接口必须返回 `200`（按 rankings-api 既有语义），**禁止**返回 `401 auth-missing` 或 `403 auth-forbidden`，**禁止**在 `GOVERNANCE_KV` 写任何限频/用量计数

#### 场景:/rankings 豁免不影响受保护端点

- **当** 客户端在 `GET /rankings` 公开放行的同时，向 `/parse`、`/contribute`、`/ingest` 或 `/ingest/batch` 发起缺 key 请求
- **那么** 这些受保护端点必须仍按既有治理语义返回 `401 auth-missing`，不得因 `/rankings` 的豁免而被一并放行

### 需求:真实治理初始化必须校验 API_KEYS 配置

生产注入的**真实**鉴权实现初始化时，若 `API_KEYS` secret 缺失/为空，必须 **fail-fast**（启动期）或对受保护端点返回明确的 `500 config-error`，**禁止**静默把 allowlist 当空集、从而把**所有**合法客户端 key 误判为 `403 auth-forbidden`（全量拒绝）。这是**配置错误**（与 `OPENROUTER_API_KEY` 缺失同类），与「`GOVERNANCE_KV` 故障 fail-open」是不同轴——allowlist 缺失是配置问题、不是运行期抖动，不得 fail-open 放行、也不得伪装成 `auth-forbidden`。

注意区分两个 `config-error` 的来源与遮蔽关系：`API_KEYS`-config-error 在**鉴权环**（①）直接产生、**不被前置遮蔽**；而 `OPENROUTER_API_KEY`-config-error 在**业务环**（③）产生、会被鉴权前置遮蔽（缺客户端 key 先得 401）。两者同为 `500 config-error` 码、来源不同。

#### 场景:生产缺 API_KEYS 时报配置错误而非全量 403
- **当** 生产环境注入真实治理但 `API_KEYS` 未配置/为空
- **那么** 必须 fail-fast 或返回 `500 config-error`，**禁止**把携带合法 key 的请求静默打成 `403 auth-forbidden`

### 需求:治理中间件必须按固定顺序挂载

治理三环必须按 **鉴权 → 限频 → 用量 → 业务处理** 的顺序挂载执行，且对受保护端点集合 `{/parse, /contribute, /ingest, /ingest/batch}` 中**每个**端点一致适用。限频判定必须在鉴权**之后**（未通过鉴权的请求**禁止**进入限频计数，以免未登记 key 打爆 `GOVERNANCE_KV` 计数槽）；用量计数必须在放行进入业务前记一次（批量端点的「按落地条数叠加」在业务内进行,不改「准入前记一次」的基线,见「必须记录调用用量」需求）。中间件**必须先于该端点的业务 handler 注册**（在框架按注册顺序匹配中间件的运行时,handler 先于 `app.use` 注册会导致治理被绕过,视为缺陷）。**`/ingest/batch` 与 `/ingest` 是不同路径**（框架精确路径匹配下 `/ingest` 的中间件**不**自动套住 `/ingest/batch`）,故 `/ingest/batch` **必须自行**挂治理中间件、不得依赖 `/ingest` 的挂载。顺序错置（如限频先于鉴权）必须视为缺陷。

#### 场景:未鉴权请求不消耗限频计数
- **当** 一个缺 key / 未登记 key 的请求到达（`/parse`、`/contribute`、`/ingest` 或 `/ingest/batch`）
- **那么** 必须在鉴权环即被 `401`/`403` 拦截，**禁止**进入限频环、**禁止**在 `GOVERNANCE_KV` 写任何该请求的计数

#### 场景:/contribute 治理先于 ingest 流水
- **当** 一个缺 key / 超限的请求 POST `/contribute`
- **那么** 必须在治理环即被 `401`/`403`/`429` 拦截，**禁止**进入 ingest 流水——**禁止** `upsertRaw`（不得在治理拦截前落 raw）、**禁止**消耗 LLM 调用

#### 场景:/ingest 治理先于 ingest 流水
- **当** 一个缺 key / 超限的请求 POST `/ingest`
- **那么** 必须在治理环即被 `401`/`403`/`429` 拦截，**禁止**进入 ingest 流水——**禁止** `upsertRaw`、**禁止**触发后台解析、**禁止**消耗 LLM 调用

#### 场景:/ingest/batch 治理先于批量流水(且未漏挂)
- **当** 一个缺 key / 超限的请求 POST `/ingest/batch`
- **那么** 必须在治理环即被 `401`/`403`/`429` 拦截(证 `/ingest/batch` 确已自挂治理、未因路径不同而漏挂),**禁止**进入批量流水——**禁止**对任何条目 `upsertRaw`、**禁止**排程后台解析、**禁止**消耗 LLM 调用

### 需求:必须按 API key 限频

服务必须对每个 API key 施加请求频率上限（固定窗口计数,计数状态存于 `GOVERNANCE_KV`,key 形如 `rl:<apiKey>:<windowStart>`、TTL=窗口长度）,对受保护端点集合 `{/parse, /contribute, /ingest, /ingest/batch}` 一致适用。**限频按请求计、非按条**：`/ingest/batch` 一次请求(无论含多少条 `items`)只消耗**一个** rate token,与单条端点同口径(批量的 payload 由 `MAX_BATCH` 上限约束、单请求不致放大;按条限频会让一次合法大批量误触发限频)。超过上限的请求必须返回 `429` + error code `rate-limited`,并附 `Retry-After`,其值为**当前窗口的剩余秒数**（`windowStart + 窗口长度 − now`,向上取整;以窗口长度为上界）,告知客户端最早可重试时刻;超限请求**禁止**进入受保护端点的业务链路（`/parse` 解析链路 / `/contribute`/`/ingest`/`/ingest/batch` 的 ingest 流水,即**禁止** `upsertRaw`、对 `/ingest`/`/ingest/batch` 亦**禁止**触发后台解析）、**禁止**消耗 LLM 调用。限频必须**按 key 隔离**（一个 key 超限不影响其他 key）。限频是入口闸:`/ingest`/`/ingest/batch` 的后台 tier2 LLM 总量由它在入口兜住。

`GOVERNANCE_KV` 不可用时,限频必须 **fail-open**（放行该请求并记录告警）,**禁止** fail-closed（**禁止**因 KV 抖动把全部合法请求打成 `429`/`5xx`）——本治理定位为「防滥用」而非「精确配额/计费」,KV 故障期临时失去限频保护是可接受降级,与「用量写失败不降级 200」的 fail-open 取向一致。

#### 场景:超限返回 429 且带重试提示
- **当** 某 key 在计数窗口内的请求数超过配置上限
- **那么** 后续请求必须返回 `429` + error code `rate-limited` + `Retry-After`,**禁止**进入受保护端点的业务链路或调用 LLM

#### 场景:/contribute 超限不落 raw
- **当** 某 key 对 `/contribute` 的请求超过上限
- **那么** 必须返回 `429`,且**禁止** `upsertRaw`（超限请求不得在限频前落 raw,否则限频形同虚设）

#### 场景:/ingest 超限不落 raw 不触发后台
- **当** 某 key 对 `/ingest` 的请求超过上限
- **那么** 必须返回 `429`,且**禁止** `upsertRaw`、**禁止**触发后台解析（超限请求不得在限频前落 raw 或排程解析）

#### 场景:/ingest/batch 一次请求只消耗一个 rate token 且超限不落 raw
- **当** 某 key POST `/ingest/batch`(含 N 条 `items`)
- **那么** 限频只对该请求消耗**一个** token(非 N 个);该 key 超限时必须返回 `429`、**禁止**对任何条目 `upsertRaw`、**禁止**排程后台解析

#### 场景:限频按 key 隔离
- **当** key A 已超限、key B 在限额内同时请求
- **那么** key A 收 `429`,key B 必须正常放行处理——两者计数互不影响

#### 场景:窗口恢复后放行
- **当** 计数窗口过期、该 key 计数重置
- **那么** 该 key 的后续合法请求必须恢复正常处理

#### 场景:KV 不可用时 fail-open 放行
- **当** 限频读/写 `GOVERNANCE_KV` 发生故障
- **那么** 该请求必须被放行（继续走鉴权后的业务）,并记录告警,**禁止**因 KV 故障返回 `429` 或 `5xx`

### 需求:必须记录调用用量

每次经鉴权放行的调用必须计入该 key 的用量,存于 `GOVERNANCE_KV`,对受保护端点集合 `{/parse, /contribute, /ingest, /ingest/batch}` 一致适用。计数粒度为**按 key 累计**（key 标识 + 单调累计计数 + 最近时间戳;如需按时间分桶统计可附加 `usage:<key>:<bucket>`,但累计计数是基线、必须可断言）。用量语义为**「放行（admission）计数」**——在鉴权+限频通过、进入业务**前**记一次,因此**包含**最终落 `500 config-error`/`500 persistence-error`/`503 insufficient`/`202 accepted`/`200` 的各类放行请求（统计的是「被准入处理的调用」,非「成功调用」;`/ingest` 放行后即记一次,与其后台解析成败无关）,实现与断言都按此口径。

**批量端点:准入恒计 1 为基线,落地条数为叠加增量**（与既有「放行(admission)计数」**自洽叠加**,非替换）。对 `/ingest/batch`,用量语义**必须**锚为:**准入恒计 1**（维持既有放行计数基线——覆盖该请求的鉴权放行、含最终落 `500 persistence-error`（含 `accepted=0` 全失败走 500）/`202` 各情形,与既有「放行计数包含 500/202」一致）;在此基线**之上**,`accepted ≥ 2` 时**额外叠加** `amount = accepted - 1`,使该请求总用量 = `accepted`（N 条落地 = N,与同 N 条经 `/ingest` 单条上报 N 次一致,**不绕过**按条统计）。`accepted = 0`（全失败、走 `500`）/`accepted = 1` 时**不叠加**、用量 = 准入的 `1`。机制:`recordUsage` **必须**加可选 `amount` 参数（默认 `1`,**向后兼容**——既有唯一调用点即治理中间件不传 amount → +1,`/parse`/`/contribute`/`/ingest` 用量不变）;中间件 `authenticate` 通过后将 key 暴露给业务 handler 并按既有「准入 +1」计一次,批量 handler 落地 `accepted` 条后**仅当 `accepted > 1`** 调 `recordUsage(env, key, accepted - 1)`（**guard `>1`**:绝不传 `amount ≤ 0`,防 KV 累计 `count` 被减损坏）。叠加同受「用量仅元数据、写入失败只告警、**禁止**改变响应」约束;它是同 key 的第二次非原子计数写、放大既有计数近似窗口,因 metadata-only 而容忍（与 rate-limit 非原子同理念）。

用量记录**仅含调用元数据**,**禁止**记录商品标题/价格等业务数据（治理面不落业务数据,与架构 §7 的无状态计算定位一致）。用量统计的存储**禁止**阻塞或改变受保护端点（`/parse`/`/contribute`/`/ingest`/`/ingest/batch`）的响应契约——计数失败只记告警、不得把一个本应 `200`/`202` 的结果变成错误。

#### 场景:放行调用计入用量
- **当** 一个合法 key 的请求被放行处理（`/parse`、`/contribute`、`/ingest` 或 `/ingest/batch`）
- **那么** 该 key 的用量计数必须增加,记录只含 key/计数/时间元数据,**禁止**含 title/price 等业务字段

#### 场景:用量写入失败不影响业务响应
- **当** 用量计数的写入发生故障
- **那么** 受保护端点仍必须按各自既有语义返回正确结果（`/parse` 按 parse-api;`/contribute`/`/ingest`/`/ingest/batch` 按 contribute-ingest;计数失败只记录告警,**禁止**把 `200`/`202` 降级成 `5xx`）

#### 场景:批量端点按落地条数计用量
- **当** 一个合法 key POST `/ingest/batch`,其中 `N` 条成功 `upsertRaw` 落地（`accepted = N`）
- **那么** `N ≥ 2` 时该 key 用量增加 `N`（准入 1 + 叠加 `N-1`）,与同 key 经 `/ingest` 单条上报 `N` 次的用量增量一致;`N = 1` 时增加 `1`（不叠加）;`N = 0`（全部落地失败、响应走 `500 persistence-error`）时增加 `1`（仅准入,**不**传 `amount ≤ 0`）

