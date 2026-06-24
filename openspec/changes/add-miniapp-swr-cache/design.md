## 上下文

`apps/miniapp/src/pages/index/useRankings.ts` 是榜单数据层:`runFirst()` 发 `fetchPage(0)` → 成功 `phase:'ready'`、失败 `phase:'error'`(空列表整屏错);`loadFirst` 仅在 `phase==='idle'` 触发。当前**无任何端上缓存**,每次首屏裸等网络。`compute/history.ts` 已是成熟的端上存储范式:`Taro.getStorageSync/setStorageSync` + 读时 fail-closed 校验(`Array.isArray` 守卫 + 逐项 `safeParse({jitless:true})` + 损坏即丢)。`parseRankingsResponse` 已是榜单体的权威 jitless 校验入口。

## 目标 / 非目标

**目标:**
- 回访首屏在边缘冷尾(purge 后 / TTL 过期 / POP 驱逐)与弱网下**即时回显**上次榜单,后台静默刷新。
- 复用既有存储/校验范式,不引入新依赖、不碰契约。

**非目标:**
- 不缓存搜索(`q`)/翻页(`offset>0`)/品类树;不加客户端 TTL;不做离线优先或后台同步;不改既有 cache-miss 三态与翻页错语义。

## 决策

- **新存储模块仿 `history.ts`**(如 `src/pages/index/boardCache.ts`):导出 `readBoard(cohortKey)` / `writeBoard(cohortKey, items)`。读侧 fail-closed:`getStorageSync` 包 try/catch、`Array.isArray` 守卫、**经 `parseRankingsResponse(raw)` 重校验**(单参——`jitless` 已在该函数内部写死,**不**传第二参;与既有 `useRankings.ts:87` 调用同形,**异于** `history.ts` 直接对裸 schema `safeParse(x,{jitless:true})`),任一失败返回 `null`(未命中)。绝不另造校验——榜单体单一校验入口就是 `parseRankingsResponse`。
- **缓存键 = 客户端自身 `category` 入参**(非服务端解析后的 slug):`cohortKey = category ?? DEFAULT_COHORT_KEY`,`DEFAULT_COHORT_KEY` 是 `boardCache.ts` 内**新定义**的固定字面量(如 `'__default__'`)。落地榜 `useRankings()` 不传 category → `category===undefined`,`buildRankingsUrl` 省略该参、服务端自行默认 `'soft-drink'`,但该 slug **客户端拿不到、也无需镜像**——键于自身入参、undefined 归一哨兵即可(每 board page 一次挂载 category 固定,键稳定)。每 cohort 存最近一次首页快照(~4KB),覆写即可,无淘汰逻辑。**只存 `offset=0`、`q===undefined`**(useRankings 边界已解析/截断后的值,非原始 key 存在性;与服务端对有效 `q` 发 `no-store` 同口径)的板;`q` 有效 / 翻页绕过缓存。
- **SWR 钩入 `runFirst`,不改 `runNext`/翻页**:
  - **同步读的落点 + 守卫顺序**:`runFirst` 体内顺序固定为 **`if (inFlightRef.current) return; inFlightRef.current = true;` 最先 → 再 `readBoard` → 命中则同步 `setState(ready)`+`offsetRef` → `await fetchPage(0)` → `finally { inFlightRef.current = false }`**。即**整个"命中渲染 + 后台重验"包在同一次 `inFlightRef` 占用内**,与 `refresh`/`loadNext` 共用同一互斥(防 board 页挂载即下拉刷新与后台重验交织)。**禁止**把 `readBoard`/`runFirst` 嵌进 `loadFirst` 的 `setState` updater(updater 须纯、dev 下会双调)——idle 判定与缓存读分离(idle 判定移到 `loadFirst` 外层 `useRef` 或 `runFirst` 首段)。
  - **命中**:单次 `setState({phase:'ready', items: cached, …})`(跳过 loading)+ **同步 `offsetRef.current = cached.length`**(关键:否则后台 fetch 未回前用户触底,`runNext` 从 offset 0 重取、首页重复追加)→ 再后台 `fetchPage(0)`;成功 → 覆盖 items + `offsetRef` + `writeBoard`;**失败 → 保留旧 items/offset(仍 ready),不进 error**。
  - **未命中**:走现状(`phase:'loading'` → fetch → ready/error)。
  - **catch 改写(必须)**:当前 `runFirst` catch(useRankings.ts:128-137)**无条件**设 `phase:'error', items:[]`;改成**镜像既有 `refresh` catch**(useRankings.ts:171-188 的 `if (s.items.length) 保 ready else 整屏 error`),读 live `items` 分叉。`writeBoard` 放进 `runFirst` 成功分支内(自动覆盖 loadFirst + retryFirst 两条路径),不放调用方。后台重验沿用 `inFlightRef` 守卫(置位/复位),与 `refresh`/`loadNext` 互斥不变。
- **仅冷启动/新挂载触发(生命周期)**:`useLoad→loadFirst@idle` 在常驻 tabBar 页一生只挂一次;切 Tab/前后台回访由保留内存态即时呈现(本就无白屏),**不重读缓存、不自动重验**——这是有意的(数据月级稳定,re-entry 刷新属非目标)。即时回显的收益面 = 冷启动/重开小程序那一刻。
- **为何只首页**:首页是首屏唯一阻塞请求,冷尾痛点全在它;翻页是滚动后的次级路径,缓存收益低、复杂度高(分页拼接),YAGNI。

## 风险 / 权衡

- **展示短暂陈旧(旧榜→fresh 覆盖时可能轻微重排)** → 缓解:数据月级稳定,陈旧仅持续到 fresh 到达的几秒;SWR 语义本就接受;不做差异动画(过度)。
- **缓存损坏/旧 schema 渲染脏数据** → 缓解:读即经 `parseRankingsResponse` 重校验,失败视作未命中,与既有"禁止渲染未校验数据"一致。
- **写存储失败(配额/不可用)** → 缓解:`writeBoard` 包 try/catch,失败仅丢本次缓存、不阻断渲染(同 `history.ts`)。
- **命中即时回显未同步 `offsetRef` → `runNext` 从 0 重取、首页重复** → 缓解:命中渲染时同步 `offsetRef.current = cached.length`(与 happy path `runFirst` 落 offset 同口径);加 loadNext-after-revalidate-fail 回归测试。
- **并发(即时回显 setState + 后台 fetch + 期间下拉 `refresh`)** → 缓解:即时回显是同步 setState、后台 fetch 串其后并置 `inFlightRef`,与 `refresh`/`loadNext` 共享同一守卫互斥;无新竞态面。
- **缓存键漂移(客户端键 vs 服务端 `soft-drink` 默认)** → 缓解:键于**客户端自身 `category` 入参** + 新定义哨兵字面量(`undefined→'__default__'`),**不镜像**服务端 slug(拿不到、也无需);每 board page 挂载 category 固定 → 键稳定、不漂移。
