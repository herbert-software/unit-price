## 上下文

搜索是「用现有数据补可见缺口」：prod 已有 ~347 条 rankable 带名 SKU，但 `SearchEntry` 是占位（点击 toast）。读路径 `GET /rankings` 已经具备搜索所需的一切——cohort 闭包过滤、`per100ml` 升序、`RankingsItem` 投影、edge cache、fail-closed 响应校验。board 列表页也已经「就是一个列表」（复用榜单首页的三态 / 分页 / page-error）。因此最懒且正确的做法是**给读路径加一个正交的 title 过滤**，复用其余全部，而不是另起搜索端点 / 搜索页 / 搜索 schema。

## 目标 / 非目标

**目标：**
- `GET /rankings` 加可选 `q`，按 `product_raw.title` 子串过滤，叠加在既有 cohort/分页之上，排序口径不变。
- `q` 缺省时 SQL 与查询计划**零变化**（不漂移既有 EXPLAIN 测试）。
- 小程序搜索入口真输入化，confirm 跳 board 复用列表。

**非目标：**
- 跨 cohort / 混合单位（per100g、每100抽）同列——需 per-item 单位标签，属 v2。
- 相关性 / 模糊 / 拼音 / 分词搜索、搜索历史 / 联想 / 热词。
- 新增端点、新增响应 schema、新增页面。

## 决策

**D1：复用 `/rankings` 加 `q`，不新建 `/search`。**
搜索结果与榜单是同一形状（`RankingsItem[]`，per100ml 升序）。新端点要复制投影、cohort 守卫、缓存、schema 校验四套逻辑。加一个正交查询参数零复制。
- 备选：独立 `/search` 端点 + 自定义结果 schema（携带 per-item 单位、跨 cohort）。否决：那是 v2 的形状，本期数据与 UI 都不需要，YAGNI。

