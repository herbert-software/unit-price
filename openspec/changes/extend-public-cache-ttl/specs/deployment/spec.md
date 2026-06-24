## 新增需求

### 需求:公共读端点必须经长 TTL 边缘缓存并在数据变更后刷新

公共只读端点(`GET /rankings` 的**非搜索**成功响应、`GET /categories`)**必须**经长 TTL 边缘缓存,使国内访问命中阿里云 CDN POP、绕开跨境回源那一跳(实测 MISS 总耗时数秒、HIT ~50ms,差约 100×),代价是受控的陈旧;其 TTL、遵循源站前置与刷新契约**必须**满足下列各条:

- 上述非搜索公共读成功响应**必须**带 `public` 且 TTL **≥ 1 天**的 `Cache-Control`(经 `apps/api` 的共享常量 `PUBLIC_CACHE_CONTROL`),理由是商品价格月级稳定、只有偶发临时优惠且都经 `/ingest` 批次进数据,数据极静态。
- 边缘 CDN **必须**遵循源站 `Cache-Control`、**禁止**以自有默认 TTL 覆盖源站值——此为长 TTL 真正生效的前置(已实测满足:无自定义 TTL 规则、二次请求 `X-Cache: HIT`)。
- 任何**改变 prod 数据**的运维(`/ingest` 新批次、临时优惠、taxonomy 打标签 backfill、native-id 回填)在完成后**必须**刷新(purge)并**预热**受影响的公共读路径(`/rankings`、`/categories`),使变更即时可见;否则第一个真实用户会吃满跨境回源。
- 未主动刷新时,边缘陈旧**必须**有界:不超过上述 TTL,过期后自愈。
- 搜索 `?q=`(`/rankings`)与 `/compute` 的 `no-store` 不受本需求影响,由各自端点 spec 管辖。

#### 场景:非搜索公共读响应带长 TTL public 缓存头

- **当** 客户端 `GET /rankings`(无有效 `q`)或 `GET /categories` 返回 `200`
- **那么** 响应**必须**带 `public` 且 `max-age ≥ 86400`(1 天)的 `Cache-Control`(经共享 `PUBLIC_CACHE_CONTROL`),`400/500` 错误路径**禁止**带缓存头

#### 场景:边缘遵循源站、TTL 内二次请求命中

- **当** 同一非搜索公共读 URL 在 TTL 内被二次请求
- **那么** 边缘 CDN **必须**从缓存命中返回、**不**回源(即遵循源站 `Cache-Control`、未以自有默认 TTL 覆盖)

#### 场景:数据变更后刷新+预热使变更即时可见

- **当** 一次改变 prod 数据的运维(`/ingest` 或 backfill / native-id 回填)完成
- **那么** 运维**必须**刷新并预热受影响的 `/rankings`、`/categories` 路径,使新数据即时可见;若未刷新,边缘陈旧**必须**不超过 TTL 并在过期后自愈
