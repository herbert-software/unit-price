## 1. 接通 @unit-price/db 依赖

- [x] 1.1 `apps/api/package.json` 加 workspace 依赖 `@unit-price/db`(`workspace:*`),`pnpm install` 后确认可值导入 `createDb`/`createRepository`、类型导入 `import type { Repository }`
- [x] 1.2 `apps/api/tsconfig` project references 加 `packages/db`(若用 TS references),`pnpm --filter @unit-price/api build`(`tsc -b`,即类型检查)通过

## 2. 注入 Repository(与 makeLlm 同范式)

- [x] 2.1 `apps/api/src/routes.ts` 的 `AppDeps` 增加可选 `makeRepo?: (env: Bindings) => Repository | null`(逐请求构造,不共享单例)
- [x] 2.2 `apps/api/src/index.ts` 的 `buildApp()` wire `makeRepo: (env) => env.DB ? createRepository(createDb(env.DB)) : null`(生产注真实 D1)
- [x] 2.3 `apps/api/src/server.ts`(Node dev)不传 `makeRepo`(或传 `() => null`),确认本地 `/parse` 仍正常、`/contribute` 走 persistence-error 分支

## 3. /contribute 请求/响应 schema(Zod)

- [x] 3.1 在 `routes.ts` 定义 `ContributeRequestSchema`:领域 `title`(min 1)/`price`(`z.number().finite()`——仅挡 NaN/±Inf,**负价/0 价合法放行**,沿用 parse-api 走 200+per100ml=null)/`categoryHint?`,溯源 `store`(min 1)/`storeSku`(min 1)/`source?`/`sourceUrl?`/`capturedAt?`(`z.number().int()` epoch ms,不接受 ISO 串);types 从 schema 推导。**禁止**对 price 加 `.positive()`/`.min(0)`
- [x] 3.2 定义 `ContributeResponseSchema` = `ParseResponseSchema` 字段 + `rawId`/`productId`/`unitPriceId`(均 string min 1),返回前校验

## 4. /contribute 路由编排

- [x] 4.1 **先** `app.use('/contribute', governanceMiddleware(deps.governance))`、**再** `app.post('/contribute', …)`——Hono 按注册顺序匹配,中间件必须在 handler **之前**注册才会包裹该路由(与既有 `/parse` 同序,见 `routes.ts:55→57`)。顺序写反 → `/contribute` 裸奔无鉴权,视为 blocker
- [x] 4.2 解析 + 校验请求体:非 JSON / schema 失败 / 空 `store`/`storeSku` → `400 invalid-request`
- [x] 4.3 取 repo:用 `try { repo = deps.makeRepo?.(c.env) } catch → 500 persistence-error`(工厂内 `createDb`/`createRepository` 对非法 binding **会抛错**,必须 catch 映射为 `persistence-error`,不可让异常冒泡成框架默认 500/`internal`);`repo` 为 null(DB 未绑定)同样 → `500 persistence-error`
- [x] 4.4 `await repo.upsertRaw({ store, storeSku, raw: {title,price,categoryHint}, source, sourceUrl, capturedAt })` 取 `rawId`(观测优先,先落 raw);upsert 抛错 → `500 persistence-error`
- [x] 4.5 `orchestrate(input, deps.makeLlm(c.env))`:`config-error` → `500 config-error`;`insufficient` → `503 insufficient-information`(raw 已保留,不回滚)。**此两类错误响应体须附已落地的 `rawId`**(告知客户端原始观察已沉淀、重试仅为补解析;重试经 upsert 幂等收敛到同一行,但会**重新触发 tier2 LLM**——成本由 api-governance 限频兜底)
- [x] 4.6 `ok` 时组装 `calc = { unitPrice, confidence, warnings }`,`await repo.saveParsed({ rawId, spec: res.spec, calc })`;saveParsed 抛错 → `500 persistence-error`
- [x] 4.7 组装响应(`spec`/`unitPrice`/`confidence`/`warnings` + 三 id),过 `ContributeResponseSchema` 校验失败 → `500 internal`,否则 `200`

