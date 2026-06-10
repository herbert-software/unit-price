> 标 **[手动验证]** 的任务依赖带外资源/真实部署/人工审阅，不可在 CI 机械断言；其余为可自动化/可测任务。

## 1. 运行时无关化（app 工厂 + env 注入）

- [x] 1.1 定义 `Bindings` 类型 `{ OPENROUTER_API_KEY?: string; API_KEYS?: string; DB?: D1Database; GOVERNANCE_KV?: KVNamespace }`（`apps/api`），作为 `c.env` 的形状契约（四者类型层均可选，必填性由注入入口运行期校验）
- [x] 1.2 改 `config.ts`：`loadLlmConfig` / `configPresent` **移除 `process.env` 默认值**、必传显式 `env`，形参类型从 `NodeJS.ProcessEnv` 改为 `Bindings` 子集（脱离 Node 类型）；改全部**三处**无参调用点传入注入的 env：`index.ts:38`(`LazySpecParser`)、`index.ts:52`(`buildApp`)、`llm.ts:75`(`AiSdkSpecParser` 的 `config ?? loadLlmConfig()`)
- [x] 1.3 改 `index.ts`/`routes.ts`：`LazySpecParser` 从请求期 `c.env` 解析配置；**每请求重建或以 env 内容为键 memoize**（禁首请求 env 固化串台），保持 `parse-api` config-error=`500`/`config-error` 与 `503`/`insufficient-information` 两层可区分
- [x] 1.4 更新受影响单测（`routes.test.ts`/`llm.test.ts`）：以注入 env 构造，断言「缺 key 干净标题 200」「缺 key 需 tier2 报 500/config-error」「不同 env 注入互不串台」仍成立
- [x] 1.5 `grep` 校验：业务路由/工厂代码中不再出现 `process.env`/`node:*`/`@hono/node-server` 直接引用（仅入口层允许）

## 2. 双入口（Workers 生产 + Node dev）

- [x] 2.1 新增 `src/worker.ts`：默认导出 `{ fetch(request, env, ctx) }`，调用同一个 app 工厂，注入真实治理实现
- [x] 2.2 改 `src/server.ts`：把 `process.env` 打包成 `Bindings` 形状对象注入 `app.fetch` 的 `env`，注入 no-op 治理，保留 `@hono/node-server`（dev-only）
- [x] 2.3 两入口冒烟：本地 `dev` 与 `wrangler dev`（无 KV/无 `API_KEYS`，注 no-op 治理）下 `/health=200`、干净标题 `/parse` 返回一致单价、不被 `401`/`429` 阻断
- [x] 2.4 生产入口护栏：grep/类型断言 `worker.ts` 不引用 no-op 治理符号；用 miniflare/workerd 对 `worker.ts` 入口级集成测试断言「缺 key→`401`、合法 key→放行、超限→`429`」（防误注 no-op 致全放行）

## 3. 治理中间件（鉴权 / 限频 / 用量）

- [x] 3.1 治理设计为**可注入依赖**接 app 工厂：定义治理接口 + 真实实现 + 放行式 no-op 实现（dev 用）
- [x] 3.2 API key 鉴权中间件：从约定头读 key（`Authorization: Bearer` 优先于 `X-API-Key`，非 Bearer 形态归 `auth-malformed`），缺失→`401 auth-missing`、格式非法→`401 auth-malformed`、未登记→`403 auth-forbidden`（error code 与 parse-api 既有 `invalid-request`/`config-error`/`insufficient-information`/`internal` 两两不同）；`/health` 豁免整条治理链；key 校验对 `API_KEYS` allowlist。**真实治理初始化时 `API_KEYS` 空/缺 → fail-fast 或 `500 config-error`，禁静默全 403**
- [x] 3.3 限频中间件（**挂在鉴权之后**）：`GOVERNANCE_KV` 固定窗口计数 `rl:<key>:<windowStart>`、TTL=窗口，超限→`429 rate-limited + Retry-After`，按 key 隔离，超限不进解析链路；**`GOVERNANCE_KV` 故障 fail-open（放行 + 告警），禁 fail-closed**
- [x] 3.4 用量计数（鉴权后、业务前）：放行（admission）调用对该 key 计 `GOVERNANCE_KV`（key/计数/时间元数据，禁含 title/price），计数口径含后续落 500/503 的放行请求（非「成功」计数）；写入失败只告警、不把 200 降级
- [x] 3.5 中间件按 **鉴权→限频→用量→业务** 顺序挂载；加测试断言未鉴权请求不写任何限频计数、鉴权前置遮蔽 config-error（缺 OPENROUTER_API_KEY + 缺客户端 key → 先 401）
- [x] 3.6 中间件单测（miniflare mock KV）：覆盖缺 key(401)/格式非法含非 Bearer(401)/未登记(403)/合法放行/health 全豁免/超限 429/按 key 隔离/窗口恢复/**KV 故障 fail-open**/用量写失败不影响响应/`API_KEYS` 缺失→config-error；**用量正向断言**：放行一次后断言 `GOVERNANCE_KV.put` 被调用且入参含 key/计数/时间、不含 title/price

