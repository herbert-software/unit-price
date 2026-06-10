# deployment

## 目的

把 `apps/api` 从绑死 Node 的走读骨架，部署为运行在 **Cloudflare Workers** 上的公网 API：应用与运行时解耦、配置经 Worker `env` binding 注入、`wrangler.toml` 声明 D1/KV 绑定与环境分层、`packages/db` 迁移在生产 D1 上可复现执行、push-to-`main` 经 CI/CD 自动部署。本节为待定占位，详见各需求。

## 新增需求

### 需求:应用必须运行时无关并提供 Workers 入口

`apps/api` 必须把 Hono 应用拆为**运行时无关的 fetch 应用工厂**与**入口适配层**两部分。app 工厂产出标准 `fetch`-兼容应用，**禁止**在模块作用域或请求路径中直接依赖 Node-only API（含全局 `process.env`、`node:*` 内置、`@hono/node-server`）。生产入口必须是导出 `fetch(request, env, ctx)` 的 **Cloudflare Workers 模块**；本地 dev 入口（Node）必须复用**同一个** app 工厂，仅在入口层桥接运行时差异。两个入口产出的 `/health`、`/parse` 行为必须一致。

治理（鉴权/限频/用量）必须作为**可注入依赖**接入 app 工厂（与 LLM 端口同理），**禁止**在工厂内硬编码为必依赖 `GOVERNANCE_KV`/`API_KEYS` 的实现——使纯本地 dev（无 KV、无 allowlist）能注入一个**放行式 no-op 治理**，让 `/parse` 冒烟不被 `401`/`429` 阻断；生产入口注入真实治理实现。

**生产 Worker 入口必须注入真实治理，禁注 no-op（公网裸奔防线）**：放行式 no-op 治理一旦误注入生产入口（`worker.ts`），公网 API 即**完全无鉴权/无限频**，且 `/health` 与带/不带 key 的 `/parse` 冒烟**都会通过**、无法察觉。因此必须有一条**可机械断言的护栏**——`worker.ts` 不得引用 no-op 治理符号（grep/类型标记可查），并以 miniflare/workerd 对 `worker.ts` 入口级集成测试断言「缺 key→401、合法 key→放行、超限→429」，**禁止**把这条生产主路径只压在 [手动验证] 上。

#### 场景:同一应用工厂被两个入口复用
- **当** 检查 `apps/api` 的源码组织
- **那么** 必须存在一个不依赖 Node-only API 的 app 工厂，被 Workers 入口与本地 Node dev 入口分别引用；业务路由代码中**禁止**出现 `process.env`/`node:*`/`@hono/node-server` 的直接引用

#### 场景:本地 dev 注入 no-op 治理后 /parse 冒烟可通
- **当** 纯本地 dev（`pnpm --filter api dev` 或 `wrangler dev` 未绑 KV/未配 `API_KEYS`）注入放行式治理后，POST 一个干净标题
- **那么** `/parse` 必须正常返回单价，**禁止**因缺 `GOVERNANCE_KV`/`API_KEYS` 而被治理中间件打成 `401`/`429`/`5xx`

#### 场景:生产入口注真实治理且有护栏
- **当** 检查 `worker.ts`（生产入口）的治理装配 + 入口级集成测试
- **那么** `worker.ts` **禁止**引用放行式 no-op 治理符号；必须有 miniflare/workerd 集成测试断言生产入口下「缺 key→`401`、合法 key→放行、超限→`429`」，使「误注 no-op 致全放行」可被自动检出

#### 场景:Workers 入口导出 fetch handler
- **当** 部署目标为 Cloudflare Workers
- **那么** 入口模块必须默认导出含 `fetch(request, env, ctx)` 的对象，由 Workers 运行时调用，返回与本地 Node 入口一致的 `/health`、`/parse` 响应

### 需求:配置必须经注入的 env 而非全局 process.env

