## 1. runBackfill 确定性全序游标分块(apps/api;查询在 tagging.ts 对共享 ORM 句柄构建,无 packages/db 源改动)

- [x] 1.1 `listProductsForBackfill` **扩参为 `(db, { cursor?, limit? })`**(现为单参 `(db)`,`runBackfill` 调用点须透传),加 `ORDER BY product.id` 并下推 keyset 游标 + limit:`WHERE product.id > :cursor ORDER BY product.id LIMIT :limit`(无 cursor=从头;读自身只 1 子请求,不再全量重读);游标按数据库**文本**排序
- [x] 1.2 `runBackfill(repo, db, opts?)` 增可选 `{ cursor?, limit? }`:带参处理 `(cursor, +limit]` 区间;**无参=全序全量仅为库/单测契约**(保持现两参签名与现有单测),不暴露为 HTTP 行为
- [x] 1.3 `BackfillResult` 增 `nextCursor: string | null`:本次读到行数 `< limit`(游标耗尽)→ `null`;否则 = 本块最大已处理 `product.id`,且**必须严格 `> 入参 cursor`**(单调前进);无参全量 → `null`
- [x] 1.4 实测并文档化每商品最坏 D1 子请求数(**含** `resolveComparableUnit` 沿 is-a 树上行找最近非空 `comparable_unit` 的最坏跳数 + `reconcileCategory` 的 product 读 + `loadCategoryLeafTagIds` + 每 leaf/pending/属性 slug 的 `loadTagBySlug` + 末尾 batch);据公式 `1 + limit×最坏 ≤ 50` 定 `ADMIN_BACKFILL_DEFAULT_LIMIT` 与 `_MAX_LIMIT`(初定 5;实测更高则下调;升高须先确认 PAID,注释对齐 `MAX_BATCH`)

## 2. POST /admin/backfill 路由 + 独立 admin 鉴权 tier(apps/api)

- [x] 2.1 `bindings.ts` 加 `ADMIN_API_KEYS?: string` **+ 审计 HMAC 的 keying 输入**(独立 `AUDIT_LOG_HMAC_SECRET?: string` 或部署 salt env,**与 `ADMIN_API_KEYS` 不同源**);`wrangler.toml` 文档化两 secret(经 `wrangler secret put` 设、不明文)
- [x] 2.2 admin gate(两条接缝分开):**接缝① allowlist 源参数化**——把 `governance.ts` 的 `parseAllowlist` 从硬读 `env.API_KEYS` 改为接受**源选择**(binding 名/解析串),`extractKey`/三态映射/空 allowlist→`config-error` 分支经**封装式共享**(参数化 factory 或单一内部 helper 被公共中间件与 admin gate 同调,**保持私有、不裸 export 头解析器**);公共调用点传 `API_KEYS`、admin 传 `ADMIN_API_KEYS`;**禁止**复制/重写头解析。**共享 config-error 分支对两 tier 都输出泛化 client message**(如 `service configuration error`),secret 名/「哪源空」诊断仅入服务端日志,**不**把现 `governance.ts:128` 含 `API_KEYS` 字面回客户端(既有公共测试只断言 error code `'config-error'`、不断言 message body,故泛化**不破**既有断言、是**新增**泛化断言非改既有)。**接缝② 专用 authenticate-only admin 中间件**——只跑 `authenticate(admin 源)`→失败 return/成功 `next()`,**不调** `checkRateLimit`、**不调** `recordUsage`、**不设** `govKey`(不复用 `governanceMiddleware`;admin handler 亦不读 `govKey`)。fail-closed:`ADMIN_API_KEYS` 未配/空 → `500 config-error`(**按 admin 源判定**、**前置于任何 `extractKey` 派生 auth 三态**,malformed 头亦然)、**禁止** fail-open
- [x] 2.3 `routes.ts` 新增 `app.post('/admin/backfill', …)`:严格解析 `{ cursor?, limit? }`(`limit` 正整数 `>=1`,`0`/负/非整数→`400`;仿 `RankingsQuerySchema`),**缺省 `limit` 注入 `ADMIN_BACKFILL_DEFAULT_LIMIT`**、`limit` clamp 到 `_MAX_LIMIT`,**恒走分块、禁止透传缺省成无参全量**;调 `runBackfill`,响应**只回计数 + `nextCursor`**(投影掉 `results[]`)
- [x] 2.4 挂 `app.use('/admin/backfill', adminGate)` 于路由定义**前**,保证鉴权(含 config-error)前置于任何 `runBackfill` 调用
- [x] 2.5 每次**经放行**的调用 emit 结构化审计日志 `{ key 标识(**仅** keyed 哈希 `HMAC-SHA256(key, 服务端 secret)`/部署 salt、定长截断;无明文/无前缀子串), cursor, limit, 计数, 时间戳 }`(沿用 `console.warn` 结构化先例)

