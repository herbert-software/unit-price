## 为什么

长 TTL([[extend-public-cache-ttl]])+ 端上 SWR([[add-miniapp-swr-cache]])把冷尾**遮**住了,但没**消除**:边缘对象 TTL 到期(约每天)或低流量下被 POP LRU 驱逐后,**下一个真实用户仍吃一次跨境回源 ~5–7s**(实测 MISS TTFB 3–5s)。该域名是 **domestic scope(只服务国内 POP)**,海外 runner `curl` 只热到就近节点、热不到国内 POP——唯一能主动把内容灌进国内 POP 的是阿里云 `PushObjectCache`(预热)API。周期性调 `PushObjectCache` 可在对象过期/被驱逐后尽快重新灌入国内 POP,把那一跳从"首个真实用户"转给预热任务,**缩小**冷窗口。

**这是 best-effort,不是"永不冷"的保证**:LRU 驱逐 + 调度延迟使绝对保证不成立;预热把首个用户吃冷 MISS 的窗口上界压到约等于预热间隔。

## 变更内容

- **新增定时预热 workflow** `.github/workflows/cdn-warm.yml`:`schedule` cron(+ `workflow_dispatch` 手动/重跑兜底)对公共读热 URL 调 `aliyun cdn PushObjectCache`。复用仓库既有 GH Actions,不新搭阿里云服务。
- **预热 URL = landing + `/categories` + 全部 rankable cohort(共 17 条),字面 slug**:纳入谓词 = `rankable = comparableUnit !== null`(即分类树可点达节点,**含**非叶 `soft-drink`/`dairy`、**排除**非 rankable 的 `beverage`/`alcohol` 父)。15 个 cohort slug:`soft-drink, carbonated, juice-plant, coffee-tea, drinking-water, dairy, milk, yogurt, lactic-drink, baijiu, wine, spirits, whisky, beer, sake-fruit-wine`(字面英文,**不用**中文标签→服务端 400;发参序 `limit→offset→category` 同 `buildRankingsUrl`;`PAGE_SIZE`/cohort 变更手动同步)。**含 `category=soft-drink`**——它与落地无-category 键同 body 但**不同 CDN 键**(分类树下钻软饮发的是带 `category` 的键),须各自预热。
- **频率经实测定**:间隔 ≤ 边缘 TTL(1 天)。因"预热是否刷新仍新鲜对象的 TTL"官方未文档化,先按**有余量**的间隔(每 12h、两次,cron `17 8,20 * * *` UTC,见 tasks 1.1)起步;实测确认预热对新鲜对象 (a) no-op / (b) 重置 TTL 后再定稿(若 (b) 则每天一次即够)。
- **凭据**:仅授 `cdn:PushObjectCache` 的**最小权限 RAM 子账号** AK(附策略 JSON),存 GH secret(`ALIYUN_ACCESS_KEY_ID`/`ALIYUN_ACCESS_KEY_SECRET`),**不**用主账号 AK、**不**入库;脚本逐 URL 独立尝试、记 task id、不 `echo` AK。
- **存活**:`workflow_dispatch` 兜底重跑;因 GH `schedule` 仓库 60 天无活动会自动停 + cron 漏跑不主动告警,配**每月人工核对 Actions 历史**(或可选心跳告警)。

## 功能 (Capabilities)

### 新增功能
<!-- 无新增能力。 -->

### 修改功能
- `deployment`: 新增"公共读边缘缓存应由定时预热尽量保持热(best-effort,缩小而非消除冷窗口)"需求——承接既有「长 TTL + 数据变更刷新」契约,补上**与数据变更无关的周期保温**这一面,并钉死 domestic-scope 下不可用 curl、字面 slug、两项未文档化行为的实测门、最小权限凭据、失败隔离与存活核对。与既有"数据变更后预热"应**共用同一 push 脚本/凭据**,避免两套实现。

## 影响

- **CI/运维**:新增 `.github/workflows/cdn-warm.yml`;新增两个 GH secret(RAM 子账号 AK)。
- **无应用代码改动**:不碰 `apps/*`、`packages/*`、不改 TTL 值或 SWR。
- **阿里云侧**:每日 2 次 × 17 URL = ~34 次 `PushObjectCache`/天(默认配额 1000 URL/天、100/次、50 次/秒——≪ 配额)+ 对应回源(由预热任务承担,非用户)。
- **不触合规敏感面**:无抓取/众包数据流变化。

## 非目标

- **不改用 Aliyun-native 调度(函数计算定时触发器 / OOS)**:那样凭据用 RAM 角色留阿里云内、观测更好,但要新搭服务;本期复用 GH Actions。留作备选(若日后需更强存活观测/不外放 AK,迁此)。
- **不做 curl 预热**:domestic scope 下海外 runner curl 热不到国内 POP。
- **不动 TTL 值 / SWR / 任何应用代码**。
- **不做动态枚举 cohort URL**:hardcode **当前全部 rankable cohort(15 个,见变更内容)**——不在 CI 里拉 `/categories` 抽叶动态生成;新增 cohort 须**手动同步**此列表,未同步前其 board 自愈(首个下钻用户吃一次回源)。
- **不在本提案做 `deploy.yml` 部署后预热步**:它会把 deploy 成功与 CDN 预热耦合、且扩大本次评审范围;拆作单独后续(复用同一 push 脚本)。
- **不强制引入心跳告警服务(healthchecks.io / CloudMonitor)**:本期存活观测用 GH 默认通知 + 每月人工核对;心跳为可选增强。
- **不解决跨境回源那一跳本身**:预热只把它从用户转给预热任务;CF 大陆可达性另案。
