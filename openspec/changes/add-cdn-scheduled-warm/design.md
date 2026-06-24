## 上下文

公共读已是长 TTL(1 天)+ 端上 SWR。残留:边缘对象 TTL 到期或低流量 LRU 驱逐后,首个真实用户吃一次跨境回源 ~5–7s。域名 `unit-price.herbert-dev.cn` 是 Aliyun CDN **domestic scope**(`DescribeCdnDomainDetail` 实测),只服务国内 POP。控制台"刷新预热"是一次性的,无原生"每天定时预热"——定时 = 外部调度器周期调 `PushObjectCache`。仓库已有 GH Actions;`aliyun` CLI 本机已配 AK。

`buildRankingsUrl`(`packages/api-client/src/client.ts`)发参顺序 `limit→offset→category→q`;`PAGE_SIZE=20`;落地榜发 `/rankings?limit=20&offset=0`(无 category)。rankable cohort 集(预热 URL 的 `category` 取值)= 决策节 / tasks 1.2 枚举的 **15 个 slug**(源:`packages/db/src/seed.ts` CATEGORY_NODES + `packages/core/src/category-rules.ts`;含非叶 `soft-drink`/`dairy`,排除非 rankable 的 `beverage`/`alcohol` 父),非"叶 slug"、非省略。

## 目标 / 非目标

**目标:** 国内 POP 对公共读热 URL **尽量保持热**(best-effort),把冷尾那一跳从首个真实用户转给预热任务、缩小冷窗口;复用既有 CI、凭据最小权限。

**非目标:** 不改用 Aliyun-native 调度;不 curl 预热;不动 TTL/SWR/应用码;不动态枚举全量 cohort;不在本提案做 deploy.yml 部署后预热步;不强制心跳服务;不解决跨境回源本身;**不声称"永不冷"**。

## 决策

- **调度器 = GH Actions `schedule` cron(+`workflow_dispatch`)**,非 Aliyun FC/OOS:复用既有 CI、零新阿里云服务。代价:Aliyun AK 进 GH secret(最小权限 RAM + 失败隔离对冲);GH cron best-effort(可被**丢弃**非仅延迟,整点是最差时隙 → cron 取**非整点 12h 两次** `17 8,20 * * *` = 16:17/04:17 北京);仓库 60 天无活动 schedule 自动停(→ 每月人工核对存活,见下)。沿仓库 CI 约定加顶层 `permissions: {}`(仅调外部 API)+ `concurrency` group(`cancel-in-progress: false`)。
- **灌入用 `PushObjectCache`,非 curl**:domestic-scope 域,海外 runner curl 热不到国内 POP;`PushObjectCache` 由阿里云发起回源灌入国内 POP,与 runner 位置无关。硬前提,写入 spec。
- **best-effort 而非"永不冷"——这是本次最关键的认知修正**:"预热是否刷新**仍新鲜**对象的 TTL"阿里云**未文档化**,存在两种可能:
  - **(a) 预热只补已过期/驱逐对象**(对新鲜对象 no-op / 条件 304 不重置时钟):则对象在原 fetch 后约 24h 自然过期,冷窗口 ≈ 从过期到下次预热 ≈ **预热间隔**,无法靠提高频率消除、只能缩小。
  - **(b) 预热总是回源重置 TTL**:则任一 < TTL 间隔即保持常热。
  原提案默认 (b) 并据此断言"每天一次→永不过期",**未经验证**;且即便 (b),exactly-24h cron 会与 86400s 边界赛跑、LRU 驱逐也照样制造冷窗口。故 spec 改为"缩小冷窗口"的 best-effort,不发"永不冷"保证;频率取**有余量**(起步每 12h、两次:`17 8,20 * * *` ≈ 16:17/04:17 北京),并把 (a)/(b) 判定设为**实测验收门**——若实测 (b),可回落每天一次。
- **形态 + query 键 = go/no-go 实测门**:`ObjectPath` 文档形态是 `domain/path`、scheme/query 是否被当缓存键**未明确**;整个价值压在"预热精确 query 键"。上线前**必测**:预热带 query 的 URL → 从国内视角(或看 `X-Cache`/`Age`,**避开探测 curl 自己把边缘热了的假阳性**)确认该精确键命中。不过则 approach 须改(如改 `RefreshObjectCaches` 或换路径级)。
- **URL 清单 hardcode 全部 rankable cohort 的字面 slug**(纳入谓词 = `rankable = comparableUnit !== null`,即分类树可点达节点——**含**非叶 `soft-drink`/`dairy`,**排除**非 rankable 的 `beverage`/`alcohol` 父;**非**"哪些叶可下钻"那种叶性判据)。当前 15 个:`soft-drink, carbonated, juice-plant, coffee-tea, drinking-water, dairy, milk, yogurt, lactic-drink, baijiu, wine, spirits, whisky, beer, sake-fruit-wine` + landing + `/categories` = 17 URL。**含 `category=soft-drink`**:它与落地无-category 键同 body 但不同 CDN 键(下钻软饮发带 category 键),故须各自预热。不用中文标签(→400)、不**动态**枚举(手动同步,新 cohort 自愈)。发参顺序/`PAGE_SIZE` 与 `buildRankingsUrl` 一致——workflow 注释钉死。
- **凭据 = 最小权限 RAM 子账号**(策略仅 `cdn:PushObjectCache`,附 JSON);AK 存 GH secret;脚本 **逐 URL 独立尝试**(单个失败 `continue`+计数,契合"部分失败隔离")、记返回 `PushTaskId`(异步:受理≠已热,真正热度以下次 HIT 为准);**但末尾全失败(`fail==total`)必须 `exit 1`**(GH Actions 默认 `bash -eo pipefail`,`||continue` 会吞错,无终门则全失败 job 仍绿——这是 round-1 静默失败在 run 粒度的重现);**不 `echo` AK、不 `set -x`** 环绕 configure;CLI **pin 具体版本 + sha256**(非 `-latest-`)。
- **存活观测**:`workflow_dispatch` 兜底;GH 默认仅在"运行失败"通知、不覆盖"cron 没跑"(丢弃/60 天停用)→ 配**每月人工核对 Actions 历史**(命名周期)的 runbook 步;心跳告警(healthchecks.io / CloudMonitor)列为可选增强、不强制(避免新依赖)。

## 风险 / 权衡

- **(a) 情形下 daily 留最长 ~24h 冷窗口** → 缓解:起步 12h 间隔 + (a)/(b) 实测定稿;本质是 best-effort,spec 已不承诺消除。
- **query 键不被预热当缓存键(go/no-go 失败)** → 缓解:上线前实测门;失败则改 `RefreshObjectCaches`/路径级或弃此 approach,不带病上线。
- **Aliyun AK 落 GitHub** → 缓解:最小权限 RAM(仅 `cdn:PushObjectCache`)、密文、不入库;爆炸半径仅"能预热该域名"。要不外放则迁 Aliyun-native(非目标)。
- **schedule 60 天自动停 / cron 丢弃,静默失去预热** → 缓解:非整点 cron + `workflow_dispatch` + 每月人工核对 runbook;心跳为可选增强。
- **URL 清单与端上漂移**(`PAGE_SIZE`/cohort 变更未同步)→ 缓解:注释钉死同 `buildRankingsUrl`;漏热仅自愈 fetch、非故障。
- **PushTaskId 异步,受理≠已热** → 缓解:验收以下次 HIT(避开自造 HIT)为准,非以调用返回成功为准。
