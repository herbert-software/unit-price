## 上下文

`GET /rankings` 已上线（rankings-api，公开只读）。本变更建第一个面向用户的客户端（简版只读小程序）+ 把响应契约抽进共享 `packages/api-client`。仓库现状：pnpm workspace（`packages/*` + `apps/*`）、ESM + TS project references（`tsc -b`、`composite`、`nodenext`），core/db/eval/api 在根 `tsconfig.json` 的 references 里。`RankingsResponseSchema` 现居 `apps/api/src/routes.ts`（依赖 core 的 `WarningsSchema`），从 `index.ts` 再导出。Taro CLI 当前 4.2.x、支持 React+TS、Node 22；Zod 4 纯 JS 零依赖（小程序运行时安全）。微信小程序网络是 `Taro.request`（无 `fetch`）。

## 目标 / 非目标

**目标：**
- 抽 `packages/api-client`（传输无关），api 与小程序共依赖同一份 rankings 契约。
- `apps/miniapp` Taro 骨架 + 一屏只读榜单，消费 prod `/rankings`，分页 + 三态。
- 降级版列表内广告位（不实际服务），为攒够流量后开流量主预留。
- 先验 Taro 集成可行（spike），再铺 UI。

**非目标：**
- 录入/扫码、反套路徽标 polish、真实广告服务/流量主、激励视频/插屏、AppID/备案、搬全部 API schema、带请求的 SDK。

## 决策

**D1：api-client 边界 = 传输无关（纯）。** 导出 `RankingsResponseSchema` + 类型 + `buildRankingsUrl(base, params)` + `parseRankingsResponse(json)`，**不含任何网络调用**。理由：微信用 `Taro.request`、Web/插件用 `fetch`，运行时不同；把传输塞进共享包要么 polyfill、要么注入样板，且让包沾运行时。传输无关让 api-client 像 core 一样纯、可被四端复用，发请求各端自理（miniapp: `Taro.request(buildRankingsUrl(...))` → `parseRankingsResponse(res.data)`）。*备选*：带请求的注入式 SDK——否决（运行时耦合 + 注入样板），留到真有多端复用同一请求逻辑时升级。

**D2：rankings 契约从 apps/api 挪进 api-client，api import 回来。** `RankingsResponseSchema` 物理移动到 `packages/api-client`，`apps/api/src/routes.ts` 改 import；`apps/api/src/index.ts` 把那三个符号（`RankingsResponseSchema`/`RankingsItem`/`RankingsResponse`）改为**从 api-client re-export**（保持 `@unit-price/api` 下游消费者不断）；apps/api 加 api-client 的 workspace 依赖 + tsconfig project reference，api-client 自身进根 `tsc -b` references。**纯重构**：API 行为、字段、错误码、治理豁免全不变。**回归基准是 apps/api 的 `/rankings` 行为测试**（经 `createApp` 验端到端，不直接 import 该 schema）——非 "import 同步"。理由：消除「app 自持契约、第二消费方无处可依」的方向问题；契约单一事实源落共享层。本期**只搬 rankings**，不动 ParseResponse/Ingest 等其它 schema（最小范围，避免大重构）。

**D3：apps/miniapp 出根 `tsc -b` reference 图，Taro 自管构建。** 仓库用 `tsc -b` + composite/nodenext；Taro 用自己的 bundler（webpack5/vite）+ 自己的 tsconfig（jsx/esnext，非 composite）。两个构建世界不混：miniapp **不进**根 `tsconfig.json` 的 references，由 `@tarojs/cli` 构建；它消费 api-client 的**预构建 dist**（非源码）。`apps/miniapp` 仍是 workspace 成员（deps 走 `workspace:*`、包名 `@unit-price/miniapp`）。*备选*：把 miniapp 塞进 `tsc -b` 图——否决（Taro 不走 tsc -b，强塞徒增摩擦）。

**D4：Taro 集成 spike 列第一任务。** 风险中点是「Taro bundler 吃 ESM workspace 包 api-client」：① 消费 dist 而非源码；② ES2022 按 Taro target 降级；③ 构建顺序（api-client/core 先 build 再 Taro 打包）。先用最小 spike 验证 `import { RankingsResponseSchema } from '@unit-price/api-client'` 在 `taro build --type weapp` 真能打通（含 Zod 运行时），**通过再铺 UI**。失败兜底：Taro `compile.include` 让 bundler 编 api-client 源码，或 api-client 出 CJS dual。理由：集成不确定性前置消解，避免铺完 UI 才发现打不通。

**D5：列表内原生广告位 = 降级组件，v1 不接真单元。** 流量主硬门槛是累计 UV ≥ 1000，v1 上线当天广告**不可能服务**。故 v1 只做「位 + 会自动消失的组件」：前 ~10 名无广告（来找最便宜饮料的人 0 广告）、每 ~12–15 条插 1 张、预留卡高 + 无填充/无流量主时优雅塌缩。真实广告单元、流量主开通留到攒够 UV。理由：为零用户的 app 配广告单元是过早优化；降级位满足「第一期加广告」又不污染 UX。**插屏不用**（高频工具强制弹窗最招人烦）；**激励视频留后**（v1 只读无奖励钩子）。

