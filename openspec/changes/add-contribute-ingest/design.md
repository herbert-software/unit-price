## 上下文

`packages/db` 已完成持久层(D1 schema、`createDb`、`createRepository` 含 `upsertRaw`/`saveParsed`/`getProduct`/`saveCorrection`、可移植类型、迁移 SQL `drizzle/0000_*.sql`、单测),但 `apps/api` **从未 import 它**。基础设施其实已就位:

- `apps/api/src/bindings.ts` 已声明 `DB?: D1Database`(注释「production pipeline; not consumed by /parse」)。
- `apps/api/wrangler.toml` 为 dev/preview/prod 三套环境各配了 `[[d1_databases]] binding = "DB"`(真实 `database_id`)与 `migrations_dir = "../../packages/db/drizzle"`。
- `apps/api/src/index.ts` 的 `buildApp()` 是 Workers/Node 共用的 app 工厂;`makeLlm` 已是「按请求从 `c.env` 构造端口」的范式;`server.ts`(Node dev)注入 no-op 治理且 `Bindings.DB` 缺省。
- `orchestrate(input, llm)` 返回 `{ kind: 'ok'|'insufficient'|'config-error', response?: { spec, unitPrice, confidence, warnings } }`。`saveParsed` 需要 `{ rawId, spec, calc }`,而 `calc: CalcResult = { unitPrice, confidence, warnings }` —— 正好能从 `orchestrate` 响应零成本组装。

因此本变更**不新写解析/计算/持久逻辑**,只做「编排 + 注入 + 路由」。合规面:`/contribute` 属架构 §7「众包上报(中)」档——仅落用户主动贡献的当前商品,无服务端主动爬取,且受 API key + 限频约束。

## 目标 / 非目标

**目标:**
- `POST /contribute`:`RawProduct` + 溯源 → `upsertRaw` → 复用 `orchestrate` → `saveParsed` → 返回 `/parse` 响应体附 `rawId`/`productId`/`unitPriceId`。
- 把 `Repository` 按请求从 `c.env.DB` 注入(与 `makeLlm` 同范式),Workers 注真实 D1、Node dev 无 DB → `persistence-error`。
- `/contribute` 纳入 `api-governance` 受保护端点集合(鉴权 + 限频 + 用量)。

**非目标:**
- `/rankings`(读出/榜单)、`/corrections`(纠错)、`/compare` 与 core `comparability` ——全部留待小程序需求明确后的后续变更。
- 改动 `packages/core`(零改动)、`packages/db` repository 契约(仅消费)、`/parse` 既有契约。
- 新建任何表或品类结构(`tag`/`comparison_group` 等)。

## 决策

**D1：注入路径用 `makeRepo?: (env) => Repository | null` 工厂,而非共享单例。**
理由:与既有 `makeLlm` 对称,逐请求从**本请求**的 `c.env.DB` 解析,避免 Workers isolate 跨请求 env 串(与 `makeLlm` 注释同因)。`buildApp()`(生产)wire `(env) => createRepository(createDb(env.DB))`;`server.ts`(Node dev)不传 `makeRepo`(或传 `() => null`),于是 `/contribute` 走 `persistence-error` 分支——本地无需连库即可继续 smoke `/parse`。
- 备选(否决):在模块顶层建一个全局 repo 单例。Workers 多 isolate/多环境下会绑错库或复用过期 binding,且与 `makeLlm` 的逐请求范式不一致。

**D2：观测优先——`upsertRaw` 先于 `orchestrate`,raw 永不因解析失败回滚。**
理由:原始上报是众包最珍贵资产,LLM 抖动时也要留住观察以便重解析(架构数据飞轮)。`saveParsed` 仅在 `orchestrate` 返回 `ok` 时执行。代价是出现「raw 已落、parse 未落」的中间态——可接受,后续可批量重解析补 `product`/`unit_price`。
- 备选(否决):全 or 无(parse 成功才落 raw)。LLM 故障期会丢失全部上报,违背「先收集数据」的业务目标。

