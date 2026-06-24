## 1. 端上缓存模块(仿 compute/history.ts)

- [x] 1.1 新建 `apps/miniapp/src/pages/index/boardCache.ts`:`readBoard(cohortKey)`(`getStorageSync` 包 try/catch + `Array.isArray` 守卫 + 经 **`parseRankingsResponse(raw)`(单参,不传 `{jitless:true}`——已内置)**重校验,任一失败 → `null`)、`writeBoard(cohortKey, items)`(`setStorageSync` 包 try/catch,失败仅丢缓存)。**新定义** `DEFAULT_COHORT_KEY` 字面量(如 `'__default__'`),`cohortKey = category ?? DEFAULT_COHORT_KEY`(键于客户端自身 `category` 入参,**不**镜像服务端 `soft-drink`)。
- [x] 1.2 单测 `boardCache.test.ts`(仿 `history.test.ts`):有效快照 read↔write roundtrip;损坏体(非数组 / 旧 schema / 脏字段)→ `null`;write 抛错被吞、不冒泡。

## 2. useRankings 接入 SWR

- [x] 2.1 `runFirst` **开头(任何 `setState` 之前)**同步 `readBoard(cohortKey)`;**不得**把读/`runFirst` 嵌进 `loadFirst` 的 `setState` updater(updater 须纯)。命中 → 单次 `setState({phase:'ready', items: cached, …})`(跳过 loading)+ **同步 `offsetRef.current = cached.length`** + 后台 `fetchPage(0)`(置 `inFlightRef`)。
- [x] 2.2 改 `runFirst` 的 catch:**镜像既有 `refresh` catch**(useRankings.ts:171-188 的 `if (s.items.length) 保 ready else 整屏 error`),替换当前无条件 `phase:'error',items:[]`。`writeBoard` 放进 `runFirst` 成功分支内(覆盖 loadFirst + retryFirst);`refresh` 成功亦 `writeBoard`。**仅** `offset=0` 且 `q===undefined`(useRankings 边界已解析值)读写缓存;`runNext`/有效 `q` 不读不写。
- [x] 2.3 SWR 决策抽成**纯导出函数 + 单测**(本仓刻意无 React/Taro hook renderer、按既有 `useRankings.test.ts` 范式只测纯函数,**不引入** `@testing-library/react`/jsdom):`shouldUseBoardCache`(仅 offset0+q===undefined 缓存,搜索/翻页绕过)、`boardHitState`(命中即 ready 跳 loading、reachedEnd=len<PAGE_SIZE)、`firstScreenCatchState`(有列表保 ready / 空整屏错)、`revalidateFailState(prev, hadCache)`(命中含空 `[]` 时保 ready、防空快照命中被判错)均覆盖。**注:hook 级 imperative wiring**(`runFirst` 仅 `canCache` 时读写缓存、命中同步 `offsetRef=cached.length`、`inFlightRef` 互斥、`loadFirst` 首挂触发)**纯函数测覆盖不到,由 3.2 真机硬门兜底**(见下)。

## 3. 验收与发布

- [x] 3.1 `pnpm -C apps/miniapp test`(94 passed / 8 files,含新增 SWR 纯函数测[shouldUseBoardCache/boardHitState/firstScreenCatchState/revalidateFailState]+ 既有三态/分页不回归)+ typecheck(`tsc --noEmit --ignoreDeprecations 6.0` exit=0;裸跑的 TS5107/TS5101 是仓库既有 tsconfig 弃用告警、非本变更引入)。
- [x] 3.2 **(硬合并门——3.3 之前必跑)** devtools + 真机实测**已通过**。这是 hook 级 wiring + 真实 weapp jitless 校验缓存体 + 冷启动生命周期的**唯一覆盖层**(纯函数测够不着):① 清缓存冷启动 = loading→ready;② **杀进程重开**(冷启动有缓存)= 秒显旧榜 + 后台刷新覆盖;③ 断网/弱网冷启动重开 = **保留旧榜(含空 cohort 不翻整屏错)**、不报错;④ 命中后触底翻页**不重复首页**(验 `offsetRef=cached.length`);⑤ 共享 hook 波及面:从品类树下钻一个 **category board** 后杀进程重开 → 确认按该 cohort 键命中、且搜索板(有效 q)从不写缓存。
- [x] 3.3 PR #52 已 review(review-loop 两轮 + CodeRabbit)、3.2 真机通过后合并 main。