**D6：数据源 = prod `/rankings`（dev 关域名校验）。** 骨架直连生产（公开免 key、329 条真数据），开发者工具勾「不校验合法域名」即可。base URL 待钉（`[手动验证]` 取 prod worker 域名）。理由：零搭环境、最真实。真机预览/上架时该域名须登记进「请求合法域名」——绑 AppID/备案，属流程闸（D7）。

**D7：备案与代码骨架解耦。** AppID/主体备案/经营类目/请求合法域名登记是**发布闸**、非开发闸。骨架在开发者工具里能完整跑通（测试号 + 关域名校验）；真机预览 + 上架才卡备案。故代码骨架现在做、备案并行办、办好再切真机/上架。

**D8：让 Zod 在微信运行时跑通 = esbuild-vendor + per-parse `jitless`（D4 spike 实测增补）。** D4 spike 只验了「能 `taro build`」，漏了「运行时能否解析 + 执行」，落地踩到两道坎：① **现代语法**——Zod 4 dist 带 `?.`/`??`，Taro babel-loader 默认不转 node_modules → weapp 解析器 `Unexpected token .`。D4 兜底①（`compile.include` 用 babel-preset-taro 转 Zod）**实测会转坏 Zod 的 class 运行时**（loose class transform → `w is not a function`），**否决**；改用 **esbuild 预打包**（`scripts/vendor-api-client.mjs`，target es2017：降 `?.`/`??` 但保留 class）产出 `vendor/api-client.js`，经 webpack `alias` 重定向、置于 babel 作用域外（TS 仍从真包取类型）。② **eval 禁用**——Zod 4 object schema 默认 JIT、用 `new Function` 编快速解析器，而 weapp 禁 `eval`（且其 `new Function` 不抛错、只返废物，骗过 Zod 的 `allowsEval` 探针）→ `fn is not a function`。解法：`parseRankingsResponse` 调 `RankingsResponseSchema.parse(json, { jitless: true })`，per-parse 闸门 `ctx.jitless !== true` 跳过 JIT、走解释执行（ctx 下传至嵌套 schema；定在 api-client 共享层，对 apps/api 无害——Workers 本就禁 eval、Zod 探针自动降级）。**校验**：build 后 `grep dist '\?\.' === 0` + `jitless` 进包 + 微信工具实测榜单渲染 329 条。

## 风险 / 权衡

- [Taro 打不通 ESM workspace 包 api-client] → D4 spike 前置 + 两条兜底（`compile.include` 编源 / CJS dual）；先验再铺。
- [广告降级位写了却长期不服务] → 接受：v1 本就不指望广告出钱（无 1000 UV），位是为未来预留；组件无填充即塌缩、不占 UX。
- [prod base URL 未定 + 真机需登记合法域名] → dev 关校验可跑；URL 钉 `[手动验证]`；登记绑备案（D7 并行）。
- [api-client 抽离触碰已上线 apps/api] → 纯重构、行为不变，靠 apps/api 既有测试保持绿兜底（schema 移动不改语义）。
- [Zod 在 weapp 运行时] → 实测两道坎（现代语法 `?.`/`??`、JIT `new Function` 撞 eval 禁用），见 D8；**esbuild-vendor + per-parse `jitless` 已确定性解决**（非撞运气：esbuild 保留 class、jitless 是源码级闸门、CI 可复现）。压缩后 Zod 约占主包 ~150–200KB，2MB 预算下可接受；「瘦客户端只 import type + 轻量 shape 校验」作 v2 可选优化（不动 Zod 在服务端 LLM 把关 + 共享类型的核心价值）。

## 迁移计划

无 DB 迁移、无 prod 行为变更。api-client 抽离 + apps/api re-import 随后续 PR 合并；apps/miniapp 是新增工程，**不进 CI 的 prod 部署链**（Taro 产物给微信开发者工具/上架，不上 Cloudflare）。回滚 = 回退 PR，apps/api 退回自持 schema。

## 待决问题

- ~~prod `/rankings` 的 base URL~~ → 已定 `https://unit-price-api.herbertgao.workers.dev`（写进 `config.ts`）。遗留长杆：`*.workers.dev` 国内不稳/不可达（dev 靠系统代理，真机/上架需国内可达 + 备案域名，属 D7），单独排期。
- ~~Taro spike 的两条兜底~~ → 实测兜底①（`compile.include`）会转坏 Zod class，**否决**；最终方案 = D8 的 esbuild-vendor + jitless（既未手抄类型、亦未退到 CJS dual）。集成方案已落定、不再悬。
