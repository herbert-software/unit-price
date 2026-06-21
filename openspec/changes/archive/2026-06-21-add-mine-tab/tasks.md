## 1. 本地历史工具(apps/miniapp)

- [x] 1.1 新建 `apps/miniapp/src/pages/compute/history.ts`。`readHistory()`:`getStorageSync('compute:history')` → **先 `Array.isArray` 守容器**(非数组返回 `[]`)→ 每项校验:包裹字段(`summary` 字符串、`ts` 须 `Number.isSafeInteger(ts)&&ts>0`;**不引入 `zod`/`z.object` 依赖**)+ `ComputeRequestSchema.safeParse(item.input, { jitless: true })`(从 api-client 导入、禁手写;jitless 必带:weapp eval 禁用)+ **完整必填集**(镜像服务端 `meetsComputeRequiredSet`:`totalAmount != null || (unitSize != null && quantity != null)`,否则退化项丢弃——schema 只禁二者皆有、`quantity` 可选;端上不引 core 故手写镜像)→ 过滤无效项 → **再按 `ts` 去重**(同 `ts` 留最先一项)。
- [x] 1.2 同文件 `appendHistory(input, summary, cohortName)`:以 `readHistory()` 为基底 `base` → **先取 `prevMaxTs = Math.max(0, ...base.map(h=>h.ts))`(去重前)** → **去重**(剔除 `input` 相等旧项,`JSON.stringify` 比较)得 `rest` → `ts = Math.min(Number.MAX_SAFE_INTEGER, Math.max(Date.now(), prevMaxTs + 1))`(**单调唯一** + 封顶防溢出,作 handle/列表 key)→ `[{input, summary, ts}, ...rest].slice(0, 20)`(unshift 最新在前、切尾覆盖最旧)→ `setStorageSync` 包 `try/catch`(失败静默)。
- [x] 1.3 同文件 `summarizeInput(input, cohortName): string`(摘要含品类**显示名** `cohortName`——`input.category` 只有 slug;由调用点传入)、`findHistoryByTs(ts)`(`readHistory().find`,供回填)。
- [x] 1.4 `history.test.ts`:断言①环形**覆盖方向**(写满 20 后第 21 条令**最旧**被切、最新在 index 0——不只断言长度==20);②坏项(非数组容器 / 缺字段 / `summary` 非字符串 / `ts` 非安全正整数 / 重复 `ts` / **退化项:无量字段**)被过滤/去重为合法子集;③去重(同 input 再写不增长、移到最前);④两次**不同输入**(可同毫秒)的 `ts` 不相等(单调唯一);⑤**正向保留 + 退化丢弃**:合法 `unitSize`+`quantity` 行 与 `totalAmount` 行**都存活**,而 `unitSize`-缺-`quantity` 行 与 neither 行**被丢**(守卫=完整必填集,既不误伤真实行也不放过退化项);⑥**替换最新重复项**时即便 `Date.now()` 不大于旧 `ts`(stub 时钟),新 `ts` 仍 > 余下最大(`prevMaxTs` 取自去重前)。注:jitless 的 weapp-only 失败 node 单测覆盖不到(vitest 默认开 JIT),由 4.2 实测兜底。

## 2. compute 页接入历史(apps/miniapp)

- [x] 2.1 `pages/compute/index.tsx`:`POST /compute` 成功分支(`parseComputeResponse` 通过后)调 `appendHistory(request, summarizeInput(request, cohort.name), cohort.name)`;写失败不阻断结果展示。
- [x] 2.2 回填:把 `loadCohorts` 改为**可消费形**(`return fetchCohorts().then(...)` 或把消费放进其现有 `.then`——当前返回 `void`,`loadCohorts().then` 会抛错)。`useLoad((options) => …)` 把 `options.h` 存入 `pendingH` ref(**不**直接水合);在 cohorts 落地的**同一 `.then` 内**用**该回调局部 `cs`**(非 `cohorts` state)消费,且**排在默认 `setCohortIdx(0)`/`setUnit` 之后**;handle 校验 `Number(h)` + `Number.isInteger(n)&&n>0` → `findHistoryByTs(n)`;命中后水合:`mode = input.unitSize!=null?'unit':'total'`、`amount/unit` 取自 `unitSize ?? totalAmount`(数字转字符串)、`totalPrice/quantity` 转字符串、`cohortIdx = cs.findIndex(c=>c.slug===input.category)`。
- [x] 2.3 回填容错:**⓪ `cs.length===0`(成功但空品类)→ 跳过水合并清 `pendingH`(不取 `cs[0]`)**;`findIndex` 返回 -1(品类已下架,`cs` 非空)→ 退回默认 cohort + 填其余字段 + 内联提示请重选(不置 -1);`unit` 不在**最终(命中或退回默认)cohort** 轴 → `unitsForAxis(最终cohort.axis)[0]` 钳制;`/categories` 加载失败(`.catch`)→ 保留错误态、不回填、`pendingH` **不清**(`onTap={loadCohorts}` 重试成功再触发);`h` 非法/未命中 → 不回填、维持空表单。全程不崩。

## 3. 我的页实现(apps/miniapp)

- [x] 3.1 重写 `pages/mine/index.tsx`:替换占位,分「比价工具区」「关于区」两段;视觉只引 `var(--…)`,禁散写色板字面量(清理 placeholder 旧类按需)。
- [x] 3.2 比价工具区:常驻「即时比价」入口 `Taro.navigateTo({ url: '/pages/compute/index' })`(绝对路径 + `/index` + 对象形式,不发网络);历史经 `useDidShow` **每次进入重读** `readHistory()`、倒序列出(每项摘要 + 时间),点击 → `Taro.navigateTo({ url: \`/pages/compute/index?h=${item.ts}\` })`;空历史显示空态 + 去比价引导。
- [x] 3.3 关于区:静态「数据来源(众包贡献 + 运营整理校准)+ 时效 + 不构成购买建议」文案(**禁**「抓取/爬取/自抓」等措辞,合 §7 口径);意见反馈用原生 `<button open-type="feedback">`(非纠错入口)。`mine/` 源码**禁**出现 `Taro.request`/`fetch`/`buildXxxUrl`。
- [x] 3.4 时间展示用 `ts` 格式化(相对/绝对皆可),无需引日期库。

## 4. 校验

- [x] 4.1 `pnpm -F @unit-price/api-client build && pnpm -F @unit-price/core build` 后 `pnpm -F @unit-price/miniapp build:weapp` 通过(无类型/打包错);`pnpm -F @unit-price/miniapp test`(含 1.4)通过。
- [ ] 4.2 微信开发者工具实测(**须走难路径**,非 happy path):① 比价一个**与表单默认品类不同**且用 **总容量(mode=total)** 的项 → 回我的见新项 → 点它回填,验证 **cohort/mode/amount/unit 全部正确还原**(覆盖 slug→idx + mode 反推 + jitless 读校验真机不崩);② 用 devtools Storage **手动注入**一条 `input.category` 为树中不存在 slug 的历史项 → 点回填,验证**降级填充 + 提示重选、不崩**(容错①);③ 令 `/categories` 先失败(断网/改 BASE)再点重试加载成功,`h` 挂起期间 → 验证**重试后再触发回填**(容错③);④ 另测空态、写满 20 后最旧被挤、`mine` 全程 Network 面板无请求。

## 5. 收尾

- [ ] 5.1 `openspec-cn validate add-mine-tab` 通过;feature 分支 + PR。
