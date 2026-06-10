# TODO — 进度板

> 一页式进度概览，只到 **Phase 级**。任务级拆解不写在这里——交给 OpenSpec（`openspec/` 下的 change）。
> 路线的设计理由见 [`docs/architecture.md`](docs/architecture.md) 第八节。

**当前焦点**：Phase 1 — OpenSpec change `bootstrap-parse-skeleton`（walking-skeleton 已实现）

---

## Phase 1 — core 引擎 + `/parse` `/compare`（饮料、每 100ml）
先做准。范围：`饮料 + 山姆 + 每100ml + 标题/价格解析 + 可比判断 + 人工纠错`。

- [x] monorepo 骨架（pnpm workspace + TS project references + Zod）
- [x] `packages/core`：types / units / parser(tier1) / calculator(tier3) / 字段分层
- [x] `packages/core` 单测（脏标题样本集）
- [x] `apps/api`：Hono + `SpecParserLLM` port（OpenRouter，单档）+ tier2 解析
- [x] `POST /parse` 接口 + 契约验证（39 测试 + 真实 e2e）
- [ ] `POST /compare` 接口（skeleton 未做，后续 change）
- [ ] Redis 解析缓存（skeleton 未做，后续 change）
- [ ] 最小客户端（Web 或插件）验证解析准确率与单价体验
- [x] eval 回归基线 ✓（解析准确率离线验证）

> 已完成部分由 OpenSpec change `bootstrap-parse-skeleton` 交付（walking skeleton：饮料 + 每100ml + /parse）。
> eval 回归基线由 OpenSpec change `add-eval-harness` 交付：真实山姆 HAR 440 商品的 tier1 离线基线，存于 `packages/eval/baseline.json`，`eval score --baseline` 可做回归门禁。「最小客户端」一项仍待落地，eval 先承担解析准确率的离线度量。
> OpenSpec change `tier1-real-data-fixes` 已交付（单件推断 + count-before-size）：同一 440 商品语料上，数量召回由 ~21% 提升到 ~65%、可算率由 ~19% 提升到 ~63%，数量精度（对 `samPkgNum`）由 96% 升到 ~98%（无回退）；基线已刷新为新值。

## Phase 2 — 山姆商品页插件
只做饮料；不做全站爬、不做复杂促销。

- [ ] `apps/extension`（WXT + MV3）骨架
- [ ] 山姆 StorePlugin（matchUrl / extractProduct）
- [ ] 浮层 UI（真实单价 + 可信度 + 反套路提示）
- [ ] 人工纠错入口

## Phase 3 — 中心商品库 + 众包榜单 + 小程序
- [x] Cloudflare D1（SQLite）+ Drizzle 落库（product_raw / product / unit_price / corrections；comparison_group 改动态查询、不建表）
- [ ] `POST /contribute`、`GET /rankings`、`POST /corrections`
- [ ] 公众 API 治理（API key + 限频 + 用量统计）
- [ ] `apps/miniapp`（Taro）：榜单浏览 + 手动/扫码录入

> 落库部分由 OpenSpec change `add-database` 交付：`packages/db`（`@unit-price/db`）—— Cloudflare D1（SQLite）+ Drizzle，schema 用 SQLite↔Postgres 可移植类型；表为 product_raw / product / unit_price / corrections（comparison_group 不物化，对比组改动态查询）；HTTP ingest / 部署归 `public-deploy`，品类标签归 `category-tagging`。

## Phase 4 — 多商店 + Surge 模块 + 复杂品类
- [ ] StorePlugin 扩展：Costco / 盒马 / 京东
- [ ] `apps/surge` MITM 模块（个人使用层）
- [ ] CategoryPlugin 扩展：纸品 / 洗护 / 肉类 / 宠物食品
- [ ] 促销分层（直接价 / 件数促销 / 满减均摊 + confidence）
