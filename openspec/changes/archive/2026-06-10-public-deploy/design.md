## 上下文

`apps/api` 当前是绑死 Node 的走读骨架：`server.ts` 用 `@hono/node-server`、`config.ts` 在函数默认参数里读 `process.env`、`index.ts` 的 `LazySpecParser` 在首次 parse 时 `loadLlmConfig()`（读全局 env）。只有 `/parse` + `/health` 两个路由，无 DB 接线、无治理、无部署配置。

`packages/db` 从设计起就面向 **Cloudflare D1**（SQLite 方言、D1 binding 由 Worker 注入、有 miniflare/workerd 测试、drizzle.config 注明「生产经 wrangler 对 D1 跑迁移，drizzle-kit 只碰本地 SQLite 文件」）。架构 SOT 也是「CF 优先 / D1」。所以部署目标定为 **Cloudflare Workers + D1**——与持久层既有决策一致，不引入第二套运行时假设。

关键张力：Workers 在**模块加载期没有 `process.env`**，绑定（secret/D1/KV）只在 **fetch handler 的 `env` 参数**里按请求可见。因此「config 读全局 `process.env`」这一前提必须拆掉。

## 目标 / 非目标

**目标：**
- 把 Hono 应用拆成**运行时无关的 app 工厂** + 两个薄入口（Workers 生产 / Node 本地 dev），两入口行为一致。
- 配置经**注入的 env** 读取，移除对全局 `process.env` 的直接依赖。
- `wrangler.toml` 声明 D1 + KV 绑定与 production/preview 分层；secrets 不入库。
- 在生产/preview D1 上经 `wrangler d1 migrations apply` 跑通 `packages/db` 迁移（建立生产 DB 流水线，为 Phase 3 端点铺路）。
- API key 鉴权 + 按 key 限频 + 用量计数，作为前置中间件。
- push-to-`main` 自动部署的 CI/CD。

**非目标：**
- 不接 `/contribute`/`/rankings`/`/corrections`（Phase 3）；`/parse` 保持无状态。
- 不改 `packages/db` 的 schema/迁移定义，也不为治理新增 D1 业务表（治理状态走 KV，见决策）。
- 不做计费/配额套餐/多租户控制台/OAuth；不做精确（强一致）限频。

## 决策

### D1：单一 app 工厂 + 入口适配，env 按请求注入
保留现有 `createApp(deps)` 作为**运行时无关工厂**（Hono 本就可移植）。新增 `src/worker.ts` 默认导出 `{ fetch }`，由 Workers 调用 `app.fetch(request, env, ctx)`——`env` 即 Cloudflare 注入的 binding 集合。`src/server.ts` 保留 `@hono/node-server`，但在入口层把 `process.env` 打包成同形状的 `Bindings` 对象，作为 `env` 注入 `app.fetch`，使 Node 与 Workers 走**同一条** `c.env` 读取路径。

- **替代方案**：在每个入口各构造一套 deps。否决——会出现两份配置装配逻辑，行为易漂移；`c.env` 统一注入只此一处桥接。
- **配置读取时机（避免 isolate 串台）**：把 `LazySpecParser` 改为从**请求期 `c.env`** 解析配置。Workers isolate 跨请求复用，**禁止**「首个请求的 env 被 memoize 后污染后续不同 env 的请求」——若 memoize LLM 端口，须**以 env 内容为键**，或干脆**每请求重建**（对象构造极廉价，默认取此，最简且无串台风险）。理由：Workers 无法在模块加载期拿到 key；按请求 env 是唯一可移植时机。
- **对 parse-api「启动期 fail-fast」的有意偏离**：`parse-api` 推荐缺 key 在启动期 fail-fast、使 `/parse` 运行期不暴露 config-error 分支。Workers 模块期无 env，无法启动期读 key，故**有意**保留运行期 config-error 分支；契约不变：缺 key + 需 tier2 → HTTP `500`/`config-error`，与「信息不足」`503`/`insufficient-information` 两层可区分。