## 3. 治理与路由测试(apps/api)

- [x] 3.1 admin 鉴权测试:缺 key→401 auth-missing、非法格式→401 auth-malformed、仅公共 `API_KEYS` 登记的 key→403 auth-forbidden(权限分离)、合法 admin key 放行;**`ADMIN_API_KEYS` 未配置/空串→500 config-error 且不驱动**(fail-closed);**`ADMIN_API_KEYS` 空但 `API_KEYS` 非空 → 仍 500 config-error**(按 admin 源判定、不假通过);**malformed `Authorization` + 未配 `ADMIN_API_KEYS` → 500 config-error 非 401**(config-error 前置于 auth 三态);config-error 响应体不含 secret 名;带 malformed `Authorization` + 合法 `X-API-Key` 不绕过(Authorization 不回退);所有失败在 `runBackfill` 前短路(不写)
- [x] 3.2 公共集合回归:`/parse /contribute /ingest /ingest/batch` 鉴权/限频/用量与 `/rankings` 豁免**不受** allowlist 源参数化影响(公共仍读 `API_KEYS`,auth/rate/usage 逐位不变);**新增**「公共 `API_KEYS` 空→config-error 响应体泛化、不含 secret 名」断言(锚住 message 重构;既有公共测试只断言 error code、本条是净新增非改既有);admin 调用**不**消耗公共 60/60s 限频窗口、**不**写公共 `rl:`/`usage:` KV 槽
- [x] 3.3 游标分块测试:多块顺序驱动到 `nextCursor=null`,**起始快照行集合覆盖恰好一次**(每个快照 `product.id` 出现在恰一块、无漏无重,不只计数相等);**块间插入 id > 当前游标的行→本轮纳入**;**块间插入 id < 当前游标的行→本轮不纳入、不影响快照行覆盖**(顺延下轮);**存量为 limit 整数倍**时末尾多一次 0 行空读才得 `null`;每块 `nextCursor` 严格 `>` 入参;无参全量(库直调)→ `nextCursor===null` 且覆盖全表
- [x] 3.4 `limit` 边界测试:`limit=0`/负/非整数→400;超大 `limit` 被 clamp 到上界;**缺省 limit → 注入默认、走分块(非全量单扫)**;单块重跑幂等
- [x] 3.5 写集 + 响应投影测试:打标签后**断言 attribute `product_tag` 边也被写**(回归守「品类归属与属性标签」、写集未被窄成只 category 叶);`c.json` 响应体含计数 + `nextCursor`、**不含** `results` 键;审计日志含字段且 key **仅定长哈希**(无明文、无前缀子串)

## 4. 验证与收尾

- [x] 4.1 `pnpm --filter api test` 全绿;`pnpm -r build`/类型检查通过
- [x] 4.2 grep 强锚:`app.use('/admin/backfill'` 在中间件挂载列表;`runBackfill` 确有路由驱动(非仅 re-export);**route handler 的 `c.json(...)` 响应体字面量不含 `results` 键**(收紧锚点,不误伤内部对 `BackfillResult.results` 的合法计数读)
- [x] 4.3 运维 runbook(写入 docs):合并部署 + 设 `ADMIN_API_KEYS` secret 后,以脚本循环 `POST /admin/backfill`(缺省 limit)带 `nextCursor` 推进直到 `null`;机械完成判据 = **游标单调推进到 `nextCursor=null`、且累计处理覆盖 bootstrap 起始快照存量的每个 id 至少一次**(续跑期并发 ingest 的新行落入下一轮 sweep、不计入本轮分母);**注**:存量恰为 limit 整数倍时,末尾会观测到一次 `total:0` 且 `nextCursor=null` 的空读=正常终止信号、非错误
- [ ] 4.4 `/opsx:archive` 前:确认 prod 首轮 backfill 已实跑、达成 4.3 的覆盖判据;**记录** backfill 前后 `manual`(待人工)绝对计数作**观测项**(非归档门——tier1 对某批恰好全不命中时 manual 可能持平而逻辑仍正确;门只是覆盖判据)
