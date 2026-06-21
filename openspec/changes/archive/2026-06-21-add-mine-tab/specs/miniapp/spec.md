## 修改需求

### 需求:miniapp 必须是消费 /rankings 的只读榜单小程序骨架

`apps/miniapp`(`@unit-price/miniapp`)**必须**是一个 Taro(React + TS)微信小程序工程,定位为**浏览优先**:采用 **3 个底部 Tab**——**榜单(首页)/ 分类 / 我的**,其中**榜单为首页 Tab**、承载真实单价榜浏览。`navigationBarTitleText` **必须**为 `会员商店值不值`。

整体以**只读浏览**为主:**禁止**扫码 / 拍照路径、**禁止**贡献 / 纠错 / 写库入口,**禁止**在端上跑 tier1 解析或单价计算(浏览只读已算好的 `/rankings` / `/categories` 派生数据)。顶部搜索入口为**真输入**:用户输入商品名后跳转复用 board 列表页、发起**只读** `GET /rankings?q=<词>`(语义同榜单、仍按已算好的 `per100ml` 升序),**仍不构成**贡献 / 纠错路径;`我的` Tab 为**只读工具 + 关于页**(见下):提供即时比价常驻入口(`navigateTo` 到比价表单页)、端上**本地**比价历史(`Taro` storage 读写)、静态数据来源说明与原生意见反馈——`我的` **自身仍不发起任何网络请求**(比价请求发生在比价表单页、历史读写为端上存储),且**仍禁止**扫码 / 拍照 / 贡献 / 纠错 / 写库入口;`分类` Tab **仅**发起**只读** `GET /categories`(整树浏览),其下钻的 category-scoped 榜**仅**发起**只读** `GET /rankings?category=<slug>`。**唯一的写形请求**是即时比价:`榜单` 首页提供比价入口(见下),进入的**比价表单页**发起**无状态** `POST /compute`(服务端确定性算单价 + 在所选 cohort 内定位、**不写库**、**无 AI**),其结构化输入仅作**一次性比价**、**不构成**录入到库 / 贡献 / 纠错,且计算在**服务端**(端上**不**跑 core)。榜单/搜索/下钻榜数据**必须**通过 `@unit-price/api-client`(`buildRankingsUrl` + `parseRankingsResponse`)消费 `GET /rankings`、即时比价**必须**通过 `buildComputeUrl` + `parseComputeResponse` 消费 `POST /compute`,网络层用 `Taro.request`(api-client 传输无关,发请求在本端)。

**构建集成**:`apps/miniapp` 是 pnpm workspace 成员(deps 走 `workspace:*`),但**必须不进**根 `tsconfig.json` 的 `tsc -b` references——由 `@tarojs/cli` 自管构建,消费 `@unit-price/api-client` 的**预构建 dist**。api-client/core **必须**先于 Taro 打包构建(构建顺序)。

#### 场景:浏览只读、即时比价不在端上计算

- **当** 检查 `apps/miniapp` 源码
- **那么** **禁止**出现扫码 / 拍照入口、**禁止**出现贡献 / 纠错 / 写库入口,**禁止**引入 `packages/core` 的 tier1/calculator 做端上计算(比价表单的结构化输入经 `POST /compute` 在**服务端**算、端上**不**跑 core);榜单/搜索数据**必须**来自 `/rankings`(已算好的 per100ml)、品类树来自 `/categories`、即时比价来自 `/compute`

#### 场景:三个底部 Tab 且边界不变

- **当** 进入小程序
- **那么** **必须**有 3 个底部 Tab(榜单 / 分类 / 我的),榜单为首页;切换 Tab 不破坏边界——`我的` 为只读工具 + 关于页、**自身禁止**发起**任何**网络请求(其即时比价入口仅 `navigateTo`、比价历史为端上存储读写、关于区为静态文案 + 原生反馈),顶部搜索入口**仅**发起**只读** `GET /rankings?q=<词>`,`分类` Tab **仅**发起**只读** `GET /categories`、其下钻榜**仅**发起**只读** `GET /rankings?category=<slug>`;唯一写形请求是 `榜单` 首页比价入口进入的比价表单页发起的**无状态** `POST /compute`(即时比价、不写库、无 AI);全程**禁止**扫码 / 拍照 / 贡献 / 纠错 / 写库入口(比价表单的结构化输入是**一次性比价**、**非**录入到库)