LLM 配置（`OPENROUTER_API_KEY` 等）必须**经显式传入的 env 对象**读取：Workers 路径下 env 来自 fetch handler 的 `env` binding，本地 dev 路径下由入口层从 `process.env` 取值后注入。**禁止**在 app 工厂或路由模块作用域读取全局 `process.env`。

**配置必须按请求从注入的 env 解析，且跨请求互不串台**：因 Workers 模块加载期没有 env，配置只能在请求期从 `c.env` 取——这是对 `parse-api` 推荐的「启动期 fail-fast」的**有意运行时偏离**（Workers 无模块期 env，无法在启动期读 key），但运行期行为契约不变。**默认每请求重建** LLM 端口（对象构造极廉价、零串台风险）；若实现选 isolate 内 memoize，**键必须覆盖完整 LLM config（`OPENROUTER_API_KEY` + model + baseURL）**，**禁止**「首个到达请求的 env 被固化、污染后续不同 env 的请求」，也**禁止**用过粗的键（如仅 model）导致不同 key 串台。

配置缺失语义必须遵循 `parse-api` 的**契约层**约束——缺 `OPENROUTER_API_KEY` 是**配置错误**，必须返回与「信息不足」**两层可区分**的 `5xx`（不同 HTTP 子码或不同 error code）。**实现层**沿用既有 `routes.ts` 的 `config-error`(HTTP `500`) 与 `insufficient-information`(HTTP `503`)（503/500 是当前实现取值、非 parse-api spec 钉死的契约，移植时保持不变即可）；干净标题（tier1 即可算）必须在无 key 时仍正常返回 `200`。

#### 场景:Workers env binding 注入配置
- **当** Worker fetch handler 收到请求，`env.OPENROUTER_API_KEY` 由 wrangler secret 提供
- **那么** 应用必须从该注入的 env 读取配置，**不得**触碰全局 `process.env`；请求进入 tier2 时使用该 key

#### 场景:不同 env 注入互不串台
- **当** 同一 isolate 内先后收到两个携带不同 LLM 配置 env 的请求（或 dev 与测试注入不同 env）
- **那么** 每个请求必须使用**各自**注入的 env 解析配置，**禁止**第一个请求的 env 被 memoize 后用于后续不同 env 的请求

#### 场景:缺 key 时干净标题仍可用
- **当** 生产/本地均未配置 `OPENROUTER_API_KEY`，客户端 POST 一个 tier1 即可算的干净标题（如 `可口可乐 330ml*24听`, price 40）
- **那么** 必须返回 `200` 与正确单价（不触发 tier2），**禁止**因缺 key 而对干净标题报错

#### 场景:缺 key 且需 tier2 时报可区分的配置错误
- **当** 未配置 `OPENROUTER_API_KEY`，且请求需要 tier2 补全（tier1 有 shape 但未独立满足计算必需集，或纯品名）
- **那么** 必须返回 HTTP `500` + error code `config-error`，与「信息不足」的 `503`/`insufficient-information` 在两层均可区分，不得伪装成 transport 失败

### 需求:wrangler 配置必须声明绑定与环境分层

`apps/api` 必须含 `wrangler.toml`，声明：生产 D1 数据库 binding（`DB`）、治理用的 KV namespace binding（`GOVERNANCE_KV`，承载限频计数 + 用量计数），以及 **production 与 preview 的环境分层**（各自独立的 D1/KV 资源 id）。`OPENROUTER_API_KEY` 与 `API_KEYS`（治理 allowlist）**禁止**写入 `wrangler.toml`，必须经 `wrangler secret put` 带外设为 runtime secret；`CLOUDFLARE_API_TOKEN`（部署凭据）经 CI Actions secret 注入。secret 必须 **production 与 preview 各配一份**——`OPENROUTER_API_KEY` 在 preview 同样需要配置，否则 preview 的 `/parse` 一旦触 tier2 行为未定义。`wrangler.toml` 引用的 binding 名必须与应用代码 `Bindings` 类型读取的名字（`DB` / `GOVERNANCE_KV`）一致。

