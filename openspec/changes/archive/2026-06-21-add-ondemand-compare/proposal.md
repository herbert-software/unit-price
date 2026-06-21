## 为什么

山姆门店里有商品不在 App 榜单上销售，用户当场想知道「这个东西的单价大概贵不贵、在同类里排哪」。当前 miniapp 是 browse-only（只读 /rankings + /categories），没有任何即时计算入口——用户只能浏览已收录商品，遇到未收录商品束手无策。这是 [[product-form-browse-first]] 当初把 on-demand 计算降级为「搜索未命中兜底」时延后的能力，现在作为一个真功能落在榜单首页——且主入口正是当年设想的「搜索未命中」那一刻（见下）。

关键判断：用户输入的是**干净的结构化字段**（总价、数量、单件容量 / 总容量、单位），不是脏文本。本项目 AI 只承担「理解」（把脏标题结构化），而结构化输入**无需理解**——是纯确定性算术，`packages/core` 已有现成实现。所以本功能**不接 AI**，这正是它能「反应足够快」的原因：慢的是 LLM 往返，而它根本不在路径里。

入口落点（已决策）：放在 `榜单` 首页——**主入口为搜索未命中态 CTA**（「没搜到这件商品？→ 输入规格,算它值不值」，需求恰在搜索落空那一刻产生）、**辅入口为搜索框旁紧凑链接**；`我的` Tab 本期仍为占位（未来工具增多再升级为「工具」hub、届时入口 deep-link 进去、不重写）。不放整行大 CTA 抢占浏览视线。

## 变更内容

- **新增 `POST /compute` 端点**（`apps/api`）：无状态、无 DB 写、无 AI。入参 `{ totalPrice, quantity?, unitSize?, totalAmount?, category }`，服务端 (1) 校验输入集是否足够（有总量 或 单件容量+数量），(2) 映射为 core 的 `ParsedSpec` 并调既有 `calculate()` 得 per100ml/per100g + 可回放 formula，(3) 用既有 `resolveComparableUnitStatic` 校验所选 cohort 的可比单位轴与输入轴一致（跨轴 → 不可比 400，遵守核心原则①），(4) 在该 cohort 的 rankable 行里定位：rank / percentile / 最接近的若干同类品。响应发 `Cache-Control: no-store`。
- **`@unit-price/api-client` 新增** `buildComputeUrl` + `parseComputeResponse` + **自包含**的 `ComputeRequestSchema`/`ComputeResultSchema`（Zod 单一事实源）。这两个 schema **刻意不 import `packages/core`**——api-client 已打进 weapp 包，引 core 会把 core+Zod 拖进小程序、重蹈 [[taro-weapp-modern-syntax-transpile]] 两道坎；故 ComputeRequest 自带精简 `{ value, unit }` 形，由**服务端**把它映射成 core 的 ParsedSpec（加 `confidence=1`、`multipliers=[1]`）。
- **miniapp 榜单首页新增即时比价入口 + 比价表单页**：入口为「搜索未命中 CTA（主）+ 搜索框旁紧凑链接（辅）」，进入比价表单页（总价、数量、单件容量 / 总容量二选一、单位 ml/L/g/kg、品类——品类从 `/categories` 派生不硬编码）。提交经 api-client 调 `POST /compute`，渲染结果卡片（你的单价 + formula 可展开 + 在该 cohort 的 rank/percentile + 最接近的几个同类品，可点进 board）。空 / 非法输入不发请求。**`我的` Tab 本期仍为占位**（不变）。

## 功能 (Capabilities)

### 新增功能
- `compute-api`: `POST /compute` 的契约——结构化入参校验、确定性单价计算（复用 core，无 AI）、跨轴不可比守卫、cohort 内定位（rank/percentile/邻居）、no-store、无持久化。

### 修改功能
- `miniapp`: 榜单首页新增即时比价入口（搜索未命中 CTA + 搜索框旁紧凑链接）与结构化比价表单页，发起单次无状态 `POST /compute`（唯一写形请求即此）。`我的` Tab 本期仍为占位（不变）。只读浏览边界其余不变（无扫码 / 拍照 / 端上 core 计算 / 贡献纠错 / 写库——结构化输入仅用于一次性即时比价）。

## 影响

- `apps/api`：新路由 `POST /compute`（复用 `calculate` / `resolveComparableUnitStatic` / rankable 定位查询；无新计算逻辑）。
- `packages/api-client`：新增 `compute.ts`（URL builder + 响应 parser + 自包含 request/response schema）。
- `apps/miniapp`：榜单首页加比价入口（搜索未命中 CTA + 搜索框旁紧凑链接）+ 新比价表单页 + 结果卡片；`我的` 保持占位。
- `packages/core`：**零改动**（`calculate` / `meetsComputeRequiredSet` 现成）。
- 数据合规：无新增持久化、无爬取、无众包写入——纯按需无状态计算（核心合规分层里「按需计算永远可用」的一类）。
- **非目标**（本期不做）：free-text 标题输入 + tier1/tier2 AI 解析（AI 唯一值得付延迟之处，留作后续）；OCR / 扫码 / 拍照；把结果写库或贡献；跨 cohort 混合单位同列；历史记录 / 收藏 / 联想。