**D2：`q` 走 SQL `LIKE`，不引全文索引 / FTS5。**
~347 行、单 store、子串匹配。D1 的 `LIKE %q%` 在这个量级是即时的。引 FTS5 虚拟表 / 分词器是为不存在的规模付复杂度。
- 转义必须落到 `sql` 原生模板 + 显式 `ESCAPE` 子句：SQLite `LIKE` **无默认转义符**，且 drizzle 的 `like(col, val)` 仅两参、**无 escape 选项**（已核 drizzle-orm 0.45.2 源码）。所以仅在输入里插 `\` 不生效——必须 `` sql`${productRaw.title} LIKE ${pattern} ESCAPE '!'` ``，`pattern` 在 TS 侧把用户输入的 `!`/`%`/`_` 各前置 `!`（转义符先转义自己）。否则 `q=100%` 误配全部、`q=a_b` 误配任意单字——这是正确性，不是优化。选 `!` 作转义符（避免 JS 字符串里 `\\` 的双重转义混淆）。
- 长度边界**全按 Unicode 码点**（`[...s]` / `Array.from`，**非** UTF-16 `length`）：UTF-16 会把 emoji / 罕用 CJK（`𠮷`）算 2，误触 `400` 或误截断，且 `.slice` 会劈裂代理对、向 `LIKE` 注入孤代理。`trim` 后**上限 64 按码点截断**（`[...s].slice(0,64).join('')`）；**下限 ≥ 2 码点**——单字 CJK 常用字（「水」「茶」「奶」）会一次性多命中、退化成「几乎全表」，对用户无意义。下限不满足（trim 后长度 1）→ `400 invalid-request`（与端点既有「非法参数确定 400」一致）；trim 后长度 0（空/纯空白）→ 视作未传、不过滤。端上同样先按码点校验下限+截断上限、给行内提示而不发请求，省一次往返、且 URL/标题/实际过滤词一致。

**D2.1：下限与「空=不过滤」如何相容 + 确切的 Zod 管线（避免 refine 误触空分支）。**
`q` 缺省或 trim→空（长度 0）= 无搜索意图 → 不加过滤（沿用现状）；trim 后长度 1 = 有意图但过宽 → `400`；长度 ≥ 2 → 过滤。这个不连续是刻意的：空不是「搜了个空」，单字是「搜了但太宽」，两者该有不同的确定结果。
- 坑：若把 `.refine(len ≥ 2)` 放在 `'' → undefined` 之前，它会对空串报 `400`，违反「空=不过滤」。**必须**先把空折成 `undefined`、再让校验只作用于「present」分支。确切形：
  ```ts
  // 注意：现有 RankingsQuerySchema 是 z.object（非 .strict），q 纯增量、无冲突
  q: z.string()
    .transform((s) => s.trim())
    .transform((s) => (s === '' ? undefined : s))      // 空/纯空白 → undefined（不过滤）
    .refine((s) => s === undefined || [...s].length >= 2, // 仅对 present 校下限
      { message: 'q too short' })                         // 失败 → 路由层 400 invalid-request
    .transform((s) => (s === undefined ? undefined : [...s].slice(0, 64).join(''))) // 按码点截断
    .optional(),
  ```
  （`String.prototype.trim()` 按 ECMAScript 同时剥离半角与全角空格 `　`，client/server 同引擎语义、口径一致。）
- ceiling：`LIKE %q%` 无法走索引（全扫闭包结果集）。当前规模无所谓；若某 cohort 涨到万级再考虑 FTS5。

**D3：`q` 折进既有 `and(...)`，不加第二个 `.where()`；`buildRankableCountQuery` 保持 q-纯。**
关键机制坑（三方 review 一致命中）：① drizzle 的 `.where()` 是**覆盖**（`config.where = where`），第二个 `.where(like(...))` 会**抹掉** `applyNodeRankingFilter` 里的 cohort/rankable/per100ml 守卫 → 返回跨 cohort、非 rankable 行。② `applyNodeRankingFilter` 被 board（`buildRankingsQuery`）和**计数**（`buildRankableCountQuery`，喂 `/categories` 树的 `rankableCount`）**共用**——若把 title 子句加进共用 fragment，会连带改了树计数，违反「tree N == board N」。
- 正解：给 `applyNodeRankingFilter` 加一个**可选 extra-condition 参数**，折进它那唯一的 `and(<现有谓词>, extra)`。`buildRankingsQuery` 在 `q` 非空时传入 title-LIKE 谓词；`buildRankableCountQuery` **永远传 `undefined`**。drizzle 的 `and()` 丢弃 `undefined` 实参 → 计数 SQL 与无-`q` board SQL **逐字节不变**，既有 EXPLAIN 测试不动。
- `q` 缺省时（谓词为 `undefined`）不构造任何 `LIKE`，保护既有查询计划契约——做成结构性保证而非靠测试守。但 `q` 非空的计划是**新**路径：须补一条 `q`-present 的 EXPLAIN 断言（`category_closure`/`unit_price` 仍走唯一索引探测；`product_raw` 上多一个 SCAN 可接受、不断言）。

**D4：小程序复用 board 列表页，搜索不新建页。**
board 已经 `useRankings(category)` → `buildRankingsUrl` → 三态/分页。搜索只需把 `q` 线程进 `BoardParams` / `useRankings` / `buildRankingsUrl`，`SearchEntry` 从「tap→toast」改成「Taro `Input` + confirm→`navigateTo(board?q=…)`」。board 默认 `category` 缺省 → API 默认 `soft-drink` cohort，正好对上搜索框「搜软饮名」的既定话术。导航方式与既有「分类树下钻 board」**完全一致**（`navigateTo` 单层 push、board 是叶子无再下钻、back 回上一页）；搜索入口**仅**在首页 Tab、board 上**无**搜索入口，故页栈深度同既有下钻（≤2~3），不引入新的 10 层栈风险。
- 备选：独立搜索页。否决：board 已是「纯列表」，复制一遍是纯重复。

**D4.1：`q` 路由透传必须确定性解码（不能复用 `name` 的 try-decode-catch-raw 兜底）。**
现有 `readBoardParams` 对 `name` 用「decode-once-with-raw-fallback」，其注释明说只对**固定 CJK 品类名（无 `%`/`+`）**成立。`q` 是自由文本，可含字面 `%NN`（如用户输入 `100%20纯`/`a%20b`）：源端 `encodeURIComponent` 后，若 WeChat `onLoad` 再解码一次、`readBoardParams` 又解码一次 → 双解码把 `%20` 误折成空格、**静默改写** `q`，且兜底只在 `decodeURIComponent` **抛错**时触发、对「成功但解错」无效。
- **两段独立 round-trip，别混为一谈**：(a) 端内路由 `SearchEntry --navigateTo--> board 路由参数`；(b) 网络 URL `board --buildRankingsUrl(encodeURIComponent)--> Hono(_decodeURI 一次) 服务端`。本不变量**只约束 (a)**；(b) 是既有 `buildRankingsUrl` + Hono 的干净「1 编 1 解」、**本期不动**、已验证正确。实现者别把 (b) 当 (a) 去「修」，也别以为 (a) 的编码会原样到服务端（board 先解码再经 (b) 重新编码）。
- 不变量(a)：**端到端解码次数恰好 `1`**（源端编码一次 → 正好一次解码还原）。`0` 次留编码态、`2` 次把 `%20` 误折成空格。实测 Taro 该版本 `onLoad` 是否已解码：已解（=1）→ `readBoardParams` 对 `q` 不再解码；未解（=0）→ 解码一次。不用 try-catch 兜底（对「成功但解错」无效）。
- 只带 `q`、不带 `name`：board 标题在端侧据**解码后非空**的 `q` 派生（优先级 `decodedQ.trim() ? 搜索：decodedQ : (name ?? 分类榜)`；判据是**解码后词非空**、**非** `q` 键是否存在——否则 `?q=` 会出「搜索：」空标题）。这样**只有一个**自由文本参数走不变量(a) 的确定性解码；`name` 仍只服务分类下钻（固定 CJK、无 `%`/`+`），沿用既有兜底——即便 `onLoad`=1 世界里 `name` 被二次解码，固定 CJK 的幂等性使其**无害**（此豁免与同一次实测挂钩，不是另立一套）。
- 验收：`'100%20纯'` / `'a%20b'`（字面有效转义）+ `'100%'`（不完整转义）逐字节往返不变。解码层是纯 JS（`decodeURIComponent`/Taro router、非原生桥），devtools 与真机理应一致；但本项目有过 devtools/真机 分歧史（见 `[[taro-weapp-modern-syntax-transpile]]` 假 timeout），故验收**含真机**往返校验（tasks 5.3）。
- ponytail：选「实测平台行为(确定量) + 确定性解码 + 真机复核」而非引入 base64 编码层。`// ponytail: 依赖 Taro onLoad 解码次数(实测钉死)；若真机证实不稳，升级为 base64url 这类 %-free 传输（次数无关）` —— 命名了上升路径，不为近乎不可能的输入预造编码层。

