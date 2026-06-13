## 1. packages/api-client（共享契约·传输无关）

- [x] 1.1 新建 `packages/api-client`（`@unit-price/api-client`，ESM、`tsc -b` composite）：把 `RankingsResponseSchema`/`RankingsItemSchema` 从 `apps/api/src/routes.ts` **迁入**本包（`warnings` 复用 `@unit-price/core` 的 `WarningsSchema`），导出 schema + `RankingsItem`/`RankingsResponse` 类型；只依赖 `@unit-price/core` + Zod，**禁**依赖任何运行时/框架包。**接线**：把 `./packages/api-client` 加进**根 `tsconfig.json` 的 references**（注：是 **api-client 自己**作 composite 包进根 refs；`apps/miniapp` 见 2.1 **不进**——二者主语不同、不矛盾）
- [x] 1.2 在 api-client 加 `buildRankingsUrl(base, { limit?, offset?, category? })`（纯 URL 序列化：`base` 须**恰为规范 origin**——`base` 去一个可选尾斜杠后**严格等于** `parsed.origin`，非规范一律 fail-fast 抛错（含 path/query/fragment/userinfo、缺 `//`、dot-segment、大写 host、显式默认端口、非 http(s)、空串——不静默规范化）；通过后以 `<origin>/rankings` 为根拼仅已给参数、值经 `encodeURIComponent`、全缺省 `{}` 返回 `<origin>/rankings`；**不校验参数值**，值合法性由服务端 400 兜底）+ `parseRankingsResponse(json: unknown): RankingsResponse`（`RankingsResponseSchema.parse`，失败**抛 `ZodError` 原样冒泡** fail-closed）
- [x] 1.3 `apps/api` 改为从 `@unit-price/api-client` import `RankingsResponseSchema`（`routes.ts` handler 改 import 源、不再自持定义）。**接线**：`apps/api/package.json` 加 `@unit-price/api-client: workspace:*`、`apps/api/tsconfig.json` 加对 `packages/api-client` 的 project reference。**index.ts re-export 处置**：`apps/api/src/index.ts` 把 `RankingsResponseSchema`/`type RankingsItem`/`type RankingsResponse` 改为**从 `@unit-price/api-client` re-export**（保持 `@unit-price/api` 下游消费者不断）。**回归基准**：跑 `pnpm -r build && pnpm -r test`——`apps/api` 的 `/rankings` **行为测试**（`routes.test.ts` rankings 用例，经 `createApp` 验端到端，不直接 import 该 schema）保持绿即证纯重构（**非** "import 同步"：实测无测试直接 import 该 schema）
- [x] 1.4 api-client 单测（纯函数，无 IO）：`buildRankingsUrl`——只拼已给参数（给 limit/offset 不给 category → 不含 category）、`base` 尾斜杠规整、全缺省 `{}` → `<origin>/rankings`、值编码、**非法参数值照样序列化不抛错**（`limit:0`/`category:'alcohol'` → 照拼）、**非规范 base → 抛错**（path `https://x/v1`、query `https://x?a=1`、fragment、userinfo `https://u:p@x`、缺 `//` `https:x`、dot-segment `https://x/.`、默认端口 `https://x:443`）、规范非默认端口 `https://x:8080` 照过；`parseRankingsResponse` 合法 JSON 通过 / 非法（warnings 非 string[]、缺字段）→ 抛 `ZodError`

## 2. apps/miniapp 骨架 + Taro 集成 spike（前置风险）

