## 为什么

`apps/api` 已能在本地跑 `POST /parse`，但只是一个绑死 Node 的走读骨架：`server.ts` 用 `@hono/node-server`、`config.ts` 直接读 `process.env`，没有 `wrangler.toml`、没有 D1 生产绑定、没有部署流水线，也没有任何对外访问治理。它**还不是一个可对公众开放的 API**。

架构 SOT（`docs/architecture.md` §5）把后端定位为「公众 API（对外开放，也是所有客户端的后端）」，持久层（`packages/db`）从一开始就按 **Cloudflare D1** 设计（SQLite 方言、D1 binding 由 Worker 注入、miniflare/workerd 测试）。现在要把这条无状态计算链路**真正部署到公网**，落到与 D1 一致的 Cloudflare Workers 运行时，并加上公众 API 的最低治理（鉴权 / 限频 / 用量），这是 Phase 1 的收尾交付。

## 变更内容

- **运行时移植**：把 Hono 应用从 Node 专用入口移植为**运行时无关的 fetch 应用** + Cloudflare Workers 入口。配置不再读全局 `process.env`，而是由 Worker fetch handler 的 `env` binding 注入（本地 dev 仍可跑，见非目标）。**BREAKING**：`loadLlmConfig`/`configPresent` 已有 env 形参，本次**移除其 `process.env` 默认值**、把调用点（`LazySpecParser`/`buildApp`，现无参调用）改为**必传**注入的 env。
- **wrangler + D1 生产绑定**：新增 `apps/api/wrangler.toml`，绑定生产 D1 数据库（`DB`）与治理用 KV（`GOVERNANCE_KV`）、`migrations_dir` 指向 `packages/db/drizzle/`；`OPENROUTER_API_KEY` 与 `API_KEYS`（治理 allowlist）改为 wrangler secret；`packages/db` 已有的迁移通过 `wrangler d1 migrations apply` 在生产/preview D1 上执行。
- **CI/CD 自动部署**：扩展 `.github/workflows`，push 到 `main` 时 `wrangler deploy`，含 secrets 注入与 D1 迁移步骤；PR 上跑 preview/dry-run。
- **公众 API 治理**：新增请求期中间件——API key 鉴权（`401`/`403` + 枚举 error code）、按 key 限频（`429`，KV 故障 fail-open）、用量计数。中间件按 鉴权→限频→用量 顺序挂载、可注入（dev 注 no-op）。`/health` 与 `/parse` 的既有契约不变，`/health` 豁免整条治理链。

## 功能 (Capabilities)

### 新增功能
- `deployment`: Cloudflare Workers 部署能力——运行时无关的 fetch 应用与 Worker 入口、env 经 binding 注入而非全局 `process.env`、`wrangler.toml` 与 D1/KV 绑定、生产/preview 环境分层、secrets 管理、D1 迁移在生产执行、push-to-deploy 的 CI/CD。
- `api-governance`: 公众 API 治理——API key 鉴权（缺失→`401`/格式非法→`401`/未登记→`403`，error code 枚举且与 parse-api 既有码可区分）、按 key 限频（超限 `429` + `Retry-After`，KV 故障 fail-open）、用量计数；中间件按 鉴权→限频→用量 顺序、可注入，`/health` 豁免整条链，不改 `/parse` 的业务契约。

### 修改功能
<!-- 无 capability 级修改：parse-api 的行为契约（请求/响应 schema、HTTP 状态语义、config-error 可区分性）与运行时无关，移植到 Workers 不改变 spec 级行为，仅换 env 来源与入口，属实现细节。persistence 的 schema/迁移定义不变，本次只是在生产 D1 上用 wrangler 执行它。
     注：有**内部 API** BREAKING（`config.ts` 的 `loadLlmConfig`/`configPresent` 移除 `process.env` 默认值），但非 capability/spec 级，见 design 风险段。 -->

## 影响

- **代码**：`apps/api/src/{server,index,config,routes}.ts`——拆出运行时无关的 app 工厂、新增 Worker 入口、config 改为接收注入的 env、治理中间件挂到 Hono 应用。
- **新增文件**：`apps/api/wrangler.toml`、Worker 入口（如 `src/worker.ts`）、治理中间件模块、`.github/workflows` 部署作业。
- **依赖**：新增 `wrangler`（dev 依赖）；`@hono/node-server` 降为仅本地 dev 用途；治理限频/用量用 `GOVERNANCE_KV`（无新 npm 运行时依赖）。
- **平台/配置**：需要 Cloudflare 账号、生产/preview D1 实例、`GOVERNANCE_KV` namespace、GitHub Actions 中的 `CLOUDFLARE_API_TOKEN`，以及 production/preview 各一份的 `OPENROUTER_API_KEY` 与 `API_KEYS` wrangler secret。
- **合规敏感面**：不触碰抓取/众包面——本次仍是**无状态按需计算 API**（架构 §7 最低风险层）；D1 虽在生产绑定，但持久层端点（`/contribute`/`/rankings`）不在本次范围（见非目标）。治理用量计数只记录调用元数据（key、计数、时间），不落商品数据。

## 非目标

- **不接持久层业务端点**：`/contribute`、`/rankings`、`/corrections` 等 Phase 3 端点不在本次范围；本次只部署无状态的 `/parse`。D1 虽绑定+迁移，但 `/parse` 保持无状态、不消费它（治理用量走 `GOVERNANCE_KV`、不走 D1）。
- **不验证 `DB` binding 的运行期正确性**（已知边界）：因 `/parse`/治理本期都不读 D1，`worker.ts` 若漏配/错配 `DB` 资源 id，本期冒烟无法察觉——`DB` binding 的连通性校验**推迟到 Phase 3**（首个消费 D1 的端点落地时随其验证）。本期只保证 `wrangler.toml` 声明了 `DB` 且迁移管道跑通，不保证运行期 binding 指向正确。
- **不做服务端主动爬取 / 众包数据采集**（架构 §7 红线）。
- **不做复杂治理**：不做计费、配额套餐、多租户控制台、OAuth；治理止于「API key + 限频 + 用量计数」。
- **不删除本地 Node dev 路径**：`pnpm --filter api dev` 的本地体验保留（经运行时无关的 app 工厂跑在 Node 上），只是生产入口换成 Worker。
- **不做多商店 / Surge / 复杂品类**（Phase 4）。
