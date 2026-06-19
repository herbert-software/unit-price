## 1. 数据层:useRankings 支持 category scope

- [x] 1.1 `useRankings(category?)` 加可选形参,`fetchPage(offset, category)` 串入 `buildRankingsUrl({ limit, offset, category })`;`category` 进 runFirst / refresh / runNext 的 `useCallback` 依赖
- [x] 1.2 验证 `undefined` 路径与原无 scope 榜单逐字节一致(`buildRankingsUrl` 跳过 `undefined`),榜单首页 `useRankings()` 行为不变

## 2. 品类树扁平(纯逻辑 + 单测)

- [x] 2.1 抽 `pages/category/tree.ts`:`toRows(nodes)` 按 `parentSlug` 构稳定 pre-order + depth,仅类型依赖 api-client、零运行时 import
- [x] 2.2 `pages/category/tree.test.ts`:pre-order+depth+兄弟序、空输入 / 多 root 两条断言(`vitest run` 通过)

## 3. 分类 Tab 接通品类树

- [x] 3.1 `pages/category/index.tsx`:占位页改为 `GET /categories`(经 `buildCategoriesUrl` + `Taro.request` + `parseCategoryTreeResponse`)一次性取整树,`toRows` 渲染缩进列表
- [x] 3.2 四态:loading / error(可重试)/ 空(未播种 `nodes:[]`)/ 就绪;`rankable` 节点可点、root/parent 不可点分组头;`rankableCount` 徽标
- [x] 3.3 点击 `rankable` 节点 `navigateTo` board,带 `category` slug + `name` 参
- [x] 3.4 `pages/category/index.css` 追加 `.ctree*` 树样式(仅引 token、零色板字面量),保留 `.placeholder*` 供四态卡复用

## 4. category-scoped 榜页(非 tab)

- [x] 4.1 新增 `pages/board/index.tsx`:`useRouter` 取 `category` / `name`,`setNavigationBarTitle` 为品类名,`useRankings(category)` 渲染列表,复用 `RankingRow` / `ListStates` / `ListFooter` 与 `../index/index.css`
- [x] 4.2 `pages/board/index.config.ts`:`enablePullDownRefresh` 对齐榜单 Tab
- [x] 4.3 `app.config.ts` 注册 `pages/board/index`(非 tab,不进 tabBar)

## 5. 校验

- [x] 5.1 `vitest run apps/miniapp/.../tree.test.ts` 通过;`tsc --noEmit -p apps/miniapp/tsconfig.json` 无新增类型错(仅既有 tsconfig 弃用告警)
- [x] 5.2 [手动验证] 微信 devtools 进 `分类` Tab 渲染并联调(并修了占位卡横向溢出);域名走 ICP 后已配「请求合法域名」
- [x] 5.3 [手动验证] `pnpm --filter @unit-price/miniapp build:weapp` 打包通过(api-client/core 先构建)

## 6. 对抗 review 修复(review-loop 两轮)

- [x] 6.1 board `name` 解码崩溃 → 抽 `pages/board/params.ts` `readBoardParams`(decode-once + try/catch 回退裸值,默认 `分类榜`),`board/index.tsx` 改用;配 `params.test.ts`(4 例,含 `%` 字面量不崩)
- [x] 6.2 `toRows` 静默丢孤儿节点 → fail-closed:`rows.length !== nodes.length` 即 throw(被分类页 `.catch` 接为错误态);更新 tree.ts 注释 + tree.test.ts 断言抛错;单亲节点结构上无 root-可达环,故无无限递归
- [x] 6.3 accepted-degraded(契约不可达,不改):空 `category=` 折为无 scope 榜(in-app slug `min(1)` 永非空)、双击 navigateTo(微信去重)、重复 leaf slug key 撞(`/categories` slug DB 唯一)
