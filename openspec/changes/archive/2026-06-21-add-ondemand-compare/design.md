## 上下文

miniapp 当前是 browse-only 骨架（只读 /rankings + /categories），「我的」Tab 是不发任何请求的占位页。本变更新增即时比价能力：用户在山姆门店遇到未收录商品，输入结构化规格（总价、数量、单件容量 / 总容量、单位、品类），当场得到单价 + 在同类里的位置。入口落点经产品决策定在**榜单首页**（主入口=搜索未命中态 CTA，辅入口=搜索框旁紧凑链接），`我的` Tab 本期仍为占位（未来工具增多再升级为 hub，入口届时 deep-link 进去、不重写）。

约束来自既有工程约定：三段式解析（tier1 正则 → tier2 AI → tier3 确定性计算）、AI 只理解不计算、core 是纯函数无 IO、schema 用 Zod 单一事实源、不可比要显式标注。关键现成件：`packages/core` 的 `calculate(spec, price)`（tier3，纯函数，返回 per100ml/per100g + formula）、`meetsComputeRequiredSet`、`apps/api` 的 `resolveComparableUnitStatic(slug)`（cohort 静态可比单位守卫，rankings 已用）、`packages/api-client` 的 URL-builder + response-parser 模式。

## 目标 / 非目标

**目标：**
- 结构化输入 → 即时单价（per100ml/per100g）+ 可回放 formula + 在所选 cohort 内的位置（rank / percentile / 最接近的同类品）。
- **反应足够快**：纯确定性、单次往返、无 AI、无 DB 写。
- 复用既有件：core 计算零改动、rankings 定位复用既有 repo、cohort 守卫复用 `resolveComparableUnitStatic`。
- 保持 miniapp 「轻」：core **不**进 weapp 包。

**非目标：**
- free-text 标题输入 + tier1/tier2 AI 解析（AI 唯一值得付延迟之处，留作后续增强）。
- OCR / 扫码 / 拍照；把结果写库 / 贡献 / 纠错；跨 cohort 混合单位同列；历史记录 / 收藏 / 联想。

## 决策

**D1 — 不接 AI。** 用户输入结构化干净字段，没有「脏文本要理解」的环节，单价是纯算术（core tier3 已实现）。AI 只在脏标题 → 结构化时才有价值，本期不做该输入模式。
- 备选：每次都过一遍 AI「校验/纠错」用户输入 → 否决：徒增延迟与不确定性，违背「AI 只理解不计算」，且用户的速度诉求正是冲着 AI 往返来的。

**D2 — 计算放服务端 `POST /compute`，不在端上跑 core。** 比价本来就要查 /rankings 数据（一次网络），把 `calculate()` 折进同一个服务端端点，客户端只渲染表单 + 结果卡片。
- 备选：端上 bundle core 直接算（理论上零网络、最快）→ 否决：(a) core 带 Zod，进 weapp 会重蹈 [[taro-weapp-modern-syntax-transpile]] 两道坎（现代语法 transpile 坏 class + JIT `new Function` 撞 eval 禁用）；(b) 违反刚上线 miniapp browse-only spec「禁止端上计算」；(c) 既然要查 rankings 定位，端上算并不能省掉那次网络。无 AI 故服务端单次往返已足够快，不是性能妥协。

**D3 — ComputeRequest/Result schema 自包含在 api-client，不 import core。** api-client 已打进 weapp；若其 request schema 复用 core 的 `ParsedSpecSchema`，会把 core 经 api-client 拖进 weapp，正好触发 D2 要避开的问题。故 api-client 定义精简自包含形：`ComputeRequestSchema = { totalPrice:number>0, quantity?:int>0, unitSize?:{value>0,unit}, totalAmount?:{value>0,unit}, category:string }`（`unit ∈ ml|L|g|kg`），`ComputeResultSchema = { per100ml|per100g, formula, axis, rank, total, percentile, neighbors:[{title, per100ml/per100g, storeSku,...}] }`。
- **服务端**（apps/api，已合法依赖 core）把 ComputeRequest 映射成 core 的 `ParsedSpec`：`{ unitSize, quantity, totalAmount, multipliers:[1], category, confidence:1 }`，再调 `calculate()`。`confidence:1` 因结构化输入无解析不确定性。
- 代价：`{value,unit}` 形在 api-client 与 core 各有一份（2 字段）。备选：抽一个零依赖 measurement 包给两边共享 → 否决：为 2 个字段建包是过度抽象；复制一份 + 服务端映射更省。