#### 场景:经 api-client 消费 /rankings
- **当** 小程序请求榜单
- **那么** **必须**用 `@unit-price/api-client` 的 `buildRankingsUrl` 构造 URL、`Taro.request` 发请求、`parseRankingsResponse` 校验响应;**禁止**在 miniapp 内手写重复的响应类型或绕过校验

#### 场景:miniapp 不进根 tsc -b reference 图
- **当** 检查根 `tsconfig.json` 的 references
- **那么** **必须不含** `apps/miniapp`(Taro 自管构建);miniapp 消费 api-client 的预构建 dist,api-client/core 先于 Taro 打包构建

### 需求:榜单首页必须提供即时比价入口并承载结构化比价表单页

`榜单` 首页**必须**提供进入**即时比价**的入口,服务「在店遇到未收录商品、想当场知道它单价贵不贵 / 排哪」的场景。入口采用**搜索未命中为主、紧凑常驻为辅**两处,**禁止**在首页放抢占浏览视线的大块主 CTA:

- **主入口——搜索无结果态**:当商品名搜索返回**零结果**时,空态**必须**呈现比价 CTA(如「没搜到这件商品？」+ 按钮「输入规格,算它值不值」)→ 进入比价表单页。这是主路径,贴合「这件没收录」的真实触发点。
- **辅入口——搜索框旁紧凑常驻**:首页搜索行旁**必须**有一个**视觉次于搜索**的紧凑入口(文本链接 / 图标按钮,如「算单价」,**非**整行大按钮)→ 进入比价表单页,覆盖「搜索前就知道没收录」的用户。

**比价表单页**字段**必须**含:总价(元)、数量、**单件容量 或 总容量(二选一互斥)**、单位选择(`ml`/`L`/`g`/`kg`)、品类选择。品类选择**必须**从 `/categories` 树(或共享 `CategoryLeafSlugSchema`)派生 leaf cohort 列表,**禁止**在 miniapp 内硬编码品类清单(防漂移)。提交**必须**经 `@unit-price/api-client` 的 `buildComputeUrl` + `parseComputeResponse` 调**无状态** `POST /compute`,渲染结果卡片:用户单价(`per100ml`/`per100g`)+ 可展开的可回放 `formula` + 在该 cohort 的 `rank`/`total`/`percentile` + 最接近的若干同类品(可点进 board)。端上**必须**做轻量 UX 校验(总价/数量/容量为正、二选一互斥、按所选品类的可比单位轴约束可选单位)以**减少空跑**,但**权威校验在服务端**(信任边界);**空 / 非法输入禁止发起请求**。

比价**全程**:**禁止**扫码 / 拍照、**禁止**把结果写库 / 贡献 / 纠错、**禁止**引入 `packages/core` 做端上计算(计算在服务端 `/compute`)。`我的` Tab **另设**一个 `navigateTo` 到本比价表单页(`/pages/compute/index`)的入口(见「我的 Tab 必须提供比价工具区」需求);本工具的**表单仍只承载于本页**(`pages/compute`)、`我的` **不内嵌**表单。free-text 标题输入 + AI 解析为**非目标**(留待后续)。

#### 场景:搜索无结果态提供比价入口
- **当** 用户在榜单首页按商品名搜索且返回零结果
- **那么** 空态**必须**呈现比价 CTA(「没搜到这件商品？」+「输入规格,算它值不值」),点击进入比价表单页;**禁止**仅显示空白或纯「无结果」而不给出比价出路

#### 场景:搜索框旁有紧凑常驻入口
- **当** 用户在榜单首页(未搜索)
- **那么** 搜索行旁**必须**有一个**视觉次于搜索**的紧凑比价入口(链接 / 图标,非整行大按钮),点击进入比价表单页

