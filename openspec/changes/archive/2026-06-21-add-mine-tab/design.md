## 上下文

`我的` Tab 现为占位页(`pages/mine`,无请求)。本变更把它升级为「比价工具区 + 关于区」,全部端上完成、不破只读边界。两处有真技术分歧,设计须钉死:① **跨页本地历史的存读**(写在 `pages/compute` 比价成功时,读在 `pages/mine`,经 Taro 本地存储解耦);② **历史项回填到比价表单的水合**——历史存的是 `ComputeRequest`(`category` 是 **slug**、值是数字、无 `mode` 字段),而表单状态是 `cohortIdx`(异步 `/categories` 加载后的**索引**)+ `mode` + 字符串字段,二者不同构,水合必须显式转换且能容错。无新依赖、无后端/契约改动。

## 目标 / 非目标

**目标:**
- Taro 本地存储承载比价历史:写在 compute、读在 mine,两页不互相 import 状态。
- 历史项校验、回填水合的失败路径全部有定义(损坏存储、非数组容器、缺字段、旧 schema、品类已下架、`/categories` 加载失败、非法 handle)——一律静默降级、不崩、不谎报。
- 点击历史项可回填比价表单并重算。

**非目标:**
- 不引入登录、服务端用户态、历史云同步。
- 不做收藏/关注、不做贡献/纠错/扫码/拍照。

## 决策

### D1 存储形态与读校验
- 单键 `compute:history`,值为 `Array<{ input: ComputeRequest; summary: string; ts: number }>`。`input` 复用 `@unit-price/api-client` 的 `ComputeRequestSchema`(不另写)。
- `readHistory()`:`getStorageSync` 后**先 `Array.isArray` 守容器**(非数组 → 返回 `[]`,杜绝对损坏值 `.map`);再对**每项**三步校验:① 包裹字段——`typeof summary==='string'` 且 `ts` 须 **`Number.isSafeInteger(ts) && ts > 0`**(用朴素判断、**不**引入 `zod`/`z.object` 依赖;`Number.isSafeInteger` 一并挡掉 `0`/负/小数/`NaN`/`Infinity`/被篡改到 `MAX_SAFE_INTEGER` 之外的值,使 `ts` 作 handle/React key 恒为合法正整数);② `input` 复用 api-client 既有 `ComputeRequestSchema.safeParse(item.input, { jitless: true })`;③ **再校验完整必填集**(镜像服务端 `meetsComputeRequiredSet` 的 presence 部分):`input.totalAmount != null || (input.unitSize != null && input.quantity != null)`——`ComputeRequestSchema` 的 refine 只禁"二者皆有"、**不禁"二者皆无"**,且 `quantity` 在 schema 里**可选**(必填集在服务端、不在 schema);故"既无总容量也无单件容量"**或**"有单件容量却无 `quantity`"的**退化项**能过 schema 却非完整输入(回填会出 `unit=undefined` 或凭空补 `quantity='1'`),须在读端按非法项丢弃。`quantity>0`/`value>0`/轴单位均已由 schema 保证,此处只校验**存在组合**。`meetsComputeRequiredSet` 在 `packages/core`、作用于 `ParsedSpec`,端上不引 core,故此处是**手写镜像**(与服务端必填集同口径,若服务端改须同步)。任一步不过 → 静默丢弃(覆盖缺字段 / `summary`·`ts` 类型损坏 / 旧版 schema 残留 / 退化项)。④ 过滤后**再按 `ts` 去重**(同 `ts` 仅留最先一项),防被篡改存储的重复 `ts` 致 `find`/React key 歧义。
- **`{ jitless: true }` 是硬约束**:weapp 禁 `eval`,Zod 默认 `new Function` JIT 在 weapp 崩(与 `parseComputeResponse` 同因,见 `compute.ts`)。任何端上直接 `.parse/.safeParse` 都必须带 `jitless`。
- *备选*:只校验 `input`、不校验 `summary/ts` —— 否决,mine 直接渲染 `summary` 与格式化 `ts`,坏类型会渲染脏数据或令日期格式化抛错(故 typeof 守包裹字段)。用 `z.object` 包裹校验 —— 否决,徒增 miniapp 的 zod 依赖,typeof 三行足够。

### D2 写时机、环形与去重
- 在 `pages/compute` 的 `POST /compute` **成功**分支(`parseComputeResponse` 通过后)调 `appendHistory(input, summary, cohortName)`。
- `appendHistory`:以 `readHistory()` 为干净基底 `base` → **先取 `prevMaxTs = Math.max(0, ...base.map(h => h.ts))`**(**去重前**全量最大;若先去重再取,剔除的恰是最新项时新 `ts` 会失去单调)→ **去重**(剔除 `input` 深相等旧项,`JSON.stringify` 比较,够用)得 `rest` → 计 **单调唯一** `ts = Math.min(Number.MAX_SAFE_INTEGER, Math.max(Date.now(), prevMaxTs + 1))`(`Math.min` 封顶:防被篡改到 `ts===MAX_SAFE_INTEGER` 的存储项令 `prevMaxTs+1` 溢出安全整数区、使新项下次读时被丢——封顶后边界项 `ts` 稳定不越界;若 `prevMaxTs` 恰为 `MAX_SAFE_INTEGER`,新项与边界项同 `ts`,由读端 ④ 的 `ts` 去重(留最新)消化、不滞留)→ `[{input, summary, ts}, ...rest].slice(0, 20)` → `setStorageSync` 包 `try/catch`,失败仅丢历史、不阻断结果展示。
- `unshift` 语义使存储**恒为最新在前**,mine 直接渲染、无需再排序;`slice(0,20)` 环形覆盖**最旧**(切尾),`N=20`。
- 去重的理由:回填重算会再写一条,不去重则同一输入在环里堆叠、挤掉真正不同的旧项(把重算视为"该项移到最前")。

