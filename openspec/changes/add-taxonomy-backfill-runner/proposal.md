## 为什么

P2 `add-taxonomy-v1` 已合并归档:生产已有四张表 + 品类树/属性/山姆映射/闭包种子(migrate `0003`/`0004` 自动应用),打标签管线 `runBackfill`/`listProductsForBackfill`/`tagProduct` 也已实现并配单测。但这些函数在 `apps/api/src/index.ts` 仅被 **re-export**,`routes.ts` 没有任何路由驱动它们——生产从未真正跑过一次全量 backfill。后果:prod 现有 ~445 个 `product` 的 `product_tag` 为空、品类归属全是「待人工」、`rankable` 未重算。category-tagging 主 spec 早已要求「现有库存必须 backfill 打标签」,但这条要求在生产里**没有可触发的入口**而落空。

这是 P3「品类树榜 API + 分类 Tab」的**硬前置**:P3 的 `GET /categories` 与按品类节点取榜读的就是 tag 数据,不先把存量打标签,P3 在 prod 上是空 cohort。本变更补上这道缺失的运行闸,不改 backfill 业务逻辑本身。

## 变更内容

- 新增一个**独立 admin 鉴权层保护的运维端点** `POST /admin/backfill`,在 Worker 内驱动既有 `runBackfill`,对生产存量商品打标签 + 补 `category_closure` 命中(靠叶 attach、不写 closure 行)+ 重算 `rankable`。
- **鉴权用独立 admin 白名单 `ADMIN_API_KEYS`(与公共 `API_KEYS` 分离),不复用众包 ingest 凭据**:写全目录 derived 数据的 admin 能力不应授予每一枚众包 key。`/admin/*` 属于公共受保护集合(`{/parse,/contribute,/ingest,/ingest/batch}`)**之外**的独立 tier;公共集合枚举与 `/rankings` 豁免不受影响。**fail-closed**:`ADMIN_API_KEYS` 未配置/空 → `500 config-error`(复用空 allowlist 分支、**按 admin 源判定**),**禁止** fail-open;config-error 响应体对客户端泛化、secret 名仅入服务端日志。admin gate **共用**既有 `extractKey`/三态映射/config-error 分支(把 `parseAllowlist` 的 allowlist 源参数化、**封装式共享**头解析——保持私有、**不裸 export**),**禁止**重写头解析(防 `Authorization` 回退绕过);admin gate 是**专用 authenticate-only 中间件、不复用 `governanceMiddleware`**(不跑 rate/usage)。
- 端点**确定性全序游标分块**:用稳定主键 `product.id` 作 keyset 游标(`WHERE id > :cursor ORDER BY id LIMIT :n`,文本排序),返回严格前进的 `nextCursor`;**禁止**用「无 ORDER BY 全量重读 + 位置 offset 切片」(跨独立 HTTP 调用行序不稳→静默漏标 + 假完成)。`nextCursor=null`(本次读到的行 < limit、游标耗尽)才表示存量已全部覆盖(存量为 limit 整数倍时末尾多一次 0 行空读)。
- 端点对 `limit` 做**严格校验 + 上界 clamp + 缺省注入**:`limit` 正整数(`>=1`,拒 `0`/负/非整数,仿 `RankingsQuerySchema`),clamp 到服务端**子请求安全上界**(按 Worker **free-plan 50 子请求/请求**上限 + 每商品实测子请求数派生,公式 `1+limit×最坏≤50`,初定默认/上界 5;确认 PAID/1000 后方可调高、显式标注);**调用方省略 `limit` 时注入服务端默认、恒走分块**——**禁止**把无参全量单次扫暴露为 HTTP 行为(无参全量仅为库函数/单测契约,否则一次扫全表 ~445× 子请求必炸子请求上限、绕过护栏)。
- 端点**幂等**:沿用 `runBackfill` 既有幂等语义(同快照重跑结果一致、规则改判单归属收敛、单商品三态写原语级原子)。游标分块下任意区间可安全重跑。
- 端点**无 LLM、纯确定性、写集封闭**:只组合 core tier1 规则 + `rankable` 重算,**禁止** tier2 LLM、**禁止**任何出站 fetch;直接写集 = `product_tag`(category 叶 **+ attribute 正交边**,沿用 P2「品类归属与属性标签」契约)+ `product.{pending_category_tag_id, rankable}`(不触原始 raw / 价格 / `product.category`;`category_closure` 种子期物化在 tag 轴、靠叶 attach 间接命中、不写其行);`store-map` 本期惰性(`nativeCategoryId=null`),tier1 关键词为唯一活跃分类路径。
- 端点**审计留痕**:每次**经放行**的调用输出一条结构化日志(key 标识**仅** keyed 哈希〔HMAC/部署 salt〕、无明文/无前缀子串 + 游标 + limit + 计数 + 时间),供事后归因大规模改判;鉴权失败由 gate 层短路、不进 handler(本期不为失败侧新增日志)。
- 响应**只回计数 + `nextCursor`**,不回传逐商品 `results[]`(避免响应体随存量无界膨胀、避免一次性导出全表映射)。
- admin tier 的容器控制 = `limit` clamp + 幂等有界写,**结构上不抵达**公共 60/60s 限频/用量门(admin gate 是专用 authenticate-only 中间件,不跑 rate/usage,故「不计公共限频」是不变量、非 flag;避免与有界 limit 放大的调用数自锁;该决策在 api-governance spec 显式落锚)。
- 为支持游标分块,`runBackfill` 增加**可选** `{ cursor?, limit? }` 参数(无参=全量单次扫**仅库/单测用**,保持现有两参签名与单测行为不变),返回值补 `nextCursor`。
- 端点定位为**可重复驱动的受控入口**(bootstrap 首轮 + ad-hoc 重标):运营每次 HAR 重抽 → ingest 新上架后,新「待人工」商品可再次驱动一次全新 sweep。**「ingest 后自动重标」的事件/调度化(Queues/Workflows/scheduled)为显式后续项,本期不把手动循环钉成终态架构。**

