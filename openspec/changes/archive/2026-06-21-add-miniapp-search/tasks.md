## 1. packages/db — q 过滤下推（无 IO 纯查询构造）

- [x] 1.1 `repository.ts`：`ListRankingsInput` 增可选 `q?: string`（已 trim、已按码点截断的有效搜索词；缺省/空表示不过滤）；**并把 `buildRankingsQuery` 的 `Pick<…,'limit'|'offset'>` 入参类型扩到含 `'q'`**，使 `routes→listRankings→buildRankingsQuery` 的数据线全程类型贯通
- [x] 1.2 `repository.ts`：加纯函数 `escapeLikePattern(s)`，用 `!` 作转义符、把输入里的 `!`/`%`/`_` 各前置 `!`（转义符先转义自己），返回嵌入 `LIKE ? ESCAPE '!'` 的串
- [x] 1.3 `repository.ts`：给 `applyNodeRankingFilter` **签名加第 3 参** `extra?: SQL`（可选谓词），折进它唯一的 `and(<现有谓词>, extra)`（**禁止**第二个 `.where()`——drizzle `.where()` 覆盖、会抹掉 cohort/rankable 守卫）。`buildRankingsQuery` 在 `q` 非空时传入 title 谓词 `` sql`${productRaw.title} LIKE ${'%'+escapeLikePattern(q)+'%'} ESCAPE '!'` ``（`q` 已在 API 层按码点截断，此处只转义、不再截断）；`q` 缺省传 `undefined`（`and()` 丢弃 → 无-q SQL 逐字节不变）。`like` helper 不用（无 escape 选项）
- [x] 1.4 `repository.ts`：`buildRankableCountQuery` 的 `applyNodeRankingFilter` 调用**永远传 `undefined`**（计数保持 q-纯，护 tree N == board N）；`listRankings` 把 `input.q` 透传给 `buildRankingsQuery`
- [x] 1.5 测试 `__tests__/rankings.test.ts`：q 非空时仅返回 title 含子串行、排序仍 per100ml 升序；q 命中跨页分页正确；**q 非空仍保留 cohort/rankable/per100ml 守卫**（不漏跨 cohort、非 rankable 行）
- [x] 1.6 测试：`escapeLikePattern` 单测（`%`/`_`/`!` 按字面匹配、转义符自身正确、不漏配不多配）；并断言**包裹用的 `%…%` 通配符不经 `escapeLikePattern`**（只转义内部用户输入，外层 `%` 仍是通配符，否则全失配）
- [x] 1.7 测试 `query plan (node path)`：① 断言 q 缺省路径 `.toSQL()` 与现状一致（无 LIKE、EXPLAIN 不漂移）；② **新增 q-present 计划断言**——`category_closure`/`unit_price` 仍 `SEARCH ... USING INDEX`；`product_raw` 上 title LIKE 是已经过 PK 到达后的**残余过滤**、**禁止**写「必须 SCAN product_raw」这类脆断言
- [x] 1.8 测试：把改造**前** `buildRankableCountQuery` 的 `.toSQL().sql` 截成内联字面量基线，改造后断言**逐字节一致**（计数不受 q 影响的回归守卫；无既有基线，须同 PR 内先截取）

## 2. apps/api — q 参数校验与转发

- [x] 2.1 `routes.ts`：`RankingsQuerySchema` 增 `q`，按 design.md D2.1 的**确切 Zod 管线**：`.transform(trim)` → `.transform(s => s===''? undefined : s)`（空→`undefined`，**先于** refine）→ `.refine(s => s===undefined || [...s].length>=2)` 否则 `400` → `.transform(截断到 64 码点)` → `.optional()`。全程按码点 `[...s]`（非 `.length`）。次序固定：空必须落 `undefined`、单字必须 `400`、不得反（现有 schema 是 `z.object` 非 `.strict`，`q` 纯增量无冲突）
- [x] 2.2 `routes.ts`：把校验后的 `q` 透传给 `repo.listRankings({ limit, offset, category, q })`；cohort 守卫与 limit/offset 边界顺序不变（守卫先于 q）。**缓存按校验后的 `q` 判定**：`q` 非 `undefined`（真过滤）→ 发显式 `Cache-Control: no-store`（仅省略 `public` 不够，CDN 会按默认 TTL 自缓存）；`q` 为 `undefined`（缺省/`?q=`/`?q=%20%20`）→ 与无-q 一样发 `PUBLIC_CACHE_CONTROL`
- [x] 2.3 测试 `routes.test.ts`：`?q=可乐`→listRankings 收到截断后 `q`；`?q=水`(单字)→`400`；`?q=`/`?q=%20%20`/`?q=　`(全角空格)→不过滤（`undefined`）；`?q=<70 码点>`→截断 64；含代理对(emoji/`𠮷`)按码点计长不误判、不在 64 边界劈裂；含字面 `%`/`_`/`!`/`+`(如 `100+200`)经 `ESCAPE`+`encodeURIComponent` 按字面匹配；`?q=可乐&category=alcohol`→`400`（守卫优先）；**`?q=可乐` 响应带 `no-store`、`?q=%20%20` 与无 `q` 带 `PUBLIC_CACHE_CONTROL`**