### `Bindings` 形状：`{ OPENROUTER_API_KEY?, API_KEYS?, DB?（D1）, GOVERNANCE_KV?（KV）}`
**四者在类型层均可选**（dev/no-op 路径要缺省），**必填性由注入入口在运行期校验**而非类型层：生产 `worker.ts` 注入真实治理时校验 `API_KEYS`/`GOVERNANCE_KV` 存在（缺 `API_KEYS`→config-error，见治理决策），dev `server.ts` 注 no-op 治理时三者可缺。应用代码读取的 binding 名与 `wrangler.toml` 声明一一对应。`OPENROUTER_API_KEY`（LLM key）与 `API_KEYS`（治理 allowlist，逗号分隔 secret）均为 **secret**；`DB` 为 D1、`GOVERNANCE_KV` 为 KV。仅 `/parse` 无状态路径必用 `OPENROUTER_API_KEY`。

### 治理可注入 + 状态存 KV，不动 D1 业务表
治理（鉴权/限频/用量）作为**可注入依赖**接 app 工厂（与 LLM 端口同理），生产注入真实实现、本地 dev 注入**放行式 no-op** 实现——使无 KV/无 allowlist 的本地与 `wrangler dev` 能跑 `/parse` 冒烟而不被 `401`/`429` 阻断。限频计数器与用量计数放 **`GOVERNANCE_KV`**（同一 KV、命名涵盖两者）；API key 校验走 **`API_KEYS` secret 的 allowlist**（成员判定）。**不**为治理在 D1 新建表。

- **为什么 allowlist 走 secret 而非 KV/D1**：鉴权在热路径每请求都跑，secret 成员判定无 IO；首期 key 少、吊销=改 secret + 重部署（可接受）。**权衡**：即时吊销需求出现时升级到 KV/D1 allowlist（记为后续路径）。
- **为什么限频/用量走 KV 而非 D1**：高频小写、可接受最终一致，KV 是 Workers 天然原语；放 D1 既要扩 schema（牵动 `persistence` spec，违背非目标）又对热路径加同步写。
- **那为什么仍绑定 + 迁移 D1**：scope 要求把**生产 D1 流水线**跑通（绑定 + 迁移在生产执行），这是 Phase 3 落 `/contribute`/`/rankings` 的前置基建——本次建好管道但 `/parse` 不用它，D1 处于「已就绪、未被业务端点消费」态。
- **限频算法与 fail-open**：固定窗口计数，KV key=`rl:<apiKey>:<windowStart>`、TTL=窗口长度，超阈值返回 `429 + Retry-After`（error code `rate-limited`）。`GOVERNANCE_KV` 故障时**fail-open**（放行 + 告警），与「用量写失败不降级 200」取向一致——治理是「防滥用」非「精确配额」，KV 抖动期临时失保可接受，**禁止** fail-closed 把 KV 抖动放大成全量 429/5xx。
- **错误码集**：治理引入 `auth-missing`(401)/`auth-malformed`(401)/`auth-forbidden`(403)/`rate-limited`(429)，与 parse-api 既有 `invalid-request`(400)/`config-error`(500)/`insufficient-information`(503)/`internal`(500) 两两不同，「可区分」可机械断言（`internal` 与 `config-error` 同为 500、靠 error code 区分）。
- **`API_KEYS` 缺失是配置错误**：真实治理初始化时 `API_KEYS` 空/缺 → fail-fast 或 `500 config-error`，**禁止**静默当空 allowlist 把合法 key 全打成 `403`。与「KV 故障 fail-open」不同轴（配置 vs 抖动）。
- **中间件顺序**：鉴权 → 限频 → 用量 → 业务；限频在鉴权后，避免未登记 key 打爆 KV 计数槽。`/health` 豁免整条治理链。受保护端点状态码优先级：`401/403`(鉴权) → `429`(限频) → `400/200/500/503`(业务)；鉴权前置遮蔽 config-error。
- **替代方案**：Durable Objects 做精确滑动窗口限频——更准但更重、更贵，本期对「防滥用」过度。记为后续升级路径。

