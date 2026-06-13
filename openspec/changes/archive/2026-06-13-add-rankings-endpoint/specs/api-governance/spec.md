## 新增需求

### 需求:GET /rankings 为受保护集合之外的公开只读端点

`GET /rankings` 必须被归类为**受保护端点集合 `{/parse, /contribute, /ingest, /ingest/batch}` 之外**的公开只读端点，**豁免整条治理链**（鉴权、限频、用量），语义与 `/health` 的豁免同性质：无需 API key 即可访问，不消耗限频计数，不记用量。

该归类**不改变**受保护端点集合的既有治理行为——`{/parse, /contribute, /ingest, /ingest/batch}` 仍各自要求合法 API key、按 key 限频与计量，行为不变。豁免理由：`/rankings` 是只读端点，**禁止**写入、**禁止**调用 LLM、**禁止**触发后台任务，纯读已沉淀的公开众包数据，无写滥用与 LLM 成本面，强制鉴权只增摩擦而无防护收益。

> 备注：本期 `/rankings` 不挂任何限频闸。若未来实测出现读滥用，可另行引入「集外端点的可选宽松限频」，但不在本变更范围。

#### 场景:GET /rankings 不带 key 时放行

- **当** 客户端 `GET /rankings` 不携带任何鉴权头
- **那么** 接口必须返回 `200`（按 rankings-api 既有语义），**禁止**返回 `401 auth-missing` 或 `403 auth-forbidden`，**禁止**在 `GOVERNANCE_KV` 写任何限频/用量计数

#### 场景:/rankings 豁免不影响受保护端点

- **当** 客户端在 `GET /rankings` 公开放行的同时，向 `/parse`、`/contribute`、`/ingest` 或 `/ingest/batch` 发起缺 key 请求
- **那么** 这些受保护端点必须仍按既有治理语义返回 `401 auth-missing`，不得因 `/rankings` 的豁免而被一并放行
