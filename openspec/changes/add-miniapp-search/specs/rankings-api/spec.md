## 新增需求

### 需求:GET /rankings 支持按商品名子串搜索（q 参数）

`GET /rankings` **必须**支持可选 `q` 查询参数，对结果按 `product_raw.title` 做**确定性子串过滤**，叠加在既有 `category` cohort 闭包过滤、`rankable=1`、`per100ml` 非空之上，排序口径不变（按 `per100ml` 升序）。`q` 是纯增量关注点：**缺省 / 空串 / 纯空白**时行为与查询计划与现状**完全一致**（不构造任何 `LIKE` 子句、不漂移既有 EXPLAIN 查询计划契约）。本需求**只新增 `q`**；`limit`/`offset`/`category` 的边界与 cohort 守卫口径见既有「分页与查询参数边界」需求，不在此重述。

**长度按 Unicode 码点计**：全部长度判定与截断**必须**用码点（`[...s]` / `Array.from(s)`），**禁止**用 UTF-16 `string.length`——否则星空段字符（emoji / 罕用 CJK 如 `𠮷`）误判长度、且按 UTF-16 截断会劈裂代理对、向 `LIKE` 注入孤代理。下限拒绝（`1→400`）与上限截断（`>64→截断`）**刻意不对称**：下限拒绝以教育用户「太宽」，上限宽容截断以不惊扰长查询。

- `q` 缺省或 `trim` 后长度为 `0`（空串 / 纯空白）→ 视作未传、**不**附加任何 title 过滤（等价于现有无 `q` 行为）。
- `q` `trim` 后长度为 `1`（码点）→ `400 invalid-request`：单字过宽（如「水」「茶」「奶」会一次性多命中、退化成近似全表），与端点既有「非法参数返回确定 400」一致。
- `q` `trim` 后长度 `≥ 2`（码点）→ **顺序固定 `trim → 按码点截断到 ≤ 64 → 转义`**（长度门与截断作用于**转义前的用户词**；若先转义再截断，`!!` 这类转义对会被截断劈裂、`ESCAPE` 失效）。截断用 `[...s].slice(0, 64).join('')`、不劈裂代理对；再在 SQL 内对 `product_raw.title` 施加 **ASCII 大小写不敏感**子串匹配（SQLite `LIKE` 默认仅 ASCII 折叠——非 ASCII 拉丁带变音 / CJK 全角等**不**归一，见非目标）：
  - **必须**显式带 `ESCAPE` 子句并先转义 `LIKE` 特殊字符。SQLite `LIKE` **无默认转义符**，仅在输入里插转义符不生效——**必须**生成 `... LIKE ? ESCAPE '<c>'`（如 `ESCAPE '!'`），并在 TS 侧把用户输入的 `<c>` / `%` / `_` 各前置 `<c>` 转义（转义符**必须**先转义自己），使这三类字符按字面匹配、**禁止**被当作通配符（防止 `_` 误配任意单字、`%` 误配全部）。**禁止**依赖 ORM `like()` helper 的转义选项（drizzle `like(col, val)` 仅两参、无 escape，必须落到 `sql` 原生模板）。