### secrets：运行时 secret 与 CI 凭据分离，且按环境各配
`OPENROUTER_API_KEY` 与 `API_KEYS` 作为 **Worker runtime secret**，经 `wrangler secret put` 带外设置（不随每次 deploy 重注），**production 与 preview 各配一份**——preview 同样需 `OPENROUTER_API_KEY`/`API_KEYS`，否则 preview 的 tier2/鉴权未定义。CI 只需 `CLOUDFLARE_API_TOKEN` 来执行 deploy 与 D1 迁移。三者均经 GitHub Actions secret / wrangler secret 注入，**禁止**落 `wrangler.toml` 或日志。

- **替代方案**：每次 deploy 用 CI 重新 `secret put` OPENROUTER_API_KEY——更多明文流转面，无收益。否决。

### 迁移执行器接力：drizzle 生成、wrangler 应用（直指经验证、否则脚本 derive）
drizzle-kit 在 `packages/db/drizzle/` 生成迁移 SQL（文件名 `0000_name.sql`，数字前缀与 wrangler 有序命名兼容）；`wrangler.toml` 的 `migrations_dir` 指向该目录、wrangler 直接应用同一批 SQL。**生产/preview 幂等由 wrangler 自有 `d1_migrations` 表保证**（wrangler 是生产 D1 唯一执行器）。

- **「直指」是待验证假设、不是既成事实**：drizzle 输出含 `meta/` 子目录与 SQL 内 `--> statement-breakpoint`（`--` 注释）。按本仓「先验证假设再设计」，实现前 task 4.4 **[手动验证]** `wrangler d1 migrations apply --local` 能否容忍 `meta/`、原样吃 `statement-breakpoint`。**验证通过**→ 直指、防漂移（不手维护副本）；**不通过**→ fallback：部署流程加一步**脚本化** derive 一个 wrangler 兼容目录（剥 `meta/`、规整语句），CI 校验派生与 drizzle 输出同源。被否决的是「手维护漂移副本」，不是「脚本派生」。
- **与 `persistence` spec 是否冲突**：不冲突且互不感知。persistence 钉死的「幂等由 drizzle journal `__drizzle_migrations`」只治理**本地** `drizzle-kit migrate`；生产 D1 上 drizzle journal **从不存在**，幂等全靠 wrangler `d1_migrations`。**风险护栏**：drizzle 生成裸 `CREATE TABLE`（无 `IF NOT EXISTS`），若误对生产 D1 跑 `drizzle-kit migrate` 会从 0000 重放撞表——故 CI/脚本须 guard 无 `drizzle-kit migrate` 指向生产/preview binding（机制性禁止，非仅文档禁令）。本变更**不改** persistence 的 schema/迁移定义。
- **半完成迁移**：单次 apply 多条 `CREATE TABLE` 中途失败（D1 DDL 非完整事务）留半建 schema、wrangler 未标记已应用，重跑撞表；恢复为**手动介入**（清半建对象后重跑），部署在迁移步失败时显式失败+告警、不带病 deploy。
- **preview 迁移生命周期**：preview D1 迁移在 PR preview 部署步骤执行（非一次性手动），避免 preview Worker 与 preview D1 schema 漂移。

### CI/CD：PR 干跑、main 部署
`.github/workflows` 中 PR 跑 build/test + `wrangler deploy --dry-run`（或 preview 部署），**不**碰生产；push 到 `main` 依次 build → `wrangler d1 migrations apply`（生产）→ `wrangler deploy`。用 `cloudflare/wrangler-action`。任一步失败即工作流失败。

### `@hono/node-server` 降级为 dev-only
继续保留以维持 `pnpm --filter api dev` 的本地体验，但不再是生产入口。

## 风险 / 权衡

