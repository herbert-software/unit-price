## 为什么

延长 CDN TTL([[extend-public-cache-ttl]])让稳态边缘命中降到 ~50ms,但**冷尾仍在**:purge 后第一个用户、TTL 过期、POP 驱逐时,首屏仍要等跨境回源 ~5–7s,且期间是空白 loading。小程序首屏现在**无任何端上兜底**——每次都裸等网络。端上 stale-while-revalidate(SWR)缓存可让**用户重开小程序时即时看到上次的榜单、后台再刷新**,把冷尾(以及弱网/瞬断)从"白屏 5–7s"变成"秒显旧榜 + 静默更新"。与 TTL 变更互补:TTL 提命中率(服务端/边缘),SWR 遮冷尾(端上)。

**作用时机=冷启动/榜单页新挂载那一刻**:榜单是常驻 tabBar 页,切 Tab/前后台回来由**保留的内存态**即时呈现(本就无白屏),SWR 即时回显**专治"无保留态"的冷启动首挂**(否则白屏 5–7s)。re-entry 自动重验不在本期(见非目标)。

## 变更内容

- **新增端上 SWR 缓存模块**(`apps/miniapp`),复用既有 `compute/history.ts` 的本地存储范式(`Taro.getStorageSync/setStorageSync` + 读时 fail-closed 校验):按 cohort 为键缓存榜单首页(offset=0)的已校验 `RankingsItem[]` 快照。**键 = 客户端自身 `category` 入参**,缺省(落地榜 `useRankings()` 不传、`category===undefined`)归一到一个**新定义的固定哨兵字面量**(如 `'__default__'`);客户端拿不到、也无需镜像服务端的 `'soft-drink'` 默认。SWR 钩在共享的 `useRankings`,故品类树下钻的 board 页经 `navigateTo` 新挂载**同样**走 SWR(按其 `category` 入参为键)——非仅落地榜。
- **`useRankings` 首屏走 SWR**:`runFirst` 在任何 `setState` 之前**先同步读缓存**——命中则**立即** `phase:'ready'` 渲染旧数据(跳过 loading 态)、并**同步 `offsetRef = cached.length`**(否则随后 `runNext` 会从 offset 0 重取、首页重复追加)→ 再后台 `fetchPage(0)` 重验,成功则覆盖 state + offset + 缓存;**后台重验失败但有缓存时保留旧数据**(沿用既有 `refresh` catch 的 `if (s.items.length) 保 ready` 范式,不翻首屏错)。缓存**缺失**时行为回落到既有"加载/空/错三态",**不变**。
- **读缓存即重校验**:缓存体经 `parseRankingsResponse(raw)` 再用(**单参**,`jitless` 已在该函数内部写死、`raw` 是 weapp-safe;**不**传第二参);损坏/旧 schema 残留 → 视作未命中,绝不渲染脏数据。
- **写缓存**:在 `runFirst` 成功分支内 `writeBoard`(自动覆盖 loadFirst / retryFirst 两条首页成功路径),`refresh` 成功亦写。只写 `offset=0` 且 `q===undefined` 的板。

## 功能 (Capabilities)

### 新增功能
<!-- 无新增能力。 -->

### 修改功能
- `miniapp`: 在既有"榜单一屏必须支持分页与加载/空/错三态"之外,**新增**一条端上 SWR 缓存需求——有缓存时即时渲染旧榜 + 后台重验、重验失败保留旧榜;缓存缺失路径(既有三态)不变。

## 影响

- **代码**:`apps/miniapp` 新增一个小存储模块(仿 `compute/history.ts`)+ 改 `src/pages/index/useRankings.ts` 的 `runFirst`/`refresh`。无 API/契约变化、无新依赖、不碰 `packages/*`。
- **客户端存储**:新增 storage key(榜单快照,按 cohort)。board cohorts ≈ 低数十个 rankable slug × 每板 ~4KB ≪ weapp 10MB 总配额,覆写即可、无需淘汰。
- **不触合规敏感面**:纯端上缓存,无抓取/众包/网络新增。

## 非目标

- **不缓存搜索 `?q=`**:服务端对搜索发 `no-store`(长尾、各 `q` 几乎不复用),端上同样不缓存。
- **不缓存翻页(offset>0)**:只缓存首页;SWR 目标是首屏冷尾,翻页非首屏关键路径。
- **不加客户端 TTL / 过期逻辑**:SWR 每次首屏都后台重验,旧数据只展示到 fresh 到达的几秒;数据月级稳定,无需端上过期。
- **不缓存 `/categories` 品类树**:分类 Tab 是二级入口、非首屏;留作后续。
- **不做离线优先 / 后台同步 / service-worker 式预取**:仅"读时即时回显 + 后台刷新"。
- **不做 warm re-entry 自动重验**:切 Tab/前后台回来由保留的内存态即时呈现(已无白屏),不挂 `useDidShow`/`onShow` 去自动刷新(数据月级稳定,陈旧到下拉刷新即可);SWR 只钩冷启动/新挂载的 `runFirst`。要 re-entry 刷新是独立后续。
- **不改既有 cache-miss 三态、不改翻页错语义**:SWR 是叠加分支,既有错误/分页契约保持不变。