#### 场景:结构化输入提交后得到单价与定位
- **当** 用户在比价表单页填入总价、数量、单件容量(或总容量)、单位、品类并提交(输入集足够、单位轴与品类一致)
- **那么** **必须**经 `buildComputeUrl`/`parseComputeResponse` 调 `POST /compute`,渲染单价 + 可展开 `formula` + 该 cohort 的 `rank`/`total` + **服务端返回的 `percentile`**(「比 X% 便宜」直接用服务端 `percentile`,**禁止**在端上用 rank/total 另算一个口径不同的百分比) + 最接近的同类品;**禁止**端上跑 core 计算、**禁止**写库
- **注**:`percentile` **始终为数值**(契约 `number`,`total=0` 时为 `0`,**永不** null/缺省),故客户端无需处理 null;裁决/位置点/百分比**全部由 `percentile` 单源派生**(口径一致、不会自相矛盾),空态(`total=0`)的中性渲染据 `total===0` 判定(见下「空 cohort」场景),不依赖 `percentile` 判空

#### 场景:服务端 400 文案必须呈现给用户
- **当** `POST /compute` 返回非 `200`(如跨轴不可比、未知品类、per_100g 不支持)
- **那么** 端上**必须**据 `res.statusCode` 分支、把响应体的 `message` 作为行内提示**呈现给用户**;**禁止**把所有非 200 都吞成一句泛化的「计算失败」(`parseComputeResponse` 仅用于 `200` 体;`Taro.request` 不会对 4xx 抛错,故必须显式判状态码)

#### 场景:空 cohort 或用户值越界的结果卡片不误导
- **当** 结果 `total===0`(该 cohort 暂无同类)
- **那么** 结果卡**必须**呈现中性「暂无同类可比」(**禁止**显示绿/红裁决或位置点,**禁止**出现「比 0% 便宜、偏贵」这类零样本却下结论的文案)
- **当** 结果 `rank > total`(用户比所有同类都贵)或 `rank===1`(最便宜)等边界
- **那么** 位置点**必须**clamp 在 `[0,1]` 轨道内、名次显示**必须**自洽(不得出现「第 6 / 共 5」或点跑出轨道)

#### 场景:空或非法输入不发起请求
- **当** 用户未填必填项、填了非正数、或单件容量与总容量都未填(输入集不足)即提交
- **那么** **禁止**发起任何网络请求,**必须**给行内轻提示指明缺哪项;比价**禁止**构成扫码 / 拍照 / 写库 / 贡献路径

#### 场景:单位选项按所选品类的可比单位轴约束
- **当** 用户在品类选择里选了一个 `per_100ml` cohort(如软饮)
- **那么** 单位选项**必须**约束为容量轴(`ml`/`L`)、并提示该品类按每 100ml 比价——与服务端跨轴不可比 `400` 守卫同口径,端上预约束以减少被拒往返
- **注**:本期 `toCohorts` **只派生 `per_100ml` cohort**(与服务端 per_100g→`400` 同口径),故 UI 本期不提供 `per_100g` 选项;待重量轴 backfill 解禁后,`per_100g` cohort 的单位选项再约束为 `g`/`kg`

#### 场景:经 api-client 消费 /compute、不手写类型
- **当** 比价表单页请求计算
- **那么** **必须**用 `@unit-price/api-client` 的 `buildComputeUrl` 构造 URL、`Taro.request` 发 `POST`、`parseComputeResponse` 校验响应;**禁止**在 miniapp 内手写重复的请求/响应类型或绕过校验

## 新增需求

### 需求:我的 Tab 必须提供比价工具区(即时比价入口 + 端上本地比价历史)

`我的` Tab **必须**含「比价工具区」,**禁止**任何录入到库 / 贡献 / 纠错语义,**禁止**为此引入登录 / 微信授权。

**即时比价常驻入口**:**必须**提供常驻入口,以 `Taro.navigateTo({ url: '/pages/compute/index' })`(**绝对路径 + `/index` + 对象形式**,与既有 `navigateTo` 约定一致)跳转到比价表单页。入口本身**禁止**发起网络请求(请求由比价表单页发起)。

**端上本地比价历史**(键 `compute:history`,值为 `Array<{ input: ComputeRequest; summary: string; ts: number }>`,`input` 复用 `@unit-price/api-client` 的 `ComputeRequestSchema`、`summary` 为写入时快照、`ts` 为 `Date.now()`;**禁手写重复类型**):