#### 场景:绑定与代码一致且不含明文密钥
- **当** 检查 `apps/api/wrangler.toml`
- **那么** 必须声明 `DB`（D1）与 `GOVERNANCE_KV`（KV）binding，且 production/preview 分别指向不同资源 id；文件中**禁止**出现任何 API key / token / `OPENROUTER_API_KEY` / `API_KEYS` 明文；声明的 binding 名与应用代码读取的名字一一对应

#### 场景:preview 与 production 各配齐 secret
- **当** 配置 preview 与 production 两套环境
- **那么** `OPENROUTER_API_KEY` 与 `API_KEYS` 必须**各环境各配一份**（指向各自资源），**禁止**只配 production 而让 preview 的 tier2 / 鉴权处于未定义态

### 需求:生产 D1 迁移必须可复现执行

`packages/db` 已有的迁移必须能通过 `wrangler d1 migrations apply` 在生产与 preview D1 上执行，**幂等且可复现**（重复执行不重复建表/不报错）。

**迁移目录与幂等机制的接力契约（必须明确，避免与 `persistence` spec 冲突）**：drizzle-kit 在 `packages/db/drizzle/` 生成迁移 SQL，文件名形如 `0000_name.sql`（数字前缀与 wrangler 有序迁移命名兼容）。`wrangler.toml` 应把 `migrations_dir` 指向该 drizzle 输出目录、令 wrangler 直接应用同一批 SQL。**路径解析基准必须钉死**：wrangler 按 `wrangler.toml` 所在目录解析 `migrations_dir`（故值为 `../../packages/db/drizzle/`），且所有 `wrangler` 调用（本地与 CI）必须经 `--config apps/api/wrangler.toml` 或以 `apps/api/` 为工作目录执行——**禁止**依赖调用 cwd 偶然正确，否则「本地验过、CI 迁移找不到目录」。**但「wrangler 直吃 drizzle 输出目录」的完整兼容性是必须先验证的假设、不得当既成事实**：drizzle 输出含 `meta/` 子目录（`_journal.json`/快照）与 SQL 内 `--> statement-breakpoint` 标记（`--` 注释）。task 4.4 **[手动验证]** 必须在依赖「直指」前确认 `wrangler d1 migrations apply --local` 能容忍 `meta/` 子目录、原样接受 `statement-breakpoint` 注释；**若不兼容，fallback** = 部署流程加一步**脚本化**从 drizzle 输出 derive 一个 wrangler 兼容目录（剥 `meta/`、规整语句），该脚本必须防漂移（CI 校验派生目录与 drizzle 输出同源），而非手维护副本。

**生产/preview 幂等由 wrangler 自有的 `d1_migrations` 跟踪表保证**（wrangler 是生产 D1 的**唯一**迁移执行器）。这与 `persistence` spec 钉死的「幂等由 drizzle journal `__drizzle_migrations`」**不冲突且互不感知**——后者只治理**本地** `drizzle-kit migrate`（本地 SQLite 文件），生产 D1 上 drizzle journal **从不存在**。**关键风险**：因 drizzle 生成裸 `CREATE TABLE`（无 `IF NOT EXISTS`，见 `persistence`），一旦有人对生产 D1 误跑 `drizzle-kit migrate`，drizzle 因查无自己的 journal 会从 `0000` 重放、撞「table already exists」。故必须**机制性**禁止——不止文档禁令，CI/脚本须有 guard 确认无 `drizzle-kit migrate` 指向生产 binding。迁移一律走 wrangler 对 D1 binding 执行，作为部署流程**显式步骤**，非应用启动时隐式建表。

**preview 环境迁移生命周期**：preview D1 的迁移必须在 **PR 的 preview 部署步骤**中执行（preview 部署前 `wrangler d1 migrations apply` 对 preview binding），不得只靠一次性手动迁移——否则 preview 部署了读新列的 Worker 而 preview D1 未迁移会 schema 漂移。

