## 上下文

小程序首屏慢经实测定位:链路为 小程序 → 阿里云 CDN(`unit-price.herbert-dev.cn`,国内 POP)→ 回源 CF 自定义域(`unit-price.herbertgao.me`)→ Worker → D1。公共读端点发 `Cache-Control: public, max-age=300`。aliyun CLI + curl 实测:

- 边缘**已遵循源站缓存头**(无自定义 TTL 规则,二次请求 `X-Cache: HIT TCP_MEM_HIT`)。
- **MISS 总耗时 4.9–7.1s(TTFB 3–5s,全在回源那一跳),HIT ~50ms**——差约 100×;DNS/connect/TLS 仅几毫秒(POP 很近)。

低频访问 + 5 分钟 TTL ⇒ 多数访问是冷 MISS。数据极静态(价格月级不变,临时优惠经 `/ingest`),5 分钟 TTL 纯浪费命中率。

## 目标 / 非目标

**目标:**
- 把非搜索公共读的有效缓存窗口从 5 分钟拉到天级,使绝大多数访问从 5–7s 降到 ~50ms。
- 把"长 TTL 的配套契约"(遵循源站前置 + 数据变更后 purge/预热 + 陈旧有界)显式化,进 spec + runbook。

**非目标:**
- 不优化跨境回源那一跳本身(CF 大陆可达性,更大基础设施话题)。
- 不做端上 SWR/本地缓存、不加 worker 层 KV/Cache API、不改搜索/compute 的 `no-store`、不做自动 purge 脚本。

## 决策

- **TTL = `max-age=86400`(1 天),而非更长**:价格月级稳定本可设更久,但 1 天把"忘了 purge"的爆炸半径限定在 24h 自愈,同时已拿到几乎全部命中率收益(5min→1天后 TTL 不再是命中瓶颈;1天→7天为边际)。值集中在共享常量 `PUBLIC_CACHE_CONTROL`,一处改、`/rankings`(非搜索)与 `/categories` 同时生效。需要更激进时改这一个常量即可。
- **契约归属 `deployment`,不 churn 端点 spec**:`rankings-api` 现有需求是"搜索→`no-store`、非搜索→既有 public Cache-Control",TTL 数值从来不是其 spec 需求、改值后该需求仍成立。真正新增的是跨端点+跨运维的**边缘新鲜度契约**,归生产部署拓扑(`deployment`)用 `## 新增需求` 承载,避免在 rankings/categories 两份 spec 重复同一契约(单一事实源)。
- **purge + 预热,而非只 purge**:因单次回源 3–7s,purge 后第一个真实用户会吃满。故契约要求数据变更后刷新(`RefreshObjectCaches`)**并**预热(`PushObjectCache` 或 curl 热 URL),让边缘提前回源一次。
- **遵循源站作为前置写入契约但无需新配置**:已实测满足(无自定义 TTL 规则、二次 `HIT`),故本次纯属"确认+记档",不动阿里云控制台。

## 风险 / 权衡

- **陈旧窗口变长(临时优惠延迟可见)** → 缓解:数据变更经 `/ingest`/backfill,运维流程末尾 purge+预热即时生效;即便漏 purge,≤1 天自愈。价格月级稳定使该风险本就低。
- **首个全冷用户仍吃 5–7s 回源** → 缓解:purge 后预热消除"刚清完缓存"的冷尾;稳态下命中率高使真实用户极少撞上。彻底消除需另案处理跨境回源,非本次范围。
- **依赖人工执行 purge/预热步骤(无自动化)** → 缓解:写入 runbook 显式步骤;漏执行的后果被 1 天 TTL 上界兜住,非数据损坏。自动化留作后续。
- **现有测试** 断言 `/max-age=\d+/`(不锁值)→ 改 86400 不破坏;`public` 前缀保留。
