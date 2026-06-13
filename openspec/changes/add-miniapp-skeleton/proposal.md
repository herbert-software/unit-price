## 为什么

`GET /rankings` 已上线 prod（329 条山姆饮料 per100ml 榜）。架构蓝图四个薄客户端里的**小程序**是这份数据的第一个展示端，也是数据飞轮的消费面。本变更做**简版只读小程序**（`apps/miniapp`，Taro 4 + React）——v1 砍掉录入/扫码，只做「榜单浏览」，把已算好的真实单价摆到用户面前。

同时，miniapp 是 `/rankings` 的**第二个消费方**（第一个是 apps/api 自身），正是建架构蓝图早写好的 `packages/api-client`（typed SDK 位）的自然触发点：把响应契约从 `apps/api` 抽进共享包，让 api 与小程序**共依赖同一份契约**，消除重复、也为未来插件/Surge 复用铺路。

## 变更内容

- **新建 `packages/api-client`（共享契约包，传输无关）**：把 `RankingsResponseSchema` 从 `apps/api/src/routes.ts` **挪进**本包，导出 schema + `RankingsItem`/`RankingsResponse` 类型 + `buildRankingsUrl(base, { limit, offset, category? })` + `parseRankingsResponse(json)`（Zod 校验）。**不发请求**——发请求（`fetch`/`Taro.request`）留各客户端，本包像 core 一样纯、可被任意端复用。`apps/api` 改为从本包 import（纯重构、行为不变、测试保持绿）。
- **新建 `apps/miniapp`（Taro 4.2 + React + TS 骨架）**：一屏只读榜单，`Taro.request` 直连 prod `/rankings`，下拉刷新 + 触底分页（limit/offset），空/错/loading 三态。
- **列表内原生广告位组件（降级版）**：前 ~10 名无广告、每 ~12 条插 1 张、预留卡高 + 无填充优雅塌缩；v1 **不接真实广告单元、不办流量主**（流量主需 ≥1000 累计 UV，提前接也不出钱）——本期只把「会自动消失的位」做进布局。
- **首任务 = Taro 集成 spike**：先验证 `import { … } from '@unit-price/api-client'` 在 `taro build --type weapp` 真能打通（ESM workspace 包打包 + Zod 在小程序运行时），再铺 UI；失败退到 Taro `compile.include` 编 api-client 源码 / api-client 出 CJS dual。

## 功能 (Capabilities)

### 新增功能
- `api-client`: 共享 API 契约包（传输无关）。本期落 rankings 契约——`RankingsResponseSchema`、`RankingsItem`/`RankingsResponse` 类型、`buildRankingsUrl`、`parseRankingsResponse`。定义其纯/传输无关边界、与 core（`WarningsSchema`）的依赖、apps/api 的复用方式。
- `miniapp`: 简版山姆比价小程序（Taro，只读榜单）。本期落骨架 + 一屏榜单契约——数据源（prod `/rankings`）、分页（下拉/触底）、空/错/loading 三态、行字段渲染、降级版广告位、构建集成（出根 reference 图 / 消费 api-client dist）。

### 修改功能
- `rankings-api`: 响应 schema 落点从「现居 `apps/api/src/routes.ts`、`packages/api-client` 尚未建」更新为「现居 `packages/api-client`，apps/api 与客户端共依赖同一份」。**API 行为、契约字段、错误码、治理豁免均不变**（纯重构）。

## 影响

- **packages/api-client（新）**：依赖 `@unit-price/core`（`WarningsSchema`）；apps/api 反向改 import；其 schema 即 rankings-api spec 的契约源。
- **apps/api（改）**：`routes.ts` 改为从 api-client import `RankingsResponseSchema`（schema 定义移出）；`index.ts` 改为从 api-client re-export 那三个符号（下游不断）；加 `@unit-price/api-client` workspace 依赖 + tsconfig project reference。**行为/测试结果不变**——回归由既有 `/rankings` **行为测试**保证（实测无测试直接 import 该 schema，故非 "import 同步"）。
- **apps/miniapp（新）**：Taro 工程，**不进根 `tsc -b` reference 图**（Taro 自管 webpack5/vite 构建），workspace 成员、deps 走 `workspace:*`；消费 prod `/rankings`（base URL 待钉 `[手动验证]`）。
- **合规面**：纯读已沉淀的公开榜单数据，**不触碰抓取/众包采集敏感面**；广告为降级占位、不实际服务。
- **非目标（本期不做）**：录入/扫码（v1 砍）；反套路徽标 polish 与 per100ml 主角排版（行先朴素渲染）；真实广告服务 / 流量主开通 / 广告单元（等 ≥1000 UV）；激励视频（无奖励钩子，留到有收藏/订阅/录入额度）、插屏（高频工具弹窗招人烦，不用）；微信小程序 AppID + 主体备案 + 经营类目（流程长杆，与代码解耦、并行办，release/真机才卡）；api-client 只搬 rankings 契约、不一次性搬全部 schema、不做带请求的 SDK。