- **KV 最终一致 + 非原子读改写 → 限频近似、可能漏计数**：固定窗口在窗口边界并发可达 ~2× 配额；KV 无 read-modify-write 原子性，同窗并发可能各读 N、各写 N+1 丢一次计数。→ 缓解：本期定位「防滥用」而非「精确配额/计费」，欠精确可接受；精确需求升级到 Durable Objects（已记为路径）。
- **`GOVERNANCE_KV` 持续故障 → 限频失效窗口**：fail-open 下 KV 持续不可用 = 限频+用量同时短时全失效，存在被滥用窗口（攻击者此期可超额调 tier2 真实花钱）。→ 缓解：fail-open 是「防滥用 vs 可用性」的有意取舍（宁可短时失保也不因 KV 抖动全量 429）；必须告警可观测；持续故障的熔断/降级阈值属后续增强，本期接受瞬时与持续同策略。
- **no-op 治理误注入生产 → 公网裸奔**：放行式 no-op 若被复制进 `worker.ts` → 全放行且冒烟不可察。→ 缓解：`worker.ts` 禁引用 no-op 符号（可 grep/类型断言）+ miniflare 入口级集成测试断言缺 key→401，见 deployment spec。
- **迁移半完成态**：D1 DDL 非完整事务 + 裸 `CREATE TABLE`，中途失败重跑撞表。→ 缓解：迁移步失败即显式失败+告警、不带病 deploy；恢复手动介入。
- **Node 与 Workers env 行为漂移**：两运行时下 `c.env` 来源不同，易出「本地能跑、线上挂」。→ 缓解：单一 app 工厂 + 统一 `c.env` 注入点；对两入口都加 `/health`+干净标题 `/parse` 的冒烟测试。
- **移除 `process.env` 默认值是 BREAKING**：`config.ts` 的 `loadLlmConfig(env = process.env)`/`configPresent(env = process.env)` **已有 env 形参**，BREAKING 的真实面是「**移除 `process.env` 默认值**、把全部无参调用点改为**必传**注入的 env」，而非新增形参。无参调用点共**三处**：`index.ts:38`（`LazySpecParser` 内 `loadLlmConfig()`）、`index.ts:52`（`buildApp` 内 `configPresent()`）、`llm.ts:75`（`AiSdkSpecParser` 构造 `this.config = config ?? loadLlmConfig()`）——三处都须改。→ 缓解：仅内部契约，随本次同步改三处调用点与既有测试。
- **CI 中途失败（迁移成功但 deploy 失败）**：→ 缓解：迁移设计为幂等且加列式向前兼容；回滚=重发上一个 Worker 版本（迁移不回退、对旧版本兼容）。migrate 在 deploy 前执行，避免新代码先于 schema 上线。
- **密钥泄漏面**：toml/CI 日志。→ 缓解：secrets 仅经 `wrangler secret` / Actions secret；toml 只放资源 id；CI 关闭命令回显敏感值。

## 迁移计划

1. 开通 Cloudflare 资源：production + preview D1 实例、KV namespace；记录各资源 id。
2. 写 `wrangler.toml`（`DB`/`GOVERNANCE_KV` binding + 环境分层 + `migrations_dir` 指向 `packages/db/drizzle/`，仅放资源 id）。
3. `wrangler secret put OPENROUTER_API_KEY` 与 `API_KEYS`——**production 与 preview 各配一份**（带外一次性）。
4. 拆 app 工厂 / 改 config 读注入 env / 加 `worker.ts` / 加治理中间件 / 改 `server.ts` 注入 env；同步改测试。
5. 首次手动 `wrangler d1 migrations apply` + `wrangler deploy` 验证生产链路（`/health`、带 key 的 `/parse` 冒烟）。
6. 接 GitHub Actions：PR 干跑、main 自动 migrate+deploy；配 `CLOUDFLARE_API_TOKEN` secret。
7. 回滚策略：`wrangler rollback`（或重发上一版本）；迁移为向前兼容增量，不随回滚撤销。

## 待解决问题

- **API key 的签发/管理**：本期用手工 seed 的 allowlist；是否需要一个签发端点 / 控制台留待后续（与计费一并考虑）。
- **preview 环境粒度**：单一 staging 还是每 PR 一个 preview——先单一 staging，按需再拆。
- **自定义域名 / 路由**：是否本期挂自定义域，还是先用 `*.workers.dev`——倾向先 workers.dev，域名后置。
