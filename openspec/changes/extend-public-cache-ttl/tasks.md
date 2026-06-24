## 1. 代码:延长公共读 TTL

- [x] 1.1 `apps/api/src/routes.ts` 把 `PUBLIC_CACHE_CONTROL` 由 `public, max-age=300` 改为 `public, max-age=86400`,并更新其注释说明长 TTL 依据(价格月级稳定、临时优惠经 ingest、遵循源站已确认、purge/预热配套)。
- [x] 1.2 确认现有测试不锁具体 TTL 值(`apps/api/src/routes.test.ts` 断言 `/max-age=\d+/`、保留 `public`),改值不破坏。
- [x] 1.3 `pnpm -C apps/api test` 跑通(281 passed / 9 files;CI `verify` 亦绿):`/rankings`(非搜索)与 `/categories` 仍发 `public, max-age=…`、搜索/`compute` 仍 `no-store`。

## 2. 运维契约:runbook + 遵循源站确认

- [x] 2.1 `docs/backfill-runbook.md` 新增"数据更新后:刷新 CDN"小节(`RefreshObjectCaches` purge + `PushObjectCache`/curl 预热 + 遵循源站已确认无需配置)。
- [x] 2.2 实测确认阿里云 CDN 遵循源站 `Cache-Control`(`aliyun cdn DescribeCdnDomainConfigs` 无自定义 TTL 规则;curl 二次请求 `X-Cache: HIT`)。

## 3. 发布与验收

- [ ] 3.1 开 feature 分支、提 PR(含代码 + runbook),review 后合并 main(push-to-deploy 自动 migrate+deploy prod)。
- [ ] 3.2 部署后实测:`curl -D -` `https://unit-price.herbert-dev.cn/rankings?category=soft-drink` 应返回 `Cache-Control: public, max-age=86400`;二次请求 `X-Cache: HIT`、`total` ~50ms。
- [ ] 3.3 部署后按 runbook 对 `/rankings`、`/categories` 各路径执行一次 purge + 预热,确保切到新 TTL 后边缘是热的(避免首个用户吃跨境回源)。