## 功能 (Capabilities)

### 新增功能
<!-- 无新增独立能力:backfill 语义已在 category-tagging 主 spec;本次补「可在生产驱动的受控入口」与一个独立 admin 治理 tier,均为既有能力的需求级扩展。 -->

### 修改功能
- `category-tagging`: 既有「现有库存必须 backfill 打标签」需求的入口措辞从「**必须走迁移 / 脚本**」放宽为「必须经一个受控入口落地(迁移 / 脚本 / 鉴权运维端点之一)」(MODIFIED,消除与新 route 入口的措辞冲突);并新增需求——存量 backfill 必须有可在生产驱动的受控入口(鉴权、**确定性全序游标分块 + 完整覆盖**、`limit` 有界、幂等、无 LLM、无出站、写集封闭、对 store-map 惰性)。
- `api-governance`: 新增需求——`POST /admin/backfill` 经**独立 admin 鉴权 tier**(`ADMIN_API_KEYS`)保护,鉴权前置遮蔽任何 backfill 写,失败不驱动 `runBackfill`,且输出审计日志;并立「每个 `/admin/*` 路由必须各自挂 admin gate」的不变量(Hono 精确路径匹配 footgun)。公共受保护集合 4 元枚举与 `/rankings` 豁免**不变**。

## 影响

- **代码**:`apps/api/src/routes.ts`(新增 `POST /admin/backfill` + admin gate 挂载 + `limit` 校验/clamp + 审计日志 + 响应投影掉 `results[]`)、`apps/api/src/tagging.ts`(`runBackfill` 改游标分块 + `nextCursor`,`listProductsForBackfill` 加 `ORDER BY id` + 游标/limit 下推)、`apps/api/src/governance.ts` 或新 `admin-auth`(admin 白名单鉴权)、`apps/api/src/bindings.ts`(加 `ADMIN_API_KEYS`)、`apps/api/wrangler.toml` 文档化新 secret、对应单测。
- **API**:新增一个 admin-tier 受保护端点;`/rankings` 与公共受保护端点行为不变。
- **数据/合规**:仅对**已落库**存量重算 derived 行(`product_tag` 含 category 叶 + attribute 边、`rankable`;`category_closure` 靠叶 attach 间接命中、不直接写其行),不抓取、不重放 ingest、不触 LLM、不出站;符合「按需计算 + 众包沉淀、不主动全站爬取」分层。store-map 仍惰性。
- **workspace 包**:仅 `apps/api`;`packages/core` 不动。
- **运维**:合并部署后由运营持一枚 `ADMIN_API_KEYS` 凭据,以脚本循环驱动到 `nextCursor=null`,完成生产存量首轮打标签;首轮计数记入运维 runbook(非实现验收门)。
