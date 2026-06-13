## 新增需求

### 需求:api-client 必须提供传输无关的 rankings 契约

`packages/api-client`（`@unit-price/api-client`）**必须**作为四个客户端与 `apps/api` 共享的 API 契约包，本期承载 `/rankings` 契约。它**必须传输无关**——**禁止**包含任何网络调用（`fetch`/`Taro.request`/`wx.request` 等），发请求由各客户端自理。本包导出：

- `RankingsResponseSchema`（Zod）+ 推导类型 `RankingsItem` / `RankingsResponse`——**契约单一事实源**，由 `apps/api` 与客户端**共依赖同一份**；字段集与 `rankings-api` 契约一致（`rank/title/priceCents/per100ml/formula/confidence/warnings/store/storeSku/sourceUrl`），`warnings` 复用 `@unit-price/core` 的 `WarningsSchema`（不另写重复定义）。
- `buildRankingsUrl(base, { limit?, offset?, category? })`：**纯 URL 序列化函数**，不发请求、**不校验参数值**（值合法性由服务端按 `rankings-api`「分页与查询参数边界」需求做 `400` 兜底——本函数只序列化、不重复校验，分工明确）。语义**必须**钉死：`base` **必须恰为规范 `http(s)` origin**——即 `base`（去除一个可选末尾斜杠后）**严格等于**其解析出的 `origin`（`scheme://host[:port]`，小写 host、省略默认端口、无 path/query/fragment/userinfo）。凡**非规范形态**（含 path/`?`/`#`/userinfo、空串、非 `http(s)` scheme、**缺 `//`** 如 `https:host`、**dot-segment** 如 `https://host/.`、大写 host、显式默认端口等）一律视为配置误用、**必须抛错**（fail-fast、不静默规范化——base 是受控配置常量，非规范值是配置错误而非待归一输入）。通过后以 `<origin>/rankings` 为根、以 `?k=v&...` 拼入**仅已给**的参数；参数值**必须**经 `encodeURIComponent` 编码；全缺省 `{}` 时返回 `<origin>/rankings`（无 `?` 串）。
- `parseRankingsResponse(json: unknown): RankingsResponse`：用 `RankingsResponseSchema` 的 `.parse(json, { jitless: true })` 校验。校验失败**必须抛出 `ZodError`（原样冒泡、不吞不包装）**（fail-closed），**禁止**返回未校验/部分数据——调用方把**任意抛出**当作错误态处理（不依赖具体错误 shape、catch 到即走错误态）。**必须传 `jitless: true`**：本包传输无关、须在**禁 `eval`/`new Function` 的运行时**（微信小程序等）可跑，而 Zod 4 object schema 默认 JIT 用 `new Function` 编解析器——per-parse `jitless` 跳过 JIT、走解释执行（语义不变；ctx 下传至嵌套 schema；对 Node/Workers 无害，Workers 本就禁 eval、Zod 探针自动降级）。

本包**必须**只依赖 `@unit-price/core`（领域类型/`WarningsSchema`）+ Zod，**禁止**依赖任何运行时/框架包（Taro、apps/api 等）。`RankingsResponseSchema` 由本包**定义**（从 `apps/api/src/routes.ts` 迁入），`apps/api` 改为从本包 import（不再自持定义）。

#### 场景:契约由 api-client 单一事实源、api 与客户端共依赖

- **当** 检查 `RankingsResponseSchema` 的定义位置
- **那么** 它**必须**定义在 `packages/api-client`（非 `apps/api/src/routes.ts`），`apps/api` 与小程序均从 `@unit-price/api-client` import 同一份；字段集与 `warnings`（复用 core `WarningsSchema`）与既有 rankings-api 契约逐一一致

#### 场景:传输无关——不含网络调用

- **当** 检查 `packages/api-client` 的源码与依赖
- **那么** **禁止**出现 `fetch`/`Taro.request`/`wx.request` 等网络调用或对运行时/框架包的依赖；只导出 schema/类型/`buildRankingsUrl`/`parseRankingsResponse`，发请求留各客户端

#### 场景:buildRankingsUrl 只拼已给参数

- **当** 调用 `buildRankingsUrl("https://api.example.com", { limit: 50, offset: 100 })`（未给 `category`）
- **那么** **必须**返回 `https://api.example.com/rankings?limit=50&offset=100`、**不含** `category`；只拼入已给的参数

#### 场景:buildRankingsUrl 规整 base 末尾斜杠与全缺省

- **当** 调用 `buildRankingsUrl("https://api.example.com/", {})`（base 带末尾斜杠、无参数）
- **那么** **必须**返回 `https://api.example.com/rankings`（去重复斜杠、无 `?` 串）

#### 场景:buildRankingsUrl 对非规范 origin 的 base fail-fast

- **当** 调用 `buildRankingsUrl` 时 `base` 非规范——含 path（`https://x/v1`）、query（`https://x?a=1`）、fragment（`https://x#f`）、userinfo（`https://u:p@x`）、缺 `//`（`https:x`）、dot-segment（`https://x/.`）、显式默认端口（`https://x:443`）或非 `http(s)`（`ftp://x`）/空串
- **那么** **必须抛错**（配置错误 fail-fast），**禁止**静默产出坏 URL 或把非规范输入**静默规范化**当作合法配置（如 `https:x`→`https://x/rankings`、`https://x/.`→`https://x/rankings` 都应抛而非接受）

#### 场景:buildRankingsUrl 不校验参数值、只序列化

- **当** 传入服务端会判 `400` 的值（如 `{ limit: 0 }`、`{ category: "alcohol" }`）
- **那么** `buildRankingsUrl` **必须**照常把值序列化进 URL（如 `?limit=0`、`?category=alcohol`），**不抛错、不静默改值**——值合法性留给服务端按 `rankings-api` 查询边界需求做 `400`

#### 场景:parseRankingsResponse 校验失败抛 ZodError fail-closed

- **当** `parseRankingsResponse` 收到不满足 `RankingsResponseSchema` 的 JSON（如 `warnings` 非 `string[]`、缺字段）
- **那么** **必须抛出 `ZodError`**（原样冒泡），**禁止**返回未校验或部分数据；调用方 catch 到任意抛出即走错误态

#### 场景:apps/api 复用同一契约且行为不变

- **当** `apps/api` 改为从 `@unit-price/api-client` import `RankingsResponseSchema`（`routes.ts` handler 与 `index.ts` re-export 改 import 源）
- **那么** `/rankings` 的响应字段、错误码、治理豁免**均不变**；回归由 `apps/api` 既有 **`/rankings` 行为测试**（`routes.test.ts` 的 rankings 用例）保证仍绿（这些测试经 `createApp` 验端到端行为、不直接 import 该 schema，故迁移是纯重构、行为测试是回归基准）
