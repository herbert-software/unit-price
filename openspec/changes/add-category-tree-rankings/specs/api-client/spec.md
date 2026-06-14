## 新增需求

### 需求:api-client 必须提供传输无关的 categories 契约

`packages/api-client`（`@unit-price/api-client`）**必须**新增 `GET /categories`（品类树浏览）的共享契约，与既有 rankings 契约**同样传输无关**——**禁止**包含任何网络调用（`fetch`/`Taro.request`/`wx.request` 等），发请求由各客户端自理。本契约与 rankings 契约**形态对齐**（同一包内一致的 schema + 纯 URL 序列化 + fail-closed 校验三件套），由 `apps/api` 与客户端（小程序等）**共依赖同一份**。本包**必须**新增导出：

- `CategoryTreeResponseSchema`（Zod）+ 推导类型——**契约单一事实源**，字段集与 `category-tree-api` 契约一致：`{ nodes: { slug, name, parentSlug(nullable), comparableUnit(nullable), rankable(boolean), rankableCount(int>=0) }[] }`。**禁止**在 `apps/api/src/routes.ts` 手写重复类型。
- `buildCategoriesUrl(base)`：**纯 URL 序列化函数**，不发请求。**必须**复用 `buildRankingsUrl` 同款 clean-origin fail-fast 校验（`base` 须恰为规范 `http(s)` origin，非规范形态——含 path/`?`/`#`/userinfo、空串、非 `http(s)`、缺 `//`、dot-segment、大写 host、显式默认端口等——**必须抛错**、不静默规范化）；通过后返回 `<origin>/categories`。`/categories` 本期**无查询参数**，故无参数序列化分支。
- `parseCategoryTreeResponse(json: unknown): CategoryTreeResponse`：**必须与既有 `parseRankingsResponse(json)` 签名形态一致**——**只接 `json` 一个入参、内部硬编码 `{ jitless: true }`**（`CategoryTreeResponseSchema.parse(json, { jitless: true })`），**禁止**把 `jitless` 暴露成调用方可选项（避免调用方漏传致 weapp `new Function`/eval 禁用下 JIT 解析崩溃——与 `parseRankingsResponse` 同样的运行时约束与已知坑）。校验失败**必须**抛 `ZodError`（原样冒泡、fail-closed），**禁止**返回未校验/部分数据。

**禁止**新增任何会发 HTTP 的方法（如 `getCategories()`）——那会破坏本包传输无关契约；URL 构造与响应校验分离、发请求留各客户端（miniapp `Taro.request`、web/插件 `fetch`），与既有 rankings 契约同构。

#### 场景:导出传输无关的 categories 契约三件套

- **当** 检查 `@unit-price/api-client` 的导出
- **那么** **必须**含 `CategoryTreeResponseSchema` + 推导类型、`buildCategoriesUrl`、`parseCategoryTreeResponse`；**禁止**出现 `fetch`/`Taro.request`/`wx.request` 等网络调用或会发请求的 `getCategories()`；`apps/api` 与小程序均从本包 import 同一份 schema

#### 场景:buildCategoriesUrl 规范 origin 产 /categories、非规范 fail-fast

- **当** 调用 `buildCategoriesUrl("https://api.example.com")` 与 `buildCategoriesUrl("https://api.example.com/")`
- **那么** 两者**必须**返回 `https://api.example.com/categories`（去重复末尾斜杠、无 `?` 串）；`base` 非规范（含 path/query/fragment/userinfo、缺 `//`、空串、非 `http(s)` 等）时**必须抛错**，与 `buildRankingsUrl` 同口径

#### 场景:parseCategoryTreeResponse 签名对齐 sibling、jitless 内置、fail-closed

- **当** 检查 `parseCategoryTreeResponse` 的签名与实现
- **那么** 它**必须**只接 `json` 一个入参、内部以 `{ jitless: true }` 调 `CategoryTreeResponseSchema.parse`（与 `parseRankingsResponse` 形态一致、不把 jitless 外露）；收到不满足 schema 的 JSON（缺字段、`rankableCount` 非整、`nodes` 非数组等）时**必须**抛 `ZodError`（fail-closed），**禁止**返回未校验/部分数据