- [x] 2.1 用 `@tarojs/cli`（4.x）在 `apps/miniapp` 起 Taro + React + TS 工程：包名 `@unit-price/miniapp`、`@unit-price/api-client` 走 `workspace:*` 依赖；**不进**根 `tsconfig.json` 的 `tsc -b` references（Taro 自管构建）；init 后根 `pnpm install` 收编进 workspace
- [x] 2.2 **集成 spike（通过才继续铺 UI）**：在 miniapp 里 `import { RankingsResponseSchema, parseRankingsResponse } from '@unit-price/api-client'` 并跑 `taro build --type weapp`，确认 ESM workspace 包 + Zod 在小程序产物里**能打通**（api-client/core 先 build 再 Taro 打包的构建顺序也要理顺）
- [x] 2.3 spike 失败兜底（仅当 2.2 不通时）：退到 Taro `compile.include` 让 bundler 编 api-client 源码，或 api-client 出 CJS dual；记录所用兜底。**禁**在未验证集成前就铺 UI。**实测增补（见 design D8）**：2.2 的「能 `taro build`」过了但**运行时**才暴露两坑——`compile.include`（babel-preset-taro）会转坏 Zod 的 class（`w is not a function`）、Zod 4 JIT 用 `new Function` 撞 weapp eval 禁用（`fn is not a function`）。最终方案**非** compile.include / CJS dual，而是：esbuild 预打包 `scripts/vendor-api-client.mjs`（es2017 保 class）+ webpack `alias` + `parseRankingsResponse` per-parse `{ jitless: true }`

## 3. 榜单屏（apps/miniapp）

- [x] 3.1 数据层：用 `buildRankingsUrl(BASE, { limit, offset })` + `Taro.request` 取 `/rankings`、`parseRankingsResponse(res.data)` 校验；`BASE` 配置项留 `[手动验证]` 待填 prod worker 域名（dev 勾"不校验合法域名"直连 prod）
- [x] 3.2 列表渲染：按 `per100ml` 升序逐行渲染 `rank` / `title` / `per100ml`（可比真值）/ 整件价（`priceCents / 100` 元）；**禁**用整件价反推或替代 `per100ml`
- [x] 3.3 分页：下拉刷新（`offset=0` 重取首页替换列表）+ 触底加载（`offset += limit` 追加，直到某页返回**少于 limit 条（含空数组）**判到底停止——LIMIT 查询下部分页即末页）
- [x] 3.4 三态：loading（首次/翻页指示）、空（`[]` → 空态非白屏非错误）、错误**分两位**——首屏错（首次加载失败/`parseRankingsResponse` 抛错 → 整屏错误态 + 重试）、翻页错（已有列表时某下一页失败 → **保留已加载列表** + 就该页局部重试，**禁**清空列表回退整屏错误态）；任一错误态**禁**白屏/渲染脏数据

## 4. 列表内降级广告位组件（apps/miniapp）

- [x] 4.1 实现「列表内原生广告位」组件并按**确定规则**插入：前 10 条（渲染序号 ≤ 10）**无广告位**、之后**每 12 条**一个插入点（序号 10、22、34… 后）；v1 **不接真实广告单元、不依赖流量主**（占位组件）；**禁**用插屏。**填充/卡高分清**：有填充才占预留固定卡高；无填充（v1 恒为此态）**渲染为空**（零高度、不跳版）
- [x] 4.2 无填充优雅塌缩：v1 未接真单元时广告位**渲染为零高度空内容**（`height===0`、无可见占位卡框、列表不跳版）——v1 该组件恒不显示可见内容；验收**断言锐化**：① 前 10 条区段零广告位 DOM（无插入点）；② **渲染 ≥11 行使第 10 条后首个插入点 wrapper 挂载、实测其 `height===0`**（区分 v1 无填充态 vs 未来有填充占卡高，取代"前 10 条无"这种对 v1/未来都恒真的弱断言）。**注**：`height===0` 须用**真实布局源**测（H5/RN-DOM 的 `boundingClientRect` 或 `Taro.createSelectorQuery`），**禁**用 jsdom（其 `getBoundingClientRect` 恒返 0、会令断言假绿）

## 5. 端到端校验

- [x] 5.1 `pnpm -r build && pnpm -r test` 全绿（含新 api-client 单测、apps/api 重构后不回归）
- [x] 5.2 微信开发者工具导入 `apps/miniapp` 工程、勾"不校验合法域名"跑通：榜单按 per100ml 升序、下拉刷新 + 触底分页、空/错（重试）/loading 三态、前 10 名无广告位 + 广告位无填充塌缩。**踩坑 + 解法见 design D8**（Zod 现代语法 → esbuild-vendor；Zod JIT 撞 eval 禁用 → per-parse `jitless`）。因 `*.workers.dev` 国内不稳，目验经**本机 fixture 直连**完成（契约/字段/数据与 prod 一致）；prod 真机渲染待国内可达 + 备案域名（D7 长杆）
