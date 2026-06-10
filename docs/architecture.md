# 单位价格比价系统 — 技术架构蓝图

> 本文是项目架构的单一事实源（SOT）。其他文档（README、CLAUDE.md、OpenSpec context）应指向本文，而非复制内容。

## 一、产品定位

做一套「真实单价 / 规格归一化比价」系统，区别于传统的「同款不同店」比价，先期聚焦山姆会员店的饮料品类。

护城河不是「爬价格」，而是：**用 AI 把脏乱的商品规格文本变成结构化数据，再用确定性程序算出可比较的单位价格，并判断商品是否可比。**

四个面向不同场景的「薄客户端」共享同一个核心引擎：

1. 山姆比价**小程序**（榜单浏览 + 手动/扫码录入）
2. 比价**浏览器插件**（读页面 DOM → 浮层展示真实单价）
3. **公众 API**（对外开放，也是所有客户端的后端）
4. 未来 **Surge MITM 模块**（拦截指定 App 的接口数据 → 算单价）

**关键架构判断**：Surge 脚本是 JS、插件是 JS、小程序可用 Taro(JS)，而确定性计算层（单位换算 / 正则解析 / 单价计算 / 可比判断）在客户端和服务端**完全相同**。因此采用 **TypeScript 全栈 monorepo**，把这层抽成共享 `core` 包，既能在客户端离线即时反馈，又能在服务端做权威计算；AI 解析层只在服务端（需要密钥、要花钱）。

数据模型采用**按需计算 + 众包沉淀**：任何端看到商品都能无状态实时算单价；用户/插件/Surge 可选上报 `RawProduct` 到中心库，逐步沉淀出「山姆饮料真实单价榜」，供小程序和 API 消费，形成数据飞轮。

---

## 二、整体架构

```
              ┌──────────────────────────────────────────────┐
              │           packages/core  (同构 TS)            │
              │  units · rule-parser(tier1) · calculator     │
              │  comparability · types/zod-schema             │
              └───────────────┬───────────────┬──────────────┘
        离线即时反馈 / 类型共享 │               │ 权威计算 / schema 校验
        ┌───────────┬─────────┴───────┬────────┴──────────┐
        ▼           ▼                 ▼                   ▼
   浏览器插件     小程序(Taro)     Surge 模块(未来)    apps/api (Hono)
   DOM 抽取      榜单+录入         MITM 抽取           ├ LLM 解析层(tier2)
   →浮层         →榜单/对比        →算单价/通知        ├ 校验层(tier3)
        └───────────┴─────────────────┴──────── HTTP ────┤ DB(D1/SQLite·Drizzle)
                       公众 API + api-client SDK          └ Cache(Redis)
```

三段式解析落到代码层：

- **tier1 规则解析**：`core/parser` 正则抽 `ml/L/g/kg × 数量`，客户端服务端都跑。
- **tier2 AI 解析**：仅 `apps/api`，处理 `250ml*12盒*2箱`、`750ml+500ml组合装` 等脏文本，强制结构化输出。
- **tier3 校验 + 计算**：`core/calculator` 确定性算 + 留痕公式（`40 / (330*24) * 100`），校验 `total == unit*qty*multiplier`，不一致打 warning。**AI 只理解、不计算。**

---

## 三、Monorepo 布局

```
unit-price/
  pnpm-workspace.yaml
  packages/
    core/            # 同构核心：types, units, parser(tier1), calculator, comparability
    api-client/      # 由 OpenAPI/类型生成的 typed SDK，四个客户端共用
  apps/
    api/             # Hono 后端：LLM 适配器, tier3, DB, cache, 公众 API
    extension/       # WXT (MV3) 浏览器插件
    miniapp/         # Taro WeChat 小程序
    surge/           # Surge 模块脚本（占位）
  docs/              # 架构与设计文档
  openspec/          # 变更提案管理
```

工具链：pnpm workspace + TypeScript project references；Zod 作为 schema 单一事实源（types 从 Zod 推导，API 校验、LLM 结构化输出、客户端校验都用同一份）。

---

## 四、packages/core（系统灵魂，先做、做准）

- **types**：`RawProduct` / `ParsedSpec` / `UnitPrice` / `ComparisonItem`，全部 Zod schema 推导。
- **units**：单位换算表 `1L=1000ml, 1kg=1000g, 1斤=500g`；单位别名归一（`ml/mL/毫升/升/L`、`听/罐=can` 等）。
- **parser (tier1)**：正则抽候选规格，覆盖简单情形；输出候选 + 命中证据，留给 tier2 补全。
- **calculator (tier3)**：`per_100ml / per_liter / per_piece` 等确定性计算 + `formula` 留痕字符串 + 一致性校验 warning。
- **comparability**：可比判断 + `excludedReason`（规格缺失/组合混杂/赠品复杂/单位不统一/促销复杂），输出 `comparable` 与 `comparisonGroup`。
- **品类插件 CategoryPlugin**：`getComparableUnits(spec)` 决定每个品类的可比单位（饮料 `[per_100ml, per_liter, per_bottle]`）。先实现 beverage，预留 food/paper/laundry/meat 接口。

> 这层是纯函数 + 无 IO，必须有完整单测（脏标题样本集），是整个系统的可信度基础。

---

## 五、apps/api（公众 API + AI 层）

