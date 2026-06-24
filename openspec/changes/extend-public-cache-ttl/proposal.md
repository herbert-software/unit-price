## 为什么

实测小程序首屏慢的根因不是 CDN 缺失,而是公共读端点 `Cache-Control: max-age=300`(5 分钟)对一个低频访问的应用太短:绝大多数访问都落在 cache MISS 上,而单次 MISS 要走阿里云 POP→海外 CF/D1 的跨境回源——实测 **MISS 总耗时 4.9–7.1s,HIT 仅 ~50ms(差约 100×)**。商品价格月级稳定、只有偶发临时优惠(且都经 `/ingest` 批次进数据),数据极静态,5 分钟 TTL 纯属浪费命中率。把公共读 TTL 拉长到天级即可把多数访问从 5–7s 降到 ~50ms。

## 变更内容

- **公共读端点 TTL 由 5 分钟拉长到 1 天**:`apps/api` 的共享常量 `PUBLIC_CACHE_CONTROL` 由 `public, max-age=300` 改为 `public, max-age=86400`(`/rankings` 非搜索响应 + `/categories` 共用)。搜索 `?q=` 与 `/compute` 的 `no-store` **不变**。
- **明确边缘缓存新鲜度契约**(此前只在代码注释、未进 spec):
  - 边缘(阿里云 CDN)**遵循源站 `Cache-Control`**——实测已满足、无需控制台改动(无自定义 TTL 规则,`X-Cache` 二次请求 `HIT`)。此为长 TTL 生效的前置,记入契约。
  - 任何改 prod 数据的运维(`/ingest` 新批次、临时优惠、taxonomy backfill / native-id 回填)**必须在完成后刷新(purge)并预热 CDN**,使变更即时生效;否则陈旧上限为 TTL(≤1 天,自愈)。
- **runbook 补充**:`docs/backfill-runbook.md` 增加"数据更新后刷新 + 预热 CDN"小节(含 `RefreshObjectCaches` / `PushObjectCache` 命令)与"遵循源站已确认"说明。

## 功能 (Capabilities)

### 新增功能
<!-- 无新增能力:仅给既有公共读链路补上明确的边缘缓存新鲜度契约。 -->

### 修改功能
- `deployment`: 新增"公共读端点边缘缓存新鲜度契约"需求——钉定公共读长 TTL、边缘遵循源站(前置,已确认)、数据变更后必须 purge+预热、否则陈旧≤TTL。(CDN/边缘层属生产部署拓扑,归 deployment;`rankings-api` 的"搜索发 no-store / 非搜索发 public Cache-Control"需求不变、仍成立,TTL 数值本就不是其 spec 需求。)

## 影响

- **代码**:`apps/api/src/routes.ts` 单常量 `PUBLIC_CACHE_CONTROL`(300→86400)。无类型/接口变化;现有测试断言 `/max-age=\d+/` 不锁值,不受影响。
- **文档/运维**:`docs/backfill-runbook.md` 新增刷新+预热小节;阿里云 CDN 运维新增"数据变更后 purge/预热"动作(`aliyun cdn RefreshObjectCaches`/`PushObjectCache`,凭据已具备)。
- **客户端**:无需改动;小程序按现有请求即享更高命中率。
- **不触合规敏感面**:不涉抓取/众包数据流变化。

## 非目标

- **不优化跨境回源那一跳本身**:MISS 仍是 ~5–7s。CF 在大陆的可达性是更大的基础设施话题,本次不碰;长 TTL + purge/预热只是让真实用户极少撞上它。
- **不做端上 SWR / 本地缓存**:重访秒开是独立后续变更,不在本提案。
- **不在 worker 层加 KV / Cache API 缓存**:边缘 CDN 已够,不引入新缓存层。
- **不改搜索 `?q=` 与 `/compute` 的 `no-store`**:防 CDN 污染的既有设计保持不变。
- **不做 CDN 自动 purge 脚本**:runbook 手动步骤即可;自动化(如部署/ingest 钩子触发刷新)留作后续。