**D3：新增 error code `persistence-error`(500),与 `config-error`(500) 区分。**
理由:`api-governance` spec 要求 error code 两两可断言。DB 未绑定/写失败(`createDb`/`upsertRaw`/`saveParsed` 抛错)与「LLM 未配置」是不同根因,同为 500 但需可区分。LLM 配置错误沿用 `orchestrate` 既有的 `config-error`;DB 类失败统一 `persistence-error`。其余 `invalid-request`/`insufficient-information`/`internal` 复用 parse-api。

**D4：请求体 = 领域字段 + 溯源字段,`store`/`storeSku` 在请求层强制非空。**
理由:去重键 `(store, store_sku)` 的确定性依赖二者非空;`repository.upsertRaw` 内有 `DedupeKeyGate` 兜底,但在 API 请求 schema 即拒空可给客户端清晰的 `400 invalid-request`(而非穿透到 repo 抛 ZodError)。`title`/`price` 复用 parse-api 既有校验语义。

**D5:`saveParsed` 的 `calc` 由 `orchestrate` 响应组装,不重算。**
`calc = { unitPrice: res.unitPrice, confidence: res.confidence, warnings: res.warnings }`,`spec = res.spec`。符合「AI/API 层不计算、`per100ml` 从 core 输出直存」的铁律。不可计算(`per100ml=null`/`formula=null`)照常落库(`CalcResultGate` 接受两者同为 null)。

## 风险 / 权衡

- [raw 落地但 parse 失败留下「无 product 的 raw」] → 这是 D2 的有意中间态;后续变更可加「重解析待补行」批处理。本期 `getProduct` 不受影响(只查有 product 的)。错误响应附 `rawId`,客户端知 raw 已落、重试仅补解析。
- [parse 失败后客户端重试会重新触发 tier2 LLM 成本] → `/contribute` 无内容级解析缓存,`insufficient`/`config-error` 时重报同一脏标题会反复烧 LLM。upsert 对 raw 幂等(不堆叠),但 LLM 调用不去重。可接受:`api-governance` 限频按 key 防滥用兜底;正常重试频率的成本可接受。若日后成本敏感,可加 `hash(归一 title+price)` 解析缓存(架构 §5 已规划,非本期)。
- [`makeRepo` 工厂内 `createDb`/`createRepository` 对非法 binding 抛错] → 路由**必须** try/catch 工厂调用,catch → `persistence-error`;否则异常冒泡成框架默认 500/`internal`,使「DB 不可用 → persistence-error」规格撒谎。`env.DB` 缺省走 `null` 短路(不调 `createDb`),与抛错路径都归 `persistence-error`。
- [`/contribute` 比 `/parse` 多一次 DB 往返 + 必然走解析] → 受 `api-governance` 限频约束防滥用;写路径延迟更高可接受(非存活探测路径)。
- [preview/prod 的 D1 库尚未 apply 迁移,端点会 `persistence-error`] → Migration Plan 列出 `wrangler d1 migrations apply`;binding 与 `migrations_dir` 已配好,仅需执行。[手动验证]
- [Node dev 无法端到端验证 `/contribute` 落库] → 单测用 better-sqlite3 内存库覆盖 repository 路径(db 包已有该基座);API 层用注入的 in-memory repo 测路由/错误码,与 `/parse` 测试同模式。

## 迁移计划

1. `apps/api` 加 `@unit-price/db` workspace 依赖。
2. `AppDeps` 加 `makeRepo`;`createApp` 挂 `/contribute` 路由 + governance 中间件;`buildApp()` wire 真实 D1 repo 工厂;`server.ts` 不传(本地 `persistence-error`)。
3. 对 preview / prod D1 执行 `wrangler d1 migrations apply --config apps/api/wrangler.toml`(已有迁移 SQL)。[手动验证]
4. 回滚:`/contribute` 是纯新增端点;摘除路由 + 工厂注入即可回到现状,`/parse` 与既有部署不受影响。

## 待解决问题

- 无阻塞性未决项。`source`/`sourceUrl` 的取值约定(枚举 vs 自由串)沿用 repository 现状(自由 string、可空),待插件接入时再规范化。