- 框架 **Hono**（轻、可跑 Node/边缘，适合做公众 API），NestJS 为备选。
- **LLM 适配器 `SpecParserLLM`**：抽象接口，多模型可插拔（DeepSeek/Qwen 便宜，OpenAI/Claude 兜底）。默认 DeepSeek/Qwen——这个任务要的是 **JSON 输出稳定 + 成本低 + 不乱猜**。用 function calling / 强制 JSON schema。
- **解析缓存**：Redis，key = `hash(归一化title + price + categoryHint)`，命中直接返回，避免重复调 LLM。
- **核心接口**：
  - `POST /parse` — RawProduct → ParsedSpec + UnitPrice + confidence + comparable + explanation
  - `POST /compare` — 多商品 → 归一化排名 + 自然语言 summary（解释用 AI，计算不用）
  - `POST /contribute` — 上报 RawProduct 入中心库（众包，需轻量鉴权/限频）
  - `GET /rankings` — 按品类/品牌/比价组取榜单（小程序主消费）
  - `POST /corrections` — 人工纠错（`parse_source=manual_corrected`，沉淀 few-shot 样本）
- **公众 API 治理**：API key + 限频 + 用量统计。
- **DB**：Cloudflare D1（SQLite）+ Drizzle ORM（CF 优先；schema 用 SQLite↔Postgres 可移植类型，撑爆 D1 时可平滑迁 Postgres）。表：`product_raw / product / unit_price / corrections`。（`product` 即规范商品表，承载商品身份而非仅 spec；`comparison_group` 不物化——对比组按 `docs/taxonomy-and-tagging.md` §九 改动态查询。品类 `tag` 系列表见该文档，由后续变更引入。）

---

## 六、四个客户端

1. **浏览器插件（apps/extension，WXT + MV3）**：content script 用 StorePlugin（`matchUrl/extractProduct`）从山姆页面抽 `RawProduct` → core 跑 tier1 即时浮层 → 调 `/parse` 拿 AI 结果与可比判断 → 浮层展示真实单价（每瓶/每100ml/每升 + 可信度 + 反套路提示）。可选「上报到榜单」按钮调 `/contribute`。
2. **小程序（apps/miniapp，Taro + React）**：定位 = **榜单浏览 + 手动/扫码录入**。浏览 `/rankings`；用户手动输入或扫码/拍照录入 → core tier1 即时算 + 调 `/parse` → 展示并可 `/contribute`。Taro 让 core 包直接复用。
3. **公众 API**：即 apps/api，配 `packages/api-client` 提供 typed SDK 给三个客户端和第三方。
4. **Surge 模块（apps/surge）**：JS 脚本 MITM 拦截指定 App 接口 JSON → 复用 core 类型抽 `RawProduct` → POST `/parse` → 改写响应或推送通知。**合规最敏感**，定位为「个人使用 / 未来」层。

---

## 七、合规分层

| 数据来源 | 合规风险 | 阶段 |
|---|---|---|
| 用户手动录入 / 扫码拍照 | 低 | MVP |
| 插件读当前页面 DOM（用户自己在看） | 低-中 | 早期 |
| 众包上报（用户主动贡献当前商品） | 中 | 早期 |
| App 抓包 / MITM（Surge） | 高 | 未来 / 个人 |
| 服务端主动全站爬取 | 最高 | 不做 |

原则：**实时按需计算永远可用（无状态）**；中心库只收「用户已经在看的商品」的众包数据，不做服务端主动全站爬取。

---

## 八、分期路线

- **Phase 1 — core 引擎 + /parse /compare（饮料、每100ml）**
  `packages/core` 全套 + 单测；`apps/api` 起 Hono + LLM 适配器(DeepSeek) + `/parse` `/compare`；一个最小 Web 或插件验证规格解析准确率与单价体验。**先把这个做准。**
- **Phase 2 — 山姆商品页插件**
  WXT 插件 + 山姆 StorePlugin + 浮层 + 人工纠错；只做饮料、不做全站爬、不做复杂促销。
- **Phase 3 — 中心商品库 + 众包榜单 + 小程序**
  D1（SQLite）落库 + `/contribute` `/rankings` `/corrections`；Taro 小程序上线榜单浏览 + 录入。
- **Phase 4 — 多商店 + Surge 模块 + 复杂品类**
  StorePlugin 扩 Costco/盒马/京东；apps/surge MITM；CategoryPlugin 扩纸品/洗护/肉类/宠物食品；引入促销分层（直接价/件数促销/满减均摊 + confidence）。

---

## 九、验证方式

- **core 单测**：用脏标题样本集断言解析与单价计算（含组合装、`*N箱` 漏算、单位别名），`pnpm --filter core test`。
- **API 端到端**：`pnpm --filter api dev` 起服务，对 `/parse` `/compare` 验证输出契约（per_100ml / 排名 / summary / confidence / comparable）。
- **解析准确率回归**：维护标注样本集，跑 tier1-only vs tier1+AI 的准确率对比，作为换模型/改 prompt 的回归基线。
- **插件人工验证**：在真实山姆商品页加载插件，确认 DOM 抽取 + 浮层数值正确。

---

## 十、核心产品原则

1. **不追求万物可比**——明确告诉用户某商品不适合参与比价，是专业感不是缺陷。
2. **默认用最稳定的单位**——饮料 `per_100ml`，食品 `per_100g`，大宗 `per_kg`，纸品 `per_100抽/每卷`。
3. **AI 只做理解，不做最终判断**——价格、单位换算、是否可比由规则引擎控制。
4. **每个结论都能解释**——计算留痕公式可回放。
5. **不要一开始做大而全**——第一版只做「饮料 + 山姆 + 每100ml」。

> 详细的数据模型 JSON、AI prompt 设计、促销分层与反套路提示样例，见根目录 `qa.md`（需求源讨论）。
