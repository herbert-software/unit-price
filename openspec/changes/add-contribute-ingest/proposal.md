## 为什么

众包数据飞轮的服务端**写入路径还没接通**。`packages/db`(D1 schema + repository `upsertRaw`/`saveParsed` + 可移植类型 + 迁移 SQL)已完整并有单测,但 `apps/api` 至今**未 import `@unit-price/db`**——`Bindings.DB` 声明了、`wrangler.toml` 三套环境的 D1 binding 也配了真实 id,却没有任何端点消费它。结果是:真实上报无处落地,中心库恒空,无法「收集足够数据」。

Phase 3 的业务前提是**先有数据**:对比/榜单/小程序都依赖中心库里已沉淀的真实商品。因此第一步只做**写入闭环**——让用户/插件上报的 `RawProduct` 经解析计算后沉淀进 D1。读出(榜单)与对比留到小程序需求明确后再做。

## 变更内容

- **新增 `POST /contribute`**:接收 `RawProduct` + 溯源字段(`store`/`storeSku` 等)→ `upsertRaw` 落 `product_raw`(去重键 `(store, store_sku)`)→ **复用现有 `orchestrate`**(tier1 正则 + tier2 LLM + tier3 计算)→ `saveParsed` 落 `product`(`ParsedSpec` 派生)+ `unit_price`(`CalcResult`)→ 返回 `/parse` 结果体附持久化 id(`rawId`/`productId`/`unitPriceId`)。
- **把 `@unit-price/db` 接进 `apps/api`**:`createApp` 增加按请求从 `c.env.DB` 构造 `Repository` 的注入口(与现有 `makeLlm` 同模式,逐请求构造避免 isolate 跨请求 env 串)。Workers 生产入口注入真实 D1;Node dev 入口 `DB` 缺省 → `/contribute` 返回确定的 `persistence-error`(本地不连库,与 LLM 的 `config-error` 两两可区分)。
- **观测优先的落地语义**:`upsertRaw` 先行——原始观察是最珍贵的众包资产,即使后续解析因 LLM 故障失败,raw 行仍保留以便日后重解析。`saveParsed` 仅在 `orchestrate` 成功(`ok`)时写入。
- **治理覆盖到 `/contribute`**:鉴权 + 限频 + 用量从 `{/parse}` 扩到 `{/parse, /contribute}`(api-governance 的鉴权/限频/用量/挂载顺序四条需求一并按受保护端点集合泛化);`/health` 仍豁免整条链。

## 功能 (Capabilities)

### 新增功能
- `contribute-ingest`: `POST /contribute` 众包写入端点的契约——请求体(`RawProduct` 领域字段 + `store`/`storeSku`/`source`/`sourceUrl`/`capturedAt` 溯源字段)、`upsertRaw → orchestrate → saveParsed` 流水、成功响应附三个持久化 id、错误状态语义(沿用 parse-api 的 `config-error`/`insufficient-information` + DB 不可用/写失败 → 新增 `persistence-error`,与 `config-error` 两两不同)、以及「raw 先落地、parse best-effort」的观测优先规则。**不含** `/rankings`/`/corrections`/`/compare` 与读出/榜单查询。

### 修改功能
- `api-governance`: 受保护端点集合从 `{/parse}` 扩展为 `{/parse, /contribute}`——鉴权、限频、用量、挂载顺序**四条需求**均按集合泛化(`/contribute` 同样要求合法 API key、计入限频与用量、超限/缺 key 时禁止进入 ingest 流水即禁止 `upsertRaw`);`/health` 仍豁免整条治理链;既有 `/parse` 鉴权语义与 error code 不变。

## 影响

- **代码**:`apps/api/src/routes.ts`(新增 `/contribute` 路由 + 请求/响应 Zod schema,治理中间件**先于** handler 注册)、`apps/api/src/index.ts`(`buildApp` wire `createRepository(createDb(env.DB))`)、`apps/api/src/server.ts`(Node dev 不注入 repo,本地 `/contribute` 走 `persistence-error`)、`AppDeps`(新增 `makeRepo` 注入口)、`apps/api/src/governance` 挂载点扩到 `/contribute`。
- **依赖**:`apps/api/package.json` 新增 workspace 依赖 `@unit-price/db`;经由它引入 drizzle d1 方言(已在 db 包内)。
- **数据/运维**:D1 迁移(`packages/db/drizzle/0000_*.sql`)需对 preview/prod 库 `wrangler d1 migrations apply`(binding 与 `migrations_dir` 已配好,仅需执行)。[手动验证]
- **合规面**:触碰**众包上报**敏感面(架构第七节「中」档)——仅落「用户主动贡献的当前商品」,无服务端主动爬取;`/contribute` 受 API key + 限频约束。
- **不触碰**:`packages/core`(纯函数无改动)、`packages/db`(repository 契约不变,仅被消费)、`/parse` 既有契约、`apps/extension`/`apps/miniapp`(尚不存在)。
