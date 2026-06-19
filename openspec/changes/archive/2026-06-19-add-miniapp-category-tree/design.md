## 上下文

后端 Phase 3 已上线：`GET /categories`(品类 is-a 树,节点带 is-a 继承后的 `comparableUnit`、`rankable`、`rankableCount`)与 `GET /rankings?category=<slug>`(cohort-scoped 榜)均可用;`@unit-price/api-client` 也已导出 `buildCategoriesUrl` / `parseCategoryTreeResponse` 及 `buildRankingsUrl` 的 `category` 参数。`分类` Tab 当前是「敬请期待」占位页。本变更是纯 `apps/miniapp` 端上接线,零后端、零新依赖。约束:微信小程序禁 `new Function`(Zod 走 `jitless`,api-client 已处理);只读边界不变(端上无 tier1 / 无单价计算 / 无写路径)。

## 目标 / 非目标

**目标:**
- `分类` Tab 接通 `GET /categories`,渲染可下钻的品类树。
- 点击可比品类进入按 `per100ml` 升序的 category-scoped 榜。

**非目标:**
- 不动后端 / api-client 契约(均已就位)。
- 不做录入 / 纠错 / 属性筛选 / 折叠展开 / 搜索。
- 不解上线域名门槛(ICP 可达域名 + 请求合法域名白名单,属上线工程)。

## 决策

- **复用 `useRankings`、加可选 `category` 形参,而非另写榜单 hook**:榜单的三态 / 分页 / page-error 状态机已测试稳定;`category` 来自路由参数、per-mount 稳定,串入 `buildRankingsUrl({ category })` 即可。传 `undefined` 时与原无 scope 榜单行为逐字节一致(`buildRankingsUrl` 跳过 `undefined`)。备选「复制一份榜单 hook」被否——徒增分叉维护面。
- **category-scoped 榜用独立非 tab 页 `pages/board`,而非复用榜单 tab 页**:tab 切换走 `switchTab`、**不能带参**,且榜单 tab 有品牌头 / scope / chips chrome 不适合品类榜;`navigateTo` 非 tab 页可带 `category` / `name` 参、自带返回键、标题随品类。board 复用 `RankingRow` / `ListStates` / `ListFooter` 与 `../index/index.css`,不复制列表 chrome。
- **品类树全展开、无折叠**:整树约 12 节点,单屏可容;折叠是 YAGNI,留 `ponytail:` 注记待树长大再加。
- **树扁平逻辑抽到纯 `tree.ts`(仅类型依赖 api-client)+ vitest**:`toRows` 是本变更唯一非平凡逻辑(按 `parentSlug` 构 pre-order + depth);抽出后可脱离 Taro 运行时单测,页面只留渲染。
- **可点性由 `node.rankable` 端上闸口**:`rankable=false`(root `饮料` / `酒类` parent)点击会撞服务端 cohort `400`,故端上直接不可点,避免无效请求。

## 风险 / 权衡

- [Taro.request 对 HTTP 4xx 不 reject,400 响应体会进 `parseCategoryTreeResponse` / `parseRankingsResponse`] → 错误体不合 schema、Zod 抛错 → 落入既有 error 态(整屏错误 + 重试),不崩溃;加之 `rankable` 闸口正常路径不会触发 400。
- [board 跨页 import `../index/useRankings` / `../index/config`,目录耦合] → 可接受:同属榜单数据层、最短改动;若日后第三处复用再上移到共享目录。
- [BASE 仍是 prod workers.dev,大陆不可达] → 与榜单 Tab 同一既有约束,非本变更引入;真机门槛在 ICP 域名(非目标)。