## 3. packages/api-client — URL 序列化（响应 schema 不变）

- [x] 3.1 `client.ts`：`buildRankingsUrl` 接受可选 `q`，非空时作为 `q=` 追加（沿用既有 param 序列化与 `cleanOrigin` 校验）；`RankingsResponseSchema` 不动
- [x] 3.2 测试 `client.test.ts`：`buildRankingsUrl({ q: '可乐' })` 产出含 `q=...`（编码正确）；无 `q` 时 URL 与现状一致；`q` 与 `category` 共存序列化正确

## 4. apps/miniapp — 搜索入口真输入化（只读、复用 board）

- [x] 4.1 `useRankings.ts`：参数从 `category` 扩为可带 `q`，线程进 `buildRankingsUrl`；`q` 须进 `fetchPage` 签名 + **全部三处调用**（`runFirst`/`refresh`/`runNext`）+ **全部三处 `useCallback` 依赖数组**（与 `category` 同款）。**漏掉 `runNext` 会让搜索第 2 页用陈旧 `q`、把 cohort 行混进搜索结果**（board 每次 `navigateTo` 重挂载故 per-mount 稳定、当前为潜伏 bug，但仍须补全防回归）
- [x] 4.2 `pages/board/params.ts`：`readBoardParams` 增 `q` 的**确定性解码**（端到端恰好 1 次）——**禁止**复用 `name` 的 try-decode-catch-raw 兜底（对 `100%20纯` 会静默解错）。据 5.3 实测的 Taro `onLoad` 解码次数：已解→不再解、未解→解一次。`name` 路径（分类下钻固定 CJK）**保持不变**。board 标题派生优先级 `q ? '搜索：'+decodedQ : (name ?? '分类榜')`。更新 `params.ts` 里「固定 taxonomy 无 `%`」注释（`q` 自由文本走确定性解码；`name` 仍固定 CJK 走兜底）。board 页把 `q` 传入 `useRankings`
- [x] 4.3 `components/SearchEntry.tsx`：占位改 Taro `Input`；`onConfirm` 取值 `trim` 后**按码点**（`[...s]`）：长 `0`/`1`→不跳转（`1` 给「至少输入 2 个字」轻提示）、`≥2`→先按码点截断到 64、再 `navigateTo` `` `board?q=${encodeURIComponent(qt)}` ``（**只带 `q`**、不带 `name`）
- [x] 4.4 `pages/index/index.tsx`：把 SearchEntry 从「tap→toast」改接 confirm→搜索跳转（移除敬请期待 toast 接线）。`pages/board/index.tsx`：`useLoad` 里据 `readBoardParams` 的**解码后** `q`/`name` 按 4.2 优先级 `setNavigationBarTitle`（标题用解码后的 `q`，非编码态）
- [x] 4.5 测试 `pages/board/params.test.ts`：`q` 解析逐字节往返（CJK、`100%20纯`/`a%20b`/`100%`/`100+200` 不被解错、缺省）；标题派生（解码后非空 q→搜索：q、空 q→分类榜、name-only→name）；搜索词长校验纯函数单测（0/1/2/65 码点 + 代理对边界，按码点不按 `.length`）。**注**：这些是 decode-策略**条件**单测，**不**证明真机 `onLoad` 行为——平台解码次数只由 5.3 真机实测定。`useRankings` 加一条**分页保 q** 测试（第 2 页仍带 `q`、不漏 filter）

## 5. 联调与验证

- [x] 5.1 `pnpm --filter @unit-price/db --filter @unit-price/api --filter @unit-price/api-client test` 全绿（含 q 缺省查询计划不漂移）— db 180 / api 260 / api-client 55 全绿，workspace `tsc -b` 退出 0
- [x] 5.2 契约+状态码已由 `routes.test.ts` 的 in-process 集成测试覆盖（`app.request('/rankings?q=…')` 走真实 Hono URL/query 解析、假 repo）：`?q=可乐`→200 转发截断后 q、`?q=水`→400 repo 不触、`?q=`/`?q=%20%20`→undefined 不过滤、`no-store` vs `PUBLIC_CACHE_CONTROL`、码点截断/代理对/`ESCAPE` 字面/cohort 守卫优先，全绿（262/262）。**不另跑 `pnpm --filter api dev`**：Node dev entry 不注入 repo（`server.ts` 注释明示），跑不了过滤路径，等价 curl 只重复已绿断言
- [x] 5.3 WeChat 真机实测**通过**：现行 4.2 解码策略在真机正确（②搜索「可乐」跳 board 出结果、标题「搜索：可乐」、单字给提示不跳、空输入不发请求；③`100%20纯` 真机过滤词逐字节正确、未被误解）。真机 fetch 命中 `unit-price.herbert-dev.cn` 返数据 ⟹ WeChat 请求合法域名白名单亦已就位（预览强制校验）。无需改 4.2
- [x] 5.4 归档时同步受影响 spec 主文件（rankings-api / miniapp）