### D3 回填 handle = 稳定 `ts`,非数组索引
- 历史项点击 → `Taro.navigateTo({ url: \`/pages/compute/index?h=${item.ts}\` })`(**绝对路径 + `/index` + 对象形式**,与 `ComputeCta.tsx`/`index.tsx` 既有约定一致;`pages/compute` 非 tab 页,`navigateTo` 正确)。
- compute 启动读 `h`:`Number(h)` → 要求**正整数**(`Number.isInteger(n) && n > 0`,`ts` 必为正整数;比 `Number.isFinite` 更精确,挡掉负数 / 小数)→ `readHistory().find(x => x.ts === n)`;**找不到 / `h` 非法(非数 / 空 / 篡改)→ 不回填、维持空表单**(不崩)。
- *为何用 `ts` 不用索引*:索引是对**可变环形表**的位置引用,`unshift` 会让每个索引改指;且 mine 展示的是过滤后列表,索引与原始存储易错位。`ts` 是项自带的稳定键,`find` 天然抗过滤/重排/错位;其**唯一性由写端单调保证**(D2 `Math.max(now, 最新+1)`,同毫秒两次不同输入也不撞),非概率论证——故 `ts` 既作回填 handle 又作列表 React key 皆恒唯一。

### D4 水合映射(request → 表单),容错三路
水合**必须在 cohorts 异步加载完成后**进行(`useLoad` 触发时 `cohorts` 仍为空)。**机制(须把 `loadCohorts` 改为可消费形)**:当前 `loadCohorts` 是 fire-and-forget 返回 `void`——直接 `loadCohorts().then(...)` 会 `undefined.then` 抛错;故**把消费逻辑放进 `loadCohorts` 现有的 `.then` 回调内**(或令其 `return` 该 promise 链)。`useLoad((options)=>…)` 先把 `options.h` 存入 `pendingH` ref(**不**直接水合);在 cohorts 落地的**同一 `.then` 回调内**,用**该回调局部的 `cs`**(**非** `cohorts` React state——`setState` 异步、此刻 state 仍是旧值)消费 `pendingH`。消费**须排在默认 `setCohortIdx(0)`/`setUnit(...)` 之后**(或默认仅在无 `pendingH` 时设),否则默认值会盖掉回填的 cohort。重试入口 `onTap={loadCohorts}` 走同一函数,故重试成功自然再消费。`pendingH` **清除分三态**:命中并水合 / **加载成功但 `cs` 为空**(终态空品类、无表单可填)→ **清**;`.catch`(`/categories` 失败)→ **不清**(留待重试,覆盖容错③)。映射(均针对局部 `cs`):
- `mode = input.unitSize != null ? 'unit' : 'total'`(`ComputeRequest` 无 `mode`,从二选一字段反推)。
- `m = input.unitSize ?? input.totalAmount`;`amount = m ? String(m.value) : ''`、`unit = m?.unit`;`totalPrice = String(input.totalPrice)`、`quantity = input.quantity != null ? String(input.quantity) : '1'`(数字 → 字符串态)。
- `cohortIdx = cs.findIndex(c => c.slug === input.category)`(对**局部 `cs`**)。
- **容错**:**⓪ 前置**:`cs.length === 0`(加载成功但无 per_100ml cohort)→ 页面本就早返回「暂无可比品类」、无表单,**跳过水合并清 `pendingH`**,不进 ①②(避免 `cs[0]` 为 `undefined` 的解引用);① 品类 slug 已不在树中(`findIndex` 返回 -1,如重新种子/cohort 被清空/重量轴仍门控)→ 退回默认 `cohortIdx=0` + 仍填价格/数量/量 + 内联提示"原品类已变动,请重选",**不置 -1、不崩**;② `unit` 不在**最终解析出(命中或①退回默认)**的 cohort 轴上 → 用 `unitsForAxis(最终cohort.axis)[0]` 钳制——①退回默认 cohort 时,②**按该默认 cohort 的轴**钳制(失效的原 cohort 无可解析轴,不据它钳);③ `/categories` 加载失败(`catPhase='error'`)→ 保留品类错误态、**本次不回填**(无 cohort 轴无法安全填量),`pendingH` 不清、重试加载成功时再触发(见上"机制")。

## 风险 / 权衡

- [compute 请求/历史项 schema 演进使旧历史失效] → 读时整项 `safeParse` 过滤,最坏历史变短,不崩。
- [本地存储写失败/配额满] → 写包 `try/catch`,失败仅丢历史、不影响本次比价结果展示。
- [品类 slug 随服务端 taxonomy 漂移而失效] → D4 容错①降级填充 + 提示重选,非静默错 cohort。
- [`summary` 与 `input` 冗余] → 接受:`summary` 是展示快照,避免 mine 依赖 compute 输入语义,代价仅几十字节/项;且 `summary` 含品类显示名(`cohortName`,`input.category` 只有 slug),须在 compute 调用点传入。
- [jitless 的 weapp-only 失败无法被 node 单测覆盖] → vitest 默认开 JIT,`safeParse` 不带 jitless 也绿;故 jitless 正确性靠 4.2 微信开发者工具实测兜底,单测只断言环形/过滤逻辑。