#### 场景:迁移经 wrangler 幂等执行
- **当** 对一个已迁移过的 D1 再次运行 `wrangler d1 migrations apply`
- **那么** 必须无副作用地成功（wrangler `d1_migrations` 跟踪表标记已应用的迁移被跳过、不重放 `CREATE TABLE`），表结构与 `packages/db` schema 一致

#### 场景:wrangler 直吃 drizzle 输出经验证或走 fallback
- **当** 配置 `migrations_dir` 指向 `packages/db/drizzle/`
- **那么** 必须先 [手动验证] wrangler 能容忍 `meta/` 子目录与 `statement-breakpoint` 注释；验证通过则直指、**禁止**手维护漂移副本；验证不通过则启用脚本化 derive 的 fallback（带 CI 防漂移校验）

#### 场景:生产迁移不走 drizzle-kit 直连（机制性禁止）
- **当** 检查部署/迁移流程与 CI/脚本
- **那么** 生产/preview D1 的迁移必须通过 `wrangler d1 migrations apply` 对 binding 执行；必须有 guard 确认无 `drizzle-kit migrate` 指向生产/preview binding（防裸 `CREATE TABLE` 重放撞表）

#### 场景:迁移半完成态的恢复路径
- **当** 单次 `wrangler d1 migrations apply` 在多条 `CREATE TABLE` 中途失败（D1 DDL 非完整事务），留下半建 schema、wrangler 未标记该迁移已应用
- **那么** 因 SQL 是裸 `CREATE TABLE`，直接重跑会撞「table already exists」；恢复路径必须明确为**手动介入**（清理半建对象后重跑，或对该迁移做一次性修复），**禁止**假装重跑自动幂等掩盖此态——部署流程须在迁移步骤失败时显式失败并告警，不带病继续 deploy

#### 场景:回滚时已迁移 schema 对旧 Worker 向前兼容
- **当** 部署流程为「先 migrate、后 deploy」，迁移成功但 `wrangler deploy` 失败、回滚到上一个 Worker 版本（迁移**不**随回滚撤销）
- **那么** 已应用的迁移必须对旧 Worker 代码**向前兼容**（迁移为加表/加可空列等增量，旧代码不读新列即可正常运行），**禁止**让一次失败部署使生产 schema 与运行中的旧代码不兼容。注：向前兼容是对**未来**迁移的约束，其强制（禁 drop/rename 列）属后续 enforcement，本期唯一迁移 `0000`（建表）天然满足

### 需求:CI/CD 必须支持 push-to-deploy

`.github/workflows` 必须在 push 到 `main` 时自动部署到 Cloudflare Workers 生产环境：步骤含构建、对生产 D1 应用迁移、`wrangler deploy`。CI **只需** `CLOUDFLARE_API_TOKEN`（Actions secret）来执行 deploy 与迁移；`OPENROUTER_API_KEY`/`API_KEYS` 是 **Worker runtime secret、经 `wrangler secret put` 带外设置、不随每次 deploy 重注**，**禁止**在 CI 步骤里注入它们。Pull Request 上**禁止**部署生产，只跑构建/测试与 wrangler dry-run（或 preview 部署）。任一步骤失败必须使工作流失败（不得静默放过）。

#### 场景:main push 触发生产部署
- **当** 提交合入 `main`
- **那么** 工作流必须依次构建、应用生产 D1 迁移、`wrangler deploy`，仅 `CLOUDFLARE_API_TOKEN` 经 Actions secret 注入（runtime secret 带外、不在 CI），全程无明文

#### 场景:PR 不部署生产
- **当** 一个 Pull Request 触发 CI
- **那么** 必须运行构建/测试与 wrangler dry-run/preview，**禁止**对生产环境执行 `deploy` 或生产 D1 迁移
