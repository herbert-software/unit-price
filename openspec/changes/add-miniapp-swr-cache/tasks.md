## 1. 端上缓存模块(仿 compute/history.ts)

- [ ] 1.1 新建 `apps/miniapp/src/pages/index/boardCache.ts`:`readBoard(cohortKey)`(`getStorageSync` 包 try/catch + `Array.isArray` 守卫 + 经 **`parseRankingsResponse(raw)`(单参,不传 `{jitless:true}`——已内置)**重校验,任一失败 → `null`)、`writeBoard(cohortKey, items)`(`setStorageSync` 包 try/catch,失败仅丢缓存)。**新定义** `DEFAULT_COHORT_KEY` 字面量(如 `'__default__'`),`cohortKey = category ?? DEFAULT_COHORT_KEY`(键于客户端自身 `category` 入参,**不**镜像服务端 `soft-drink`)。
- [ ] 1.2 单测 `boardCache.test.ts`(仿 `history.test.ts`):有效快照 read↔write roundtrip;损坏体(非数组 / 旧 schema / 脏字段)→ `null`;write 抛错被吞、不冒泡。

## 2. useRankings 接入 SWR

- [ ] 2.1 `runFirst` **开头(任何 `setState` 之前)**同步 `readBoard(cohortKey)`;**不得**把读/`runFirst` 嵌进 `loadFirst` 的 `setState` updater(updater 须纯)。命中 → 单次 `setState({phase:'ready', items: cached, …})`(跳过 loading)+ **同步 `offsetRef.current = cached.length`** + 后台 `fetchPage(0)`(置 `inFlightRef`)。
- [ ] 2.2 改 `runFirst` 的 catch:**镜像既有 `refresh` catch**(useRankings.ts:171-188 的 `if (s.items.length) 保 ready else 整屏 error`),替换当前无条件 `phase:'error',items:[]`。`writeBoard` 放进 `runFirst` 成功分支内(覆盖 loadFirst + retryFirst);`refresh` 成功亦 `writeBoard`。**仅** `offset=0` 且 `q===undefined`(useRankings 边界已解析值)读写缓存;`runNext`/有效 `q` 不读不写。
- [ ] 2.3 **新建** `useRankings` 状态机测试(mock `Taro.request` + `boardCache`;现有 `useRankings.test.ts` 仅 URL-builder、无状态机 harness,本项需从零搭):命中缓存即时 ready 无 loading + 同步 offset=cached.length + 后台覆盖;**命中后触底 `runNext` 从 offset=cached.length 续取、首页不重复**;命中后后台失败保留旧快照停 ready;缓存缺失回落 loading→ready/空/首屏错(既有三态不回归);搜索/翻页绕过缓存。

## 3. 验收与发布

- [ ] 3.1 `pnpm -C apps/miniapp test` + typecheck 通过;既有榜单三态/分页用例不回归。
- [ ] 3.2 devtools + 真机实测:① 清缓存冷启动 = loading→ready;② **杀进程重开**(冷启动有缓存)= 秒显旧榜 + 后台刷新覆盖;③ 断网/弱网冷启动重开 = 保留旧榜、不整屏报错;④ 命中后触底翻页不重复首页;⑤ 共享 hook 波及面:从品类树下钻一个 **category board** 后杀进程重开 → 确认按该 cohort 键命中、且搜索板(有效 q)从不写缓存。
- [ ] 3.3 开 feature 分支提 PR、review 后合并 main。
