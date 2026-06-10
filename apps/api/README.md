# @unit-price/api

无状态解析 API：把脏商品标题 + 价格经三段式解析（tier1 正则 → tier2 AI → tier3 确定性计算）算出可回放的单价。在解析之上提供 `POST /contribute` 众包写入端点，把上报商品落进中心库。应用是**运行时无关的 Hono fetch 工厂**，由两个薄入口复用：Cloudflare Workers（生产）与 Node（本地 dev）。两入口产出的 `/health`、`/parse`、`/contribute` 行为一致，仅在入口层桥接运行时差异与治理装配。

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

## POST /contribute

众包写入端点：接收一条上报商品（领域字段 + 溯源字段），落进中心库（`product_raw` → `product` → `unit_price`），返回与 `/parse` 同形的解析结果**外加**三个持久化 id。编排为「先落 raw → orchestrate → 落 parse」——原始上报是最珍贵的众包资产，即便后续解析失败，已落地的 `product_raw` 行也保留不回滚。本端点不在 API 层重写任何解析或计算：tier1 正则、tier3 计算属 `packages/core`，tier2 属现有 orchestrate，价格/单位换算/可比判断仍由确定性程序决定。

请求体字段（Zod 校验，与 `/parse` 同一份 schema 源）：

| 字段 | 类型 | 必须 | 说明 |
| --- | --- | --- | --- |
| `title` | string（非空） | 是 | 商品标题 |
| `price` | number（有限） | 是 | 价格；仅挡 `NaN`/`±Inf`。**负价/0 价合法**，照常落库、走 `200` + `unitPrice.per100ml=null` + warning |
| `categoryHint` | string | 否 | 品类提示（领域字段，随 `raw` 落库） |
| `store` | string（非空） | 是 | 去重键 `(store, storeSku)` 来源 |
| `storeSku` | string（非空） | 是 | 去重键 `(store, storeSku)` 来源 |
| `source` | string | 否 | 溯源：上报来源 |
| `sourceUrl` | string | 否 | 溯源：来源 URL |
| `capturedAt` | int（epoch ms） | 否 | 抓取时间戳；整数 epoch 毫秒，不接受 ISO 串 |

同 `(store, storeSku)` 再次上报为 upsert：`price`/`title`/`capturedAt` 无条件覆盖为最近一次；`source`/`sourceUrl`/`categoryHint` 按 COALESCE 语义（重报提供新非空值则更新，省略则保留旧值、不被 null 覆盖）。客户端重试安全（经 upsert 幂等收敛到同一 raw 行），但会重新触发 tier2 LLM，其成本由治理限频兜底。

成功响应 `200`，体为 `/parse` 既有响应契约（`spec`/`unitPrice`/`confidence`/`warnings`）**附加** `rawId`/`productId`/`unitPriceId`（均为 app 生成 TEXT id）。响应返回前过 Zod 校验。

错误码：

| code | HTTP | 来源 | rawId |
| --- | --- | --- | --- |
| `invalid-request` | 400 | 请求体非法（`title` 空、`price` 非有限、`store`/`storeSku` 空/缺失）；未写任何行、不进 orchestrate | — |
| `config-error` | 500 | LLM 运行期配置错误（如缺 `OPENROUTER_API_KEY`）；raw 已落地 | 含 |
| `insufficient-information` | 503 | 信息不足无法判定；raw 已落地 | 含 |
| `persistence-error` | 500 | DB binding 缺失/不可用，或落库（`upsertRaw`/`saveParsed`）写失败 | `saveParsed` 失败（raw 已落）含；DB 不可用/`upsertRaw` 失败不含 |
| `internal` | 500 | 响应体未过校验 | — |

凡 raw 已落地后才发生的**业务错误**（`config-error`、`insufficient-information`，以及 `saveParsed` 失败的 `persistence-error`）错误响应体附 `rawId`，告知客户端原始观察已沉淀、重试仅为补解析；raw 未落地的错误（`invalid-request`、DB 不可用/`upsertRaw` 失败的 `persistence-error`）不含 `rawId`。`internal`（响应自身校验失败的防御性兜底，`ok` 结果下实质不可达）虽在 raw 已落后才触发，但作为刻意例外沿用 `{ error, message }` 形态、不附 `rawId`。`persistence-error` 与 `config-error` 同为 500 但 error code 不同：前者是持久层不可用/写失败、后者是 LLM 配置错误，可机械区分。本地 Node dev 不绑定 `DB`，`/contribute` 走 `persistence-error` 分支。

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

受保护端点集合 `{/parse, /contribute}` 同受治理链保护，按 **鉴权 → 限频 → 用量 → 业务** 顺序挂载；`/health` 豁免整条链。

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

### 部署前置（首次，带外）

1. **开通资源**：`wrangler d1 create`（production/preview/dev 各一）、`wrangler kv namespace create`（各环境一个、title 互不相同），把返回的 `database_id` / `id` 回填 `wrangler.toml` 对应块；binding 名保持 `DB` / `GOVERNANCE_KV` 不变。
2. **配 runtime secret**：`OPENROUTER_API_KEY` 与 `API_KEYS`，production 与 preview 各一份（命令见上「配置与 secret」）。
3. **配 CI 凭据**：`CLOUDFLARE_API_TOKEN` 作为 GitHub repo 的 Actions secret（名字须正好为 `CLOUDFLARE_API_TOKEN`，与 `deploy.yml` 对应）。

`CLOUDFLARE_API_TOKEN` 用 **Custom Scoped Token**（Cloudflare → My Profile → API Tokens → Create Custom Token），**不要用 Global API Key**。按本流水线「`wrangler deploy` + `d1 migrations apply --remote`」所需，权限为：

| 权限 | 级别 | 用途 |
| --- | --- | --- |
| Workers Scripts | Edit | `wrangler deploy` 部署 Worker |
| D1 | Edit | `d1 migrations apply --remote` 建表 |
| Workers KV Storage | Edit | Worker 绑定 `GOVERNANCE_KV`，部署时挂载 |
| Account Settings | Read | wrangler 解析账号 / `whoami` |

**Account Resources** 设为 `Include → <你的账号>`（勿留 All accounts）。捷径：用内置模板 **"Edit Cloudflare Workers"**（已含 Workers Scripts/KV/Account Settings），再**手动补一条 `D1 → Edit`**（模板不含 D1）。

验证 scope 是否足够：

```sh
CLOUDFLARE_API_TOKEN=<token> wrangler whoami                                  # 能列出账号
wrangler deploy --dry-run --env production --config apps/api/wrangler.toml    # 不报权限错
```

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