- **写**:比价表单页 `POST /compute` **成功**后**必须**写一条;写入**必须**先**去重**(剔除 `input` 相等的旧项,把"重算"视作移到最新)再以 `unshift` 置于**最新端**,并 `slice(0, 20)` 环形覆盖**最旧**(`N=20`、切尾、**禁止**无限增长);写入项 `ts` **必须单调唯一**——以**去重前**历史的最大 `ts`(`prevMaxTs`)计 `Math.min(Number.MAX_SAFE_INTEGER, Math.max(Date.now(), prevMaxTs + 1))`(去重后再算会在"剔除的恰是最新项"时失去单调;`Math.min` 封顶防被篡改的 `MAX_SAFE_INTEGER` 存储项令新 `ts` 溢出安全整数区),使其作回填 handle 与列表 key 恒不重复(同毫秒两次不同输入不撞);整个写入**禁止**额外网络请求,且**必须**包错误处理——`setStorage` 失败(配额满/不可用)**仅丢历史、禁止阻断比价结果展示**(不得谎报)。
- **读**:`我的` **必须**在**每次进入页面时**(`useDidShow`,非仅首次 `useLoad`)重读历史,使"比价一次后回到我的"能见到新项。读取**必须**健壮:① 顶层值**非数组**(未写过/损坏)→ 视作空、**禁止**对其 `.map`;② 对**每项**校验——包裹字段(`summary` 为字符串、`ts` 须 `Number.isSafeInteger(ts) && ts>0`)用朴素判断(**禁**为此在 miniapp 引入 `zod`/`z.object` 依赖),`input` 用 api-client 既有 `ComputeRequestSchema.safeParse(item.input, { jitless: true })`,**并校验完整必填集**(镜像服务端 `meetsComputeRequiredSet` 的 presence:`totalAmount != null || (unitSize != null && quantity != null)`——schema 只禁二者皆有、不禁皆无,且 `quantity` schema **可选**;"既无量字段"**或**"有 `unitSize` 却无 `quantity`"的退化项须在读端丢弃,免回填出 `unit=undefined` 或凭空补 `quantity`;端上不引 core,此为手写镜像、与服务端必填集同口径);任一不过 → **无效项静默丢弃**(覆盖缺字段 / `summary`·`ts` 非安全正整数 / 旧版 schema 残留 / 退化项);③ 过滤后**再按 `ts` 去重**(同 `ts` 仅留最先一项,防被篡改存储的重复 `ts` 致 `find`/key 歧义)。**禁止**因坏数据白屏或抛错。**`{ jitless: true }` 为硬约束**:weapp 禁 `eval`、Zod 默认 JIT(`new Function`)在 weapp 崩(同 `parseComputeResponse`),端上任何直接 `.parse/.safeParse` **必须**带 `jitless`。
- **列出与回填**:`我的` **必须**按时间倒序列出历史(存储已最新在前,直接渲染、无需再排序;每项含可读摘要 + 时间),读取**禁止**发起网络请求;点击一项**必须** `Taro.navigateTo({ url: \`/pages/compute/index?h=${ts}\` })`(handle 用项的**稳定 `ts`**、**非数组索引**——索引对可变环形表会错指/错位;`ts` 由写端单调保证唯一),比价表单页据 `h` **回填**并可重算:`Number(h)` 解析 + **正整数**校验(`Number.isInteger(n) && n>0`,`ts` 必为正整数)→ `readHistory().find(x => x.ts === n)`,**找不到 / `h` 非法 → 不回填、维持空表单**(不崩)。
- **回填水合**(request→表单,**必须在 cohorts 异步加载完成后**做):`loadCohorts` 当前 fire-and-forget 返回 `void`,**必须改为可消费形**(把消费放进其 `.then`,或令其 `return` promise 链——直接 `loadCohorts().then` 会 `undefined.then` 抛错);`useLoad((options)=>…)` 把 `h` 存入 `pendingH`,在 cohorts 落地的**同一 `.then` 内**用**该回调局部 `cs`(非 `cohorts` React state,`setState` 异步)**消费,且**排在默认 `setCohortIdx(0)`/`setUnit` 之后**(否则默认盖掉回填);`pendingH` 清除分三态:命中水合 / **加载成功但 `cs` 为空(终态空品类、无表单)→ 清**;`.catch` 失败 → **不清**(重试再触发)。映射(对局部 `cs`):`mode = input.unitSize != null ? 'unit':'total'`(`ComputeRequest` 无 `mode`,反推);`amount/unit` 取自 `input.unitSize ?? input.totalAmount`、数字转字符串;`cohortIdx = cs.findIndex(c => c.slug === input.category)`。容错:**⓪ `cs.length===0` → 跳过水合并清 `pendingH`(避免 `cs[0]` 解引用)**;① slug 已不在树中(`findIndex` 返回 -1)→ **降级**填价格/数量/量 + 退回默认品类 + 内联提示"原品类已变动,请重选",**禁止**置 -1 或崩;② `unit` 不在**最终(命中或①退回默认)** cohort 的轴上 → 用 `unitsForAxis(最终cohort.axis)[0]` 钳制(①退回默认时按默认 cohort 轴、不按失效原 cohort);③ `/categories` 加载失败 → 保留品类错误态、**本次不回填**(不崩),且 `h` 经 `pendingH` **不丢失**、重试加载成功时再触发。

