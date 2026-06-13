## 修改需求

### 需求:本能力不含读出与对比

`contribute-ingest`（写入路径能力）**仅做写入路径**。`/contribute`/`/ingest`/`/ingest/batch` 等写入端点**禁止**内联实现榜单读出、`/corrections`(人工纠错)、`/compare`(多商品对比)或任何 core `comparability` 能力——读出/对比不由写入路径承载。其中 `/rankings`(榜单读出)已由变更 `add-rankings-endpoint`（能力 `rankings-api`）作为**独立只读端点**提供：它不属写入路径、不由本能力实现，与本需求「写入端点不内联读出」并不冲突。`/corrections`/`/compare` 仍**不存在**，留给后续变更，待需求明确后再做。`product_raw`/`product`/`unit_price` 之外、由本能力**禁止**新建表或品类结构（榜单只读查询不新建表，见 `persistence` 的 `listRankings` 契约）。

#### 场景:写入端点不内联读出/对比，/rankings 由独立只读端点承载

- **当** 应用本变更后检查 `apps/api` 路由
- **那么** `apps/api` 路由的**完整集合**为 `{/health, /parse, /contribute, /ingest, /ingest/batch, /rankings}`：其中 `/contribute`/`/ingest`/`/ingest/batch` 为写入路径端点、**本身不内联**榜单读出/对比，`/rankings` 为**独立只读端点**（由 `rankings-api` 提供、公开只读、治理豁免），`/health`/`/parse` 为探活/解析端点；**不存在** `/corrections`/`/compare` 或任何其它读出/对比端点
