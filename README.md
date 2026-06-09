# 单位价格比价系统（Unit Price）

一套「真实单价 / 规格归一化比价」系统。区别于传统的「同款不同店」比价，它关注的是**不同包装、不同容量、不同组合下真实可比的单位成本**——比如一箱可乐 40 元，折算下来每 100ml 到底多少钱、值不值。先期聚焦山姆会员店的饮料品类。

> 给消费者装一个**价格透视眼**，拆穿「超市数学障眼法」。

## 核心理念

**用 AI 把脏乱的商品规格文本变成结构化数据，再用确定性程序算出可比较的单位价格，并判断商品是否可比。**

- **AI 只做理解，不做计算**——规格解析交给 LLM，价格/单位换算/可比判断由确定性程序决定，每个结论都留痕公式可解释。
- **一套核心，多端复用**——确定性计算层（单位换算 / 正则解析 / 单价计算 / 可比判断）是同构 TypeScript，客户端离线即时算、服务端权威算，用同一份代码。

## 交付面

| 端 | 形态 | 说明 |
|---|---|---|
| 浏览器插件 | WXT (MV3) | 读山姆商品页 DOM，浮层展示真实单价 |
| 小程序 | Taro | 榜单浏览 + 手动/扫码录入 |
| 公众 API | Hono | 对外开放，也是所有客户端的后端 |
| Surge 模块 | JS 脚本（未来） | MITM 拦截 App 接口数据算单价 |

## 仓库结构

```
packages/core        # 同构核心：types · units · parser(tier1) · calculator · comparability
packages/api-client  # typed SDK
apps/api             # Hono 后端：LLM 适配器 · tier3 · Postgres/Drizzle · Redis
apps/extension       # 浏览器插件 (WXT)
apps/miniapp         # 小程序 (Taro)
apps/surge           # Surge 模块（占位）
docs/                # 架构与设计文档
openspec/            # 变更提案管理
```

## 文档

- **架构蓝图（SOT）**：[`docs/architecture.md`](docs/architecture.md)
- **进度板**：[`TODO.md`](TODO.md)
- **需求源讨论**：[`qa.md`](qa.md)
- **协作约定**：[`CLAUDE.md`](CLAUDE.md)

## 路线

- **Phase 1**：`packages/core` 引擎 + `apps/api` 的 `/parse` `/compare`（饮料、每 100ml）——先做准
- **Phase 2**：山姆商品页插件
- **Phase 3**：中心商品库 + 众包榜单 + 小程序
- **Phase 4**：多商店 + Surge 模块 + 复杂品类

详见 [`docs/architecture.md`](docs/architecture.md) 第八节。
