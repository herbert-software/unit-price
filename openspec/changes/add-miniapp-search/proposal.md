## 为什么

小程序顶部的搜索框 `SearchEntry` 是占位：点击只弹「敬请期待」，注释里把真搜索标为 P4。用户进来想查某个具体商品（「无糖可乐多少钱一百毫升」）时无路可走，只能逐级翻分类树。

而真搜索需要的数据**现在就在 prod**——~347 条 rankable 带名 SKU（主要软饮 per100ml）。这是一个用存量数据就能补的可见缺口，不依赖运营再抓 HAR。

## 变更内容

- GET `/rankings` 新增可选 `q` 查询参数：按 `product_raw.title` 子串过滤（ASCII 大小写不敏感，经 `ESCAPE` 子句转义 LIKE 通配符 `%`/`_`，长度按 Unicode 码点 trim 后下限 ≥ 2、上限 64 截断——下限避免单字常用字一次性多命中）。`q` 缺省时查询 SQL 完全不变，复用现有 cohort 守卫、`RankingsItem` 投影与 `RankingsResponseSchema`——不新增端点、不新增响应 schema。**有效 `q`（校验后非 `undefined`）的响应不走 edge cache**（搜索长尾、各 `q` 不复用），edge cache 仍留给无-`q`（含空 `?q=`、解析为 `undefined`）的 cohort board。
- 小程序 `SearchEntry` 从占位变为真输入（Taro `Input`）：confirm 后 `navigateTo` 复用现有 board 列表页（`board?q=<encodeURIComponent>…`），把 `q` 线程进 `useRankings`/`buildRankingsUrl`。无新页面。

### 非目标（本次不做）

- **跨 cohort / 混合单位同列**：v1 只在单一 cohort（默认 `soft-drink`，per100ml）内搜索并按 per100ml 升序。把 per100ml 与 per100g、每100抽 等不同单位的商品放进同一列表需要 per-item 单位标签，属 v2。
- **相关性排序 / 模糊 / 拼音 / 分词搜索**：v1 是确定性子串 `LIKE`，排序沿用 per100ml 升序。
- **跨 store**：沿用现有数据面（山姆），不新增抓取，不触碰合规敏感面。
- **搜索历史 / 联想 / 热词**：不做。

## 功能 (Capabilities)

### 新增功能

（无新能力——复用既有读路径与列表页。）

### 修改功能

- `rankings-api`: GET `/rankings` 新增可选 `q` 子串过滤参数的口径（校验、`ESCAPE` 转义、查询计划在 `q` 缺省时不漂移、`q` present 不走 edge cache）。
- `miniapp`: 搜索入口从「占位 + 敬请期待 toast」改为真输入，复用 board 列表页呈现单 cohort 搜索结果。

## 影响

- `apps/api`：`RankingsQuerySchema` 增 `q`；`buildRankingsQuery` WHERE 条件分支增 `LIKE`。
- `packages/db`：`ListRankingsInput` 增 `q`；`buildRankingsQuery`/`listRankings` 透传。
- `packages/api-client`：`buildRankingsUrl` 序列化 `q`（响应 schema 不变）。
- `apps/miniapp`：`SearchEntry` 真输入化；`useRankings`/board 透传 `q`。
- 合规敏感面：不触碰（无新抓取/众包，纯读现有数据）。