**D4 — 不可比走既有静态守卫。** 服务端用 `resolveComparableUnitStatic(category)` 解析所选 cohort 的可比单位轴：为 null（跨 cohort 节点，如 beverage/alcohol）→ 400；非 null 但与输入轴不符（如输入 g、cohort 是 per_100ml）→ 400「不可比」+ 明确原因。遵守核心原则①不追求万物可比。复用 rankings 同一守卫，口径一致。

**D5 — uncomputable 不静默返 200。** `calculate()` 对 price≤0 / 无轴 / 规格不自洽会进 uncomputable 终态（两轴 null + warning）。端点**必须**把它映射成 400 + core 的 warning 文案，而非返回一个 per100ml=null 的 200（避免客户端拿到「成功但全空」的歧义）。输入集不足（既无总量又无单件容量+数量）由 `meetsComputeRequiredSet` 在 calculate 前先判 → 400 指明缺哪类字段。

**D6 — cohort 内定位复用 rankings repo。** rank = 该 cohort rankable 行中 per100(轴) < 用户值的条数 + 1；total = 该 cohort rankable 总数；percentile 由二者得；neighbors = 用户值两侧最近的 N 条（默认上下各 3）。复用既有 cohort 闭包 + rankable 守卫查询（同 /rankings 口径，保证「定位」和「榜单」同一总体）。响应 `Cache-Control: no-store`（每次输入不同、几乎不复用，缓存无意义且会无界填充 CDN）。

**D7 — 信任边界校验在服务端。** 客户端做轻量 UX 校验（正数、单位轴与品类提示、二选一互斥）以减少空跑，但**权威校验在服务端 Zod + meetsComputeRequiredSet + 守卫**。空 / 非法输入端上直接不发请求。

**D8 — 品类选择不硬编码。** 「我的」表单的 cohort 选择从既有 `/categories` 树（或共享的 `CategoryLeafSlugSchema`）派生 leaf cohort 列表，不在 miniapp 里复制一份品类清单（防漂移）。

## 风险 / 权衡

- [api-client 重复 `{value,unit}` 形] → 仅 2 字段、服务端集中映射，漂移面极小；强约束是「绝不让 core 进 weapp」，重复是为守住它。
- [cohort 轴与输入轴不匹配的用户困惑] → 客户端按所选品类预提示单位轴（选了软饮就只给 ml/L），服务端 400 文案明确「该品类按每100g比价，请用 g/kg」。
- [定位查询成本] → 复用既有 rankable count / list 查询，cohort 闭包已有索引（见 rankings query-plan 契约）；单次聚合，无新热点。
- [neighbors N 取值] → 默认上下各 3；纯展示参数，后续可调，不影响契约核心。
- [榜单首页加比价入口 + 比价表单页发 POST /compute，触碰刚上线的 miniapp browse-only spec] → 本变更显式改 miniapp 骨架 spec：唯一写形请求是比价表单页的无状态 POST /compute（服务端算、不写库）；`我的` Tab 占位条款不变；只读浏览边界（无扫码/拍照/端上 core 计算/贡献纠错/写库）其余不变。

## Migration Plan

纯增量：新端点 + 新 api-client 模块 + 「我的」页改造。**无 DB 迁移、无破坏性变更**。部署随 push main 自动（doc+code 一起走 feature 分支 + PR，因含代码）。回滚 = 还原三处；端点无状态、无持久化，回滚无数据后果。

## Open Questions

- percentile 展示口径：同时给「第 N / 共 M」与「比 X% 便宜」，还是只给其一？倾向两者都给（rank 直观、percentile 抗榜单规模差异）——实现时定文案，不影响 schema。
- neighbors 是否带 sourceUrl / 可点进 board：倾向带（复用 RankingsItem 投影），让用户能跳去看同类。