## 4. wrangler 配置与 D1/KV 绑定

- [x] 4.1 **[手动验证]** 开通 Cloudflare 资源：production+preview D1 实例、KV namespace，记录资源 id（带外）
- [x] 4.2 写 `apps/api/wrangler.toml`：`DB`+`GOVERNANCE_KV` binding、production/preview 环境分层（各自资源 id）、`migrations_dir` 指向 drizzle 输出，不含任何明文密钥，binding 名与 `Bindings` 类型一致。**钉死路径基准**：wrangler 按 **`wrangler.toml` 所在目录**解析 `migrations_dir`，故值为 `../../packages/db/drizzle/`；所有 `wrangler` 调用（本地与 CI）必须显式 `--config apps/api/wrangler.toml` 或以 `apps/api/` 为工作目录，**禁止**依赖调用 cwd 偶然正确
- [x] 4.3 **[手动验证]** `wrangler secret put OPENROUTER_API_KEY` 与 `API_KEYS`——**production 与 preview 各配一份**（带外一次性）
- [x] 4.4 **[手动验证]** 先验证 `wrangler d1 migrations apply --local` 能吃 drizzle 输出：①容忍 `meta/` 子目录 ②原样接受 `--> statement-breakpoint` 注释 ③接受 `0000` 起始编号（wrangler `create` 约定 0001 起，须确认 apply 接纳现有 `0000_*.sql`）；三项全过则直指、任一不过则启用脚本化 derive fallback；fallback 派生目录必须**二选一钉死归属**：要么 build-time ephemeral（`.gitignore`、CI 每次重生）、要么 committed 并纳入与 `packages/db/drizzle` 同口径的 drift gate（防派生目录陈旧漂移而 CI 不报）。再验幂等重跑无副作用（wrangler `d1_migrations` 跟踪）、迁移步失败显式失败+告警
- [x] 4.5 CI/脚本 guard：确认无 `drizzle-kit migrate` 指向生产/preview binding（防裸 `CREATE TABLE` 重放撞表）

## 5. CI/CD（push-to-deploy）

- [x] 5.1 扩展 `.github/workflows`：PR 跑 build/test + `wrangler deploy --dry-run`（或 preview 部署）；走 preview 部署时**在部署前对 preview D1 `migrations apply`**（避免 preview Worker 与 preview D1 schema 漂移）；不碰生产、不跑生产迁移
- [x] 5.2 main 部署作业：build → 生产 D1 `migrations apply` → `wrangler deploy`，用 `cloudflare/wrangler-action`，`CLOUDFLARE_API_TOKEN` 经 Actions secret 注入，任一步失败即失败。**所有 wrangler 调用显式 `--config apps/api/wrangler.toml`（或设工作目录 `apps/api/`）**，使 `migrations_dir` 的 `../../` 在 CI 内正确命中 `packages/db/drizzle/`（防「本地验过、CI 找不到迁移目录」）
- [x] 5.3 **[手动验证]** 审阅 CI 配置确认无 `set -x`/`echo` 泄漏 secret；记录 `wrangler rollback`（迁移为向前兼容增量、不随回滚撤销）到变更说明

## 6. 端到端验证

- [x] 6.1 **[手动验证]** 首次手动 deploy 后冒烟：`/health=200`、带合法 key 的 `/parse` 真实 LLM 路径返回契约（per100ml/formula/confidence/warnings）
- [x] 6.2 **[手动验证]** 治理端到端：无 key→401、未登记→403、超限→429+Retry-After、合法 key 正常；用量计数可见（KV 故障 fail-open 由 3.6 miniflare 单测覆盖——生产 KV 无法主动注入故障，不在生产冒烟验证）
- [x] 6.3 `pnpm -r build` 与各包 `test` 全绿；更新 `apps/api`/`packages/db` README 的部署/迁移说明（不写开发过程语境）