## 5. apps/api 单测(与 routes.test.ts 同模式,注入 in-memory repo)

- [x] 5.1 用 better-sqlite3 内存库经 `createDb`/`createRepository` 造真实 repo 注入;测合法上报 → `200` + 三 id,且 `product_raw`/`product`/`unit_price` 各落一行
- [x] 5.2 测缺 `store`/`storeSku`/空串 → `400 invalid-request`,未写任何行
- [x] 5.3 测同 `(store, storeSku)` 重复上报 → `product_raw` 仅一行、`price`/`captured_at`/`title` 覆盖为最近一次;**且**(**首次上报须带非空** `source`/`sourceUrl`/`categoryHint`,否则 COALESCE(null,null) 平凡通过、断言无判别力)重报省略这三列时按 COALESCE **保留首次非空值**(不被 null 覆盖)——断言两种语义都成立(去重收敛 + provenance 保留)
- [x] 5.4 测不可计算商品(非体积单位)→ `200`、`unitPrice.per100ml=null`、`unit_price` 行 `per100ml` 为 NULL
- [x] 5.5 测 `makeRepo` 返回 null(无 DB)→ `500 persistence-error`,与 LLM 缺失的 `config-error` 区分
- [x] 5.6 测 orchestrate `insufficient`/`config-error` 时 raw 仍保留(查 `product_raw` 有行),返回对应 503/500
- [x] 5.7 测错误码两两不同:把 `/contribute` 业务码 `{invalid-request, config-error, insufficient-information, persistence-error, internal}` 与治理码 `{auth-missing, auth-malformed, auth-forbidden, rate-limited}` **合并成全集**断言两两不同;并显式断言 `persistence-error ≠ config-error`(DB 不可用 vs LLM 缺失)。注:`config-error` 在治理环(API_KEYS 缺)与业务环(LLM 缺)**同码双源**,二者靠中间件顺序(鉴权先于业务)区分、非靠码区分——测试注释点明,不要求二者码不同
- [x] 5.8 测错误响应体含 `rawId`:orchestrate `insufficient`/`config-error` 的 503/500 响应体带 `rawId`,且与 `product_raw` 实际落地行 id 一致
- [x] 5.9 测非目标边界:断言应用本变更后路由仅 `{/health, /parse, /contribute}`(无 `/rankings`/`/corrections`/`/compare`);迁移后表集合仅 `{product_raw, product, unit_price, corrections}`,未新增 `tag`/`product_tag`/`comparison_group` 等(沿用 persistence「不引入品类表」检查模式)

## 6. 治理覆盖 /contribute 的回归

- [x] 6.1 `governance.test.ts`(或 routes 测)补:`/contribute` 缺 key → `401 auth-missing`,且**禁止** `upsertRaw`/LLM(用 spy 断言未调用)
- [x] 6.2 补:`/contribute` 未登记 key → `403 auth-forbidden`;合法 key → 放行;`/health` 仍豁免
- [x] 6.3 `worker.test.ts` 入口级:确认生产 `buildApp()` 对 `/contribute` 挂的是真实治理(沿用既有 wide-open guardrail 断言模式)

## 7. 迁移与端到端验证

- [x] 7.1 对 preview D1 执行 `wrangler d1 migrations apply --config apps/api/wrangler.toml --env preview`,确认 4 张表建成 [手动验证]
- [x] 7.2 部署 preview 后,带合法 key `curl POST /contribute` 一条山姆饮料样本,确认 `200` + 三 id,并查 D1 三表各落一行 [手动验证]
- [x] 7.3 prod 库执行同迁移(`--env production`),保留为上线门槛 [手动验证]

## 8. 收尾

- [x] 8.1 `pnpm --filter @unit-price/api test` + `pnpm --filter @unit-price/api build`(`tsc -b` 类型检查)全绿
- [x] 8.2 `openspec-cn validate add-contribute-ingest --strict` 通过
- [x] 8.3 README/部署文档补 `/contribute` 端点与请求体字段(沿用 `/parse` 文档风格,不写开发过程语境)
