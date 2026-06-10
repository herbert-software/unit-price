# @unit-price/api

无状态解析 API：把脏商品标题 + 价格经三段式解析（tier1 正则 → tier2 AI → tier3 确定性计算）算出可回放的单价。应用是**运行时无关的 Hono fetch 工厂**，由两个薄入口复用：Cloudflare Workers（生产）与 Node（本地 dev）。两入口产出的 `/health`、`/parse` 行为一致，仅在入口层桥接运行时差异与治理装配。

## 入口

| 入口 | 文件 | 用途 | 治理 |
| --- | --- | --- | --- |
| 生产 | `src/worker.ts` | Cloudflare Workers 模块（默认导出 `{ fetch(request, env, ctx) }`），由 Workers 运行时调用，配置经 `env` binding 注入 | 真实治理 |
| 本地 dev | `src/server.ts` | Node 入口（`@hono/node-server`，dev-only），把 `process.env` 打包成 `Bindings` 形状注入 `app.fetch` 的 `env` | 放行式 no-op |

`process.env` 与 `@hono/node-server` 只出现在 `server.ts` 入口层；app 工厂与路由从不触碰它们。

## 本地运行

```sh
pnpm --filter @unit-price/api dev    # tsx src/server.ts，监听 :8787（PORT 可覆盖）
```

本地 dev 注入放行式 no-op 治理：无 KV、无 `API_KEYS` 时 `/parse` 冒烟不被 `401`/`429` 阻断。`OPENROUTER_API_KEY` 经环境变量传入，仅当请求进入 tier2 时才需要——干净标题（tier1 即可算）缺 key 也返回 `200`。

## 配置与 secret

配置经**注入的 `env`**（而非全局 `process.env`）按请求读取：Workers 路径下来自 fetch handler 的 `env` binding，Node dev 路径下由入口层从 `process.env` 取值后注入。

| 名称 | 类型 | 注入方式 |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | runtime secret | `wrangler secret put`，production 与 preview **各配一份** |
| `API_KEYS` | runtime secret（治理 allowlist，逗号分隔） | `wrangler secret put`，production 与 preview **各配一份** |
| `CLOUDFLARE_API_TOKEN` | CI 凭据 | GitHub Actions secret |
| `DB` | D1 binding | `wrangler.toml` 声明 |
| `GOVERNANCE_KV` | KV binding（限频 + 用量计数） | `wrangler.toml` 声明 |

`wrangler.toml` 只放资源 id，**不含任何明文密钥**。`OPENROUTER_API_KEY`/`API_KEYS` 经 `wrangler secret put` 带外设置、不随每次 deploy 重注。preview 同样需配齐二者，否则 preview 的 tier2/鉴权处于未定义态。

`wrangler.toml` 声明的 binding 名（`DB`、`GOVERNANCE_KV`）与应用代码 `Bindings` 类型读取的名字一一对应。

设置 secret 示例（须显式 `--config`，理由见「wrangler 调用基准」）：

```sh
wrangler secret put OPENROUTER_API_KEY --env production --config apps/api/wrangler.toml
wrangler secret put API_KEYS           --env production --config apps/api/wrangler.toml
wrangler secret put OPENROUTER_API_KEY --env preview    --config apps/api/wrangler.toml
wrangler secret put API_KEYS           --env preview    --config apps/api/wrangler.toml
```

## 治理

`/parse` 受治理链保护，按 **鉴权 → 限频 → 用量 → 业务** 顺序挂载；`/health` 豁免整条链。

- **鉴权**：从 `Authorization: Bearer <key>` 读 key（`Authorization` 存在即权威，非 Bearer 形态归 malformed）；`Authorization` 缺失时回退 `X-API-Key`。key 校验对 `API_KEYS` allowlist。真实治理初始化时 `API_KEYS` 空/缺按配置错误处理（`500 config-error`），不静默把合法 key 全打成 `403`。
- **限频**：挂在鉴权之后，`GOVERNANCE_KV` 固定窗口计数（`rl:<key>:<windowStart>`，TTL=窗口），超限返回 `429` + `Retry-After`，按 key 隔离。`GOVERNANCE_KV` 故障时 **fail-open**（放行 + 告警），不把 KV 抖动放大成全量 `429`/`5xx`。
- **用量**：放行后计 `GOVERNANCE_KV`（key/计数/时间元数据，不含 title/price）；写入失败只告警，不把 `200` 降级。

错误码（与 parse-api 既有码两两不同，便于机械区分）：

| code | HTTP | 来源 |
| --- | --- | --- |
| `auth-missing` | 401 | 治理 · 缺 key |
| `auth-malformed` | 401 | 治理 · key 格式非法（含非 Bearer） |
| `auth-forbidden` | 403 | 治理 · key 未登记 |
| `rate-limited` | 429 | 治理 · 超限（带 `Retry-After`） |
| `invalid-request` | 400 | parse-api · 请求体非法 |
| `config-error` | 500 | parse-api/治理 · 缺 `OPENROUTER_API_KEY`/`API_KEYS` |
| `insufficient-information` | 503 | parse-api · 信息不足、需 tier2 但无法补全 |
| `internal` | 500 | parse-api · 响应校验失败 |

`config-error` 与 `internal` 同为 500，靠 error code 区分。鉴权前置遮蔽 config-error：缺 `OPENROUTER_API_KEY` + 缺客户端 key 时先返回 `401`。

## 部署

部署目标为 Cloudflare Workers + D1。所有 `wrangler` 调用（本地与 CI）必须显式 `--config apps/api/wrangler.toml`（或以 `apps/api/` 为工作目录），因 `migrations_dir` 按 `wrangler.toml` 所在目录解析为 `../../packages/db/drizzle`——不得依赖调用 cwd 偶然正确。

### CI/CD

`.github/workflows/deploy.yml`：

- **Pull Request**：`pnpm -r build`、`pnpm -r test`，再 `wrangler deploy --dry-run --env preview`。不碰生产、不跑生产迁移。fork PR 无需 Cloudflare token。
- **push 到 `main`**：build → 对生产 D1 `wrangler d1 migrations apply DB --env production` → `wrangler deploy --env production`。仅 `CLOUDFLARE_API_TOKEN` 经 Actions secret 注入；runtime secret 带外、不在 CI。任一步失败即工作流失败。

一个 guard 作业（`scripts/check-no-prod-drizzle-migrate.sh`）确认无 `drizzle-kit migrate` 指向生产/preview binding。生产/preview 迁移见 [`packages/db/README.md`](../../packages/db/README.md)。

### 回滚

`wrangler rollback` 回退 Worker 到上一个版本。**迁移不随回滚撤销**——迁移为向前兼容增量（加表/加可空列），旧 Worker 代码不读新列即可正常运行。故「先 migrate、后 deploy」中即便 deploy 失败回滚旧版本，已应用的迁移仍与运行中的旧代码兼容。

## 构建与测试

```sh
pnpm --filter @unit-price/api build   # tsc -b
pnpm --filter @unit-price/api test    # vitest run
```

`worker.ts` 入口级集成测试（miniflare/workerd）断言生产入口下「缺 key→`401`、合法 key→放行、超限→`429`」，并以 grep/类型断言确认 `worker.ts` 不引用 no-op 治理符号（防误注 no-op 致公网全放行）。