视觉**必须**复用 P0 设计 tokens(引用 `app.css` 的 `var(--…)`),**禁止**在该页 css / 内联 style 散写色板十六进制字面量。

#### 场景:即时比价入口仅本地跳转

- **当** 用户在 `我的` 点击即时比价入口
- **那么** **必须** `Taro.navigateTo({ url: '/pages/compute/index' })`(绝对路径 + `/index` + 对象形式);该入口本身**禁止**发起任何网络请求

#### 场景:比价成功后去重写入端上历史(环形、不越界、写失败不阻断)

- **当** 比价表单页 `POST /compute` 返回成功
- **那么** **必须**先剔除 `input` 相等的旧项、再 `unshift` 新项置于最新端、`slice(0,20)` 切尾(达上限时覆盖**最旧**、**禁止**无限增长、**禁止**同一输入堆叠重复);写入项 `ts` **必须单调唯一**(以**去重前**最大 `ts`(`prevMaxTs`)计 `Math.min(Number.MAX_SAFE_INTEGER, Math.max(Date.now(), prevMaxTs+1))`,同毫秒两次不同输入不撞、且封顶不越界,作 handle/列表 key 恒唯一);写入**禁止**额外网络请求
- **当** `setStorage` 写入失败(配额满 / 存储不可用)
- **那么** **必须**吞掉写错误、**仅丢这条历史**,比价结果卡片**必须**照常展示(**禁止**因写历史失败而报错或白屏)

#### 场景:读取健壮——非数组容器与坏项都不崩

- **当** `compute:history` 顶层值不是数组(从未写过、或被外部损坏)
- **那么** **必须**视作空历史(走空态)、**禁止**对其 `.map`/`.filter` 而抛错
- **当** 历史中存在无效项(`input` 缺字段 / 不符 `ComputeRequestSchema` / `summary` 非字符串 / `ts` 非安全正整数 / 重复 `ts` / 旧版 schema 残留 / **退化项:既无 `unitSize` 也无 `totalAmount`,或有 `unitSize` 却无 `quantity`**)
- **那么** **必须**逐项过滤(包裹字段判断:`summary` 为字符串、`ts` 须 `Number.isSafeInteger(ts) && ts>0` + `ComputeRequestSchema.safeParse(item.input, { jitless: true })` + **完整必填集**(`totalAmount` 或 `unitSize`+`quantity`))、并**按 `ts` 去重**,静默丢弃无效项(最坏历史变短),**禁止**白屏或抛错;`input` 校验**必须**带 `jitless`(weapp eval 禁用),**禁**为校验在 miniapp 引入 `zod`/`z.object` 依赖

#### 场景:每次进入我的重读历史

- **当** 用户比价一次后切回 `我的` Tab
- **那么** `我的` **必须**(经 `useDidShow` 每次进入重读)展示刚写入的新项;**禁止**仅在首次 `useLoad` 读取而令新项在 tab 切回后不出现

#### 场景:列出本地历史并以稳定 ts 回填重算