- `q` 与 `limit`/`offset`/`category` **正交叠加**：先按 cohort 闭包定界，再按 title 子串过滤，最后分页；`category` 的 cohort 守卫（跨 cohort 节点 `400`）、`limit`/`offset` 边界（非法 `400`、越界 `200` 空数组）口径**全部不变**。
- 子串**零命中** → `200` + 空数组（**不是** `404`）。
- 字面 `+`：`encodeURIComponent` 把 `+` 编为 `%2B`、服务端 `decodeURIComponent` 还原为字面 `+`（**非** form 解码的 `+`→空格），故 `100+200` 按字面匹配；两端都用 encode/decodeURIComponent 是此前提。
- 重复键 `?q=可乐&q=雪碧` → 取**首值** `可乐`（Hono `c.req.query()` 语义；取首值后再按上述长度门校验——若首值码点 `< 2` 仍 `400`），无歧义。
- 响应体仍是 `RankingsResponseSchema`（`RankingsItem[]`），**不新增**字段、**不新增**端点。
- **缓存按校验后的 `q` 判定，搜索响应发显式 `Cache-Control: no-store`**：`q` **校验后非 `undefined`**（trim 后码点 ≥ 2、真正在过滤）的响应**必须**带 `Cache-Control: no-store`——仅「不发 `public`」**不够**（Aliyun CDN 会按默认 TTL 自缓存），**必须**主动 `no-store`。`q` 校验后为 `undefined`（缺省 / `?q=` / `?q=%20%20`，等价无过滤）的响应与无-`q` cohort board 一样**仍走**既有 `public Cache-Control`。**禁止**按原始 URL 是否含 `q` 键判定（否则 `?q=%20%20` 会被误判为搜索而漏缓存）。理由：搜索长尾、各 `q` 几乎不复用，按 URL 分键近乎零命中却无界填充 CDN，且 CDN 按原始未截断 URL 分键、与服务端 64 码点截断口径不一致。

#### 场景:q 缺省时行为与查询计划不变

- **当** 客户端 `GET /rankings`（无 `q`，或 `q=` 空串、`q=%20` 纯空白，trim 后长度 0）
- **那么** **禁止**构造任何 title `LIKE` 子句，返回与现状完全一致的 cohort 榜；既有 EXPLAIN 查询计划契约**不漂移**

#### 场景:单字 q 过短返回 400

- **当** 客户端 `?q=水`（trim 后长度 1 码点）
- **那么** `400 invalid-request`（过宽、与 `limit=0` 同属确定性非法参数）；trim 后长度 0 的 `?q=` 则不在此列（视作未传、不过滤）

#### 场景:q 非空时按 title 子串过滤、排序与分页口径不变

- **当** 客户端 `GET /rankings?q=可乐`（默认 cohort `soft-drink`）
- **那么** `200` + 仅含 `title` 含「可乐」子串的软饮行，仍按 `per100ml` 升序、仍受 `limit`/`offset` 分页约束
- **当** 客户端 `?q=可乐&category=alcohol`（跨 cohort 父节点）
- **那么** `400 invalid-request`（cohort 守卫先于 title 过滤，口径不变）

#### 场景:LIKE 通配符与转义符按字面转义、零命中返回空数组

- **当** 客户端 `?q=100%水`（含 `%`，≥2 码点）/ `?q=a_b`（含 `_`）/ `?q=a!b`（含转义符 `!`，`ESCAPE '!'` 下按字面）/ `?q=100+200`（含 `+`）
- **那么** `%`/`_`/转义符/`+` **必须**按字面匹配（经 `ESCAPE` 子句 + 前置转义 + `encodeURIComponent`），**禁止**作通配符；title 无字面匹配则 `200` + 空数组（非 `404`）

#### 场景:超 64 码点截断、星空段字符按码点计

- **当** 客户端 `?q=<70 码点>` / `?q=<含 emoji 等代理对的串>`
- **那么** 按**码点**截断到 64（`[...s]`，不劈裂代理对）后再匹配；长度判定全程按码点，**禁止** UTF-16 `length` 误判

#### 场景:有效 q 发 no-store、空 q 仍走 edge cache

- **当** 客户端 `GET /rankings?q=可乐`（校验后非 `undefined`，命中或零命中）
- **那么** 响应**必须**带 `Cache-Control: no-store`（不只是省略 `public`）
- **当** 客户端 `GET /rankings?q=`/`?q=%20%20`（校验后 `undefined`）或无 `q`
- **那么** 响应**必须**与无-`q` cohort board 一样带既有 `public Cache-Control`（**禁止**因 URL 含 `q` 键而误判 `no-store`）
