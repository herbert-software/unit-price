## 为什么

后端 Phase 3 已完整上线：`GET /categories`（store-agnostic 品类 is-a 树）与 `GET /rankings?category=<slug>`（cohort-scoped 榜）均可用，prod `rankable` 覆盖 ~92%。但小程序 `分类` Tab 仍是「敬请期待」占位页——产品差异化主入口（按品类浏览、看单价排序的可比榜）尚未接通。这是当前可达成本最低、最能体现产品价值的一块端上接线：契约与数据都已就绪，纯前端工作，不触碰后端，也不依赖上线域名。

## 变更内容

- `分类` Tab 从占位页改为**真实品类树**：进入时一次性 `GET /categories`（整树单次小负载、无分页），按 `parentSlug` 把扁平节点构建为稳定 pre-order 缩进列表；`rankable` 节点（单一可比 cohort）可点，root `饮料` / `酒类` parent 为不可点分组头（点击会撞服务端 cohort `400`，故由 `node.rankable` 在端上闸口）；展示 `rankableCount` 徽标。四态：loading / error（可重试）/ 空（未播种 taxonomy）/ 就绪。
- 新增 `pages/board` **非 tab 页**（category-scoped 分类榜）：从路由参数取 `category` slug + `name`，`setNavigationBarTitle` 为品类名；复用 `useRankings(category)` 把 slug 串入 `buildRankingsUrl` → `GET /rankings?category=<slug>`，沿用同一套三态 / 分页 / page-error 状态机与 `RankingRow` / `ListStates` / `ListFooter` 组件，仅去掉品牌头 / 搜索 / scope / chips / 广告位 chrome。
- `useRankings` 增加**可选 `category` 形参**（per-mount 稳定的路由参数）；传 `undefined` 时与原无 scope 榜单行为完全一致。
- 品类树扁平逻辑抽到纯 `tree.ts`（仅类型依赖 api-client）+ `tree.test.ts`（pre-order+depth+兄弟序、空输入 / 多 root 两条断言）。

只读边界不变：端上无 tier1 解析、无单价计算、无写路径；`comparableUnit`（is-a 继承）与 `rankableCount` 由服务端解析，端只渲染。

## 非目标

- **不动后端**：`GET /categories`、`GET /rankings?category=` 契约与实现均已上线，本次零后端改动；api-client 契约（`buildCategoriesUrl` / `parseCategoryTreeResponse` / `buildRankingsUrl` 的 `category` 参数）也已就位，不新增。
- **不做录入 / 纠错 / 贡献**：`我的` Tab 仍为占位，写路径留待 P6。
- **不做属性筛选 / 折叠展开 / 搜索**：树全展开（~12 节点），attribute chips 仍为占位；折叠与真实搜索留待后续。
- **不解上线域名门槛**：真机预览 / 发布仍需 ICP 可达域名进「请求合法域名」白名单，属上线工程、非本提案范围。

## 影响

- **workspace**：仅 `apps/miniapp`（`pages/category`、新增 `pages/board`、`pages/index/useRankings` 加形参、`app.config.ts` 注册 board 页）。
- **合规敏感面**：无——只读消费已算好的派生数据，无抓取、无众包写入。
- **API / 依赖**：无新增端点、无新依赖。
