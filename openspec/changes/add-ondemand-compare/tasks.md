## 1. packages/api-client — compute schema + URL/parser（先行，apps/api 与 miniapp 共用）

- [x] 1.1 新建 `compute.ts`：**自包含** `ComputeRequestSchema`（`totalPrice:number>0`、`quantity?:int>0`、`unitSize?:{value:number>0,unit}`、`totalAmount?:{value:number>0,unit}`、`category:string`，`unit ∈ {ml,L,g,kg}`）+ `ComputeResultSchema`（`per100ml:number|null`、`per100g:number|null`、`formula`、`axis:'per_100ml'|'per_100g'`、`rank:int`、`total:int`、`percentile:number`、`neighbors:RankingsItem[]`，复用既有 `RankingsItemSchema`）。types 从 schema 推导。**禁止** import `packages/core`（保持可安全进 weapp）。
- [x] 1.2 `buildComputeUrl(base)`：沿用既有 `cleanOrigin` 校验，返回 `POST /compute` 目标 URL。`parseComputeResponse(json)`：Zod 校验响应，**必须**与 `parseRankingsResponse` 同口径传 **jitless**（weapp 禁 `new Function`/eval，见 [[taro-weapp-modern-syntax-transpile]]）。
- [x] 1.3 从 `index.ts` 导出；测试 `compute.test.ts`：request/response schema 往返；`buildComputeUrl` 拼接与 `cleanOrigin` 校验；`parseComputeResponse` 校验通过/失败；**断言 compute.ts 不依赖 core**（import 图不含 `@unit-price/core`）。

## 2. apps/api — POST /compute 路由（依赖 1；复用 core + rankings repo，零新增计算逻辑）

- [x] 2.1 `routes.ts`：注册 `POST /compute`，用 api-client 的 `ComputeRequestSchema` 校验请求体（非法 → `400 invalid-request`）。
- [x] 2.2 把 `ComputeRequest` 映射为 core `ParsedSpec`（`{unitSize, quantity, totalAmount, multipliers:[1], category, confidence:1}`）；**先** `meetsComputeRequiredSet(spec, totalPrice)` 判输入集充分性，不足 → `400` 且指明需补「总量」或「单件容量+数量」。
- [x] 2.3 调 `calculate(spec, totalPrice)`；进 uncomputable 终态（两轴 null：价非正 / 无轴 / 不自洽）→ **`400` + 回带 core warning 文案**（禁止静默 `200`）。
- [x] 2.4 `resolveComparableUnitStatic(category)`：`null`（跨 cohort 节点 `beverage`/`alcohol`）→ `400`；非 null 但与 `calculate` 落的轴不一致（输入 g、cohort `per_100ml` 等）→ `400` 不可比，文案指明该品类比价单位轴。
- [x] 2.5 cohort 内定位：**复用 `/rankings` 同一 cohort 闭包 + rankable 守卫查询**算 `rank`（该轴单价 `<` 用户值条数+1）、`total`、`percentile`，并取用户值两侧最近 `N=3` 的 `neighbors`（投影同 `RankingsItem`）。
- [x] 2.6 响应发 `Cache-Control: no-store`；**无任何 DB 写**（无状态）。
- [x] 2.7 测试 `routes.test.ts`：足够输入→`200` + 正确 `per100ml`/`formula`（与 core 逐字节一致）/`rank`/`percentile`/`neighbors`；缺字段→`400` 指明缺项；价非正 / 无轴→`400` + warning；跨轴→`400` 不可比；跨 cohort 节点→`400`；该 cohort 零 rankable→`200` + 空 `neighbors`（不 `404`）；`no-store` 头；**假 repo 的写方法从未被调用**（无持久化回归守卫）。

## 3. apps/miniapp — 榜单首页比价入口 + 比价表单页（依赖 1、2；视觉/布局落地 frontend-design 交付物）

- [x] 3.1 新建比价表单页 `pages/compute/`（route + 注册）：字段 总价、数量、**单件容量 / 总容量二选一互斥**、单位选择（`ml`/`L`/`g`/`kg`）、品类选择。
- [x] 3.2 品类选择从 `/categories`（或共享 `CategoryLeafSlugSchema`）派生 leaf cohort，**禁止硬编码**；按所选品类的可比单位轴**约束可选单位**（`per_100ml`→ml/L、`per_100g`→g/kg）并提示比价口径。
- [x] 3.3 提交经 `buildComputeUrl`/`parseComputeResponse` 调 `POST /compute`（`Taro.request` method POST，body=ComputeRequest）；空 / 非正 / 二选一都缺等**端上轻校验不发请求**并行内提示；权威校验仍在服务端。
- [x] 3.4 结果卡片：用户单价 + **可展开**可回放 `formula` + 该 cohort `rank`/`total`/`percentile` + 最近同类品（可点进 board）；loading / error / 结果三态。
- [x] 3.5 **主入口**——榜单首页搜索**无结果态**加比价 CTA（「没搜到这件商品？」+「输入规格,算它值不值」）→ `navigateTo` `pages/compute`。
- [x] 3.6 **辅入口**——榜单首页搜索行旁**视觉次于搜索**的紧凑入口（链接/图标「算单价」，非整行大按钮）→ `navigateTo` `pages/compute`。
- [x] 3.7 视觉/布局/交互落地 **frontend-design 交付的设计**：套用既有 P0 设计语言 + 共享设计 tokens（沿用「页面 css 零颜色字面量」既有约束），与榜单/搜索现有观感一致。
- [x] 3.8 测试：表单纯函数单测（ComputeRequest 组装、二选一互斥判定、单位轴兼容判定，按既有纯函数测试风格）；入口→导航；空/非法不发请求。

## 4. 联调与验证

- [x] 4.1 全绿（编排者核对）：api-client 97 / db 181 / api 280（+18 条 /compute）/ miniapp 52，workspace `tsc -b` 退出 0。
- [x] 4.2 契约+状态码已由 `routes.test.ts` 的 in-process 集成测试覆盖（`app.request('/compute', POST)` 走真实 Hono + 假 repo）：足够输入→200（per100ml/formula 与 core 逐字节一致）、缺字段→400、价非正/无轴→400、跨轴→400、跨 cohort→400、零 rankable→200 空 neighbors、no-store、假 repo 写方法零调用。**不另跑 `pnpm --filter api dev`**：Node dev entry 不注入 repo，/compute 定位读会走 persistence-error 分支、跑不了真定位，等价 curl 只重复已绿断言。
- [ ] 4.3 WeChat 实测（devtools **+ 真机**）：搜索无结果→CTA→比价表单页→提交→结果卡片；紧凑辅入口可达；空/非法不发请求；单位轴随品类约束；响应 `no-store`；端到端一条真机比价。
- [ ] 4.4 更新受影响 spec 主文件（`/opsx:sync` 或归档时同步 `compute-api` / `miniapp`）。