- **当** `我的` 加载且本地历史非空
- **那么** **必须**按时间倒序列出(每项含可读摘要 + 时间),读取**禁止**发起网络请求
- **当** 用户点击某历史项
- **那么** **必须**以该项 `ts` 作 handle 跳 `/pages/compute/index?h=<ts>`,比价表单页**必须**`find(x => x.ts === Number(h))` 命中后回填(mode 反推、amount/unit 取自二选一字段、cohortIdx 由 slug 匹配,均在 cohorts 加载后),用户可重新发起 `POST /compute`

#### 场景:回填容错——品类已下架 / categories 失败 / h 非法都不崩

- **当** 回填项的 `input.category` slug 已不在 `/categories` 树中(`findIndex` 返回 -1,且 `cs` 非空)
- **那么** **必须**降级:仍填价格/数量/量、退回默认品类、给内联提示请重选;**禁止**置 `cohortIdx=-1` 或崩、**禁止**静默选错 cohort
- **当** `/categories` 加载**成功但无 per_100ml cohort**(`cs` 为空)而 `h` 存在
- **那么** **必须**跳过水合、清 `pendingH`(页面呈空品类态、无表单可填),**禁止**对空 `cs` 取 `cs[0]` 解引用而崩
- **当** 比价表单页 `/categories` 加载失败而 `h` 存在
- **那么** **必须**保留品类错误态、本次不回填(不崩),且 `h`(经 `pendingH` 暂存)**不丢失**、用户重试加载成功时**必须**再触发回填;**当** `h` 非正整数 / 越界 / 篡改,**那么** **必须**不回填、维持空表单(不崩)

#### 场景:无历史时显示空态

- **当** `我的` 加载且本地历史为空(从未比价或全部被过滤)
- **那么** **必须**显示空态(非白屏、非报错),并引导用户去即时比价

### 需求:我的 Tab 必须提供关于区(数据来源说明 + 原生意见反馈)

`我的` Tab **必须**含「关于区」,全部为静态内容或微信原生能力,**禁止**发起应用网络请求、**禁止**构成纠错 / 贡献入口:

- **数据来源与时效说明**:**必须**以静态文案说明数据来自**用户主动贡献的众包数据 + 运营整理校准**、价格可能过期、结论**不构成**购买建议。文案**必须**与架构合规分层(§7:中心库只收用户已在看商品的众包数据、**不做服务端主动爬取**)一致,**禁止**出现「抓取 / 爬取 / 自动采集 / 自抓」等暗示主动爬取的措辞。
- **意见反馈**:**必须**用微信原生 `<button open-type="feedback">` 提供反馈入口;该入口是通用反馈、**禁止**承载商品纠错 / 数据录入语义。

#### 场景:数据来源说明为静态、合规口径

- **当** 用户查看 `我的` 关于区
- **那么** **必须**展示数据来源(众包贡献 + 运营整理校准)+ 时效 + 「不构成购买建议」静态文案;该区**禁止**发起任何网络请求;文案**禁止**含「抓取 / 爬取 / 自抓 / 自动采集」等暗示主动爬取的措辞

#### 场景:意见反馈走微信原生、非纠错入口

- **当** 用户点击意见反馈
- **那么** **必须**触发微信原生 `open-type="feedback"`;**禁止**把它作为商品纠错 / 数据录入 / 贡献入口

#### 场景:我的页源码无网络调用(可机检的无网络守卫)

- **当** 检查 `apps/miniapp/src/pages/mine/` 源码
- **那么** **必须不出现** `Taro.request` / `fetch` / `buildRankingsUrl` / `buildCategoriesUrl` / `buildComputeUrl` 等网络调用(历史为端上存储读、关于区为静态 + 原生反馈);此守卫使「我的自身不发网络请求」可被源码检查机械验证、而非仅靠手测 Network 面板

## 删除需求

### 需求:我的为带设计的占位 Tab

**Reason**: 本变更把 `我的` Tab 从占位升级为「比价工具区 + 关于区」功能页,占位要求与新功能要求(必须含比价工具 + 历史 + 关于)直接矛盾,归档后不可并存。
**Migration**: 由本变更的「我的 Tab 必须提供比价工具区」「我的 Tab 必须提供关于区」两条新增需求取代;原占位的两条约束(非白屏、不含贡献/录入/纠错入口)被新需求继承——新页非空(有工具区/关于区,天然非白屏)、且仍明确**禁止**贡献/录入/纠错入口(只读边界不变)。