## 风险 / 权衡

- **`q` + `category` 同传时语义**：搜索默认不带 `category`（走 API 默认 `soft-drink`）；若未来在某 cohort 内搜索，`q` 与 `category` 正交叠加即可，无需改动。当前 UI 不暴露「在某分类内搜」，零风险。
- **缓存污染**：`?q=<任意子串>` 缓存键空间实际无界（任意子串 = 一个新键），且 CDN 按**原始未截断 URL** 分键、与服务端 64 码点截断口径不一致 → 无界冷未命中放大、缓存近乎零命中却被填满。→ 缓解（已采纳，且更懒）：**搜索响应不走 edge cache，发显式 `Cache-Control: no-store`**——注意仅「不发 `public`」**不够**（Aliyun CDN 会按默认 TTL 自缓存），必须主动 `no-store`。缓存判定按**校验后的 `q`**：`q` 解析为 `undefined`（缺省 / `?q=` / `?q=%20%20`）的响应与无-`q` cohort board 等价、**仍走** `PUBLIC_CACHE_CONTROL`；只有 `q` 校验后非 `undefined`（码点 ≥ 2）才 `no-store`。**禁止**按原始 URL 是否含 `q` 键判定。去掉「按 q 分键」这套设想，反而更简单。残余：`/rankings`、`/rankings?q=`、`/rankings?q=%20%20` 是 3 个不同的 CDN 键却服务同一 public 体（轻度碎片、3× 冷未命中同一榜），属有界小事、不值得做 canonical 重定向。
- **CJK 大小写 / 规范化**：`LIKE` 默认仅 **ASCII** 大小写折叠（`CAFÉ` 不配 `café`，已实测）；CJK 无大小写问题，按字节匹配即可。全角/半角、繁简、非 ASCII 拉丁变音归一不做（v2）。→ 缓解：spec 文案写「ASCII 大小写不敏感」、非目标已划出，避免实现者误期望 Unicode 折叠。
- **空/纯空白 `q`**：端上 `trim` 后为空不发请求；服务端 `trim` 后为空也不加过滤——双端 fail-safe，避免 `?q=` 退化成「无过滤全表」被误读成搜索失败。
