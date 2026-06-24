## 新增需求

### 需求:公共读边缘缓存应由定时预热尽量保持热(best-effort,缩小而非消除冷窗口)

公共读端点(`GET /rankings` 非搜索成功响应、`GET /categories`)的国内边缘缓存**应**由一个周期性主动预热任务尽量保持热,以**缩小**——**而非消除**——TTL 到期 / POP LRU 驱逐后首个真实用户吃一次跨境回源冷 MISS(实测 ~5–7s)的窗口。这是 best-effort 优化,**禁止**写成"永不冷"的保证:边缘对象在 LRU 驱逐或自然到期后、到下一次成功预热前仍可能冷;预热把该冷窗口的上界**在调度成功时**压到约等于预热间隔(cron 被跳过/延迟则更长——估计而非保证)。各条**必须**满足:

- **灌入机制**:该域名 domestic scope(仅服务国内 POP),预热**必须**用阿里云 `PushObjectCache`(由阿里云发起回源、灌入国内 POP);**禁止**用海外机器 `curl` 充当预热(热不到国内 POP)。
- **预热目标 = landing + `/categories` + 全部 rankable cohort 的字面 slug 键**:纳入谓词**必须**是 `rankable = comparableUnit !== null`(即分类树可点达节点,**含**非叶 `soft-drink`/`dairy`,**排除**非 rankable 的 `beverage`/`alcohol` 父),**禁止**用"叶性"判据(漏掉可点达的非叶 cohort)。`category` slug **必须**用字面英文(`soft-drink`/`carbonated`/`juice-plant`/`coffee-tea`/`drinking-water`/`dairy`/`milk`/`yogurt`/`lactic-drink`/`baijiu`/`wine`/`spirits`/`whisky`/`beer`/`sake-fruit-wine`),**禁止**中文标签(→服务端 400)。发参顺序**必须**同 `buildRankingsUrl`(`limit→offset→category`)。`category=soft-drink` **必须**单列预热——它与落地无-category 键**同 body 但不同 CDN 键**(下钻软饮发带 `category` 键);**禁止**以"落地已覆盖"为由漏掉它或任一可点达 cohort。
- **形态与 query 键经实测确认(go/no-go)**:`PushObjectCache` 的 `ObjectPath` 形态(含/不含 scheme)与"query 串是否被当作预热缓存键"在官方文档**未明确**;**必须先实测确认**——预热某带 query 的 URL 后,从国内视角确认**该精确 query 键** `X-Cache: HIT`(且 HIT 非由探测本身的 `curl` 造成)。未确认前**禁止**依赖该机制上线。
- **频率 ≤ 边缘 TTL,且其充分性经实测**:间隔**必须** ≤ 边缘 TTL(当前 1 天)。"预热是否刷新**仍新鲜**对象的 TTL"官方未文档化,**必须实测判定**:(a) 预热只回源补**已过期/驱逐**对象(则冷窗口 ≈ 预热间隔,频率须按可容忍窗口设、通常 < TTL 有余量)还是 (b) 预热总是回源并重置 TTL(则任一 < TTL 间隔即保持常热);**禁止**在实测前断言 (b)("daily 即永不过期")。
- **凭据最小权限 + 失败隔离 + 每 URL 独立 + 全失败可见**:**必须**用仅授 `cdn:PushObjectCache` 的 RAM 子账号 AK(附策略 JSON)、密文注入、非主账号、不入库;某 URL 预热失败**必须**不影响线上(仅退化为该 URL 下个用户吃一次自愈回源);**必须逐 URL 独立尝试**(一个失败不漏其余)并记录返回的 task id(注:`PushObjectCache` 异步排队,返回成功=已受理≠已热,真正热度以下次 HIT 为准);但**全部 URL 失败时任务必须以非零退出可见**——**禁止** `||continue` 吞错致 job 静默变绿(AK 过期 / RAM 撤权 / CLI 变更下尤甚)。
- **存活可核对**:GH `schedule` 在仓库 60 天无活动后会被自动停用、且 cron 漏跑时 GH 不主动告警;**必须**有**命名周期的人工核对**(如每月查 Actions 运行历史)或更强的成功心跳告警,确认预热仍在跑——**禁止**把"仓库活跃"当作存活保证、**禁止**用无周期的"定期"措辞。

#### 场景:定时预热缩小(而非消除)冷窗口

- **当** 周期性预热任务触发并对各热 URL 调 `PushObjectCache`
- **那么** 国内 POP 在 TTL 到期 / 驱逐后由下次成功预热重新灌入,**调度成功时**冷 MISS 窗口 ≈ ≤ 预热间隔;**禁止**断言"首个用户永不吃冷 MISS"或"窗口必 ≤ 间隔"——GH cron 可被跳过/延迟、LRU 驱逐亦可发生,故窗口可能**超过**一个间隔,是 best-effort 上界估计而非保证

#### 场景:domestic scope 下只认 PushObjectCache

- **当** 预热实现选择把内容灌进国内 POP 的机制
- **那么** **必须**用 `PushObjectCache`;**禁止**用海外 `curl`(domestic-scope 域热不到国内 POP)

#### 场景:预热目标覆盖全部 rankable cohort 的字面 slug 键

- **当** 编排预热 URL 清单
- **那么** **必须**覆盖 landing + `/categories` + **每个** rankable cohort(`comparableUnit !== null`,含非叶 `soft-drink`/`dairy`)的字面英文 slug 键,发参顺序同 `buildRankingsUrl`;**禁止**用中文标签(→服务端 400)、**禁止**漏掉 `category=soft-drink`(下钻键,异于落地无-category 键)或任一可点达 cohort

#### 场景:上线前实测两项未文档化行为(go/no-go)

- **当** 准备依赖"预热精确 query 键"和"频率充分性"
- **那么** **必须**先实测:① 预热带 query 的 URL 后该精确键 `X-Cache: HIT`(非探测 curl 自造);② 判定预热对仍新鲜对象是 no-op (a) 还是重置 TTL (b),据此定频率;两项未过**禁止**上线依赖

#### 场景:凭据最小权限、失败隔离、存活可核对

- **当** 预热任务运行(含某 URL 调用失败 / **全部 URL 失败** / 某次整体漏跑 / cron 被 60 天规则停用)
- **那么** 凭据**必须**仅 `cdn:PushObjectCache`;单 URL 失败**必须**不影响线上(退化为自愈回源)、逐 URL 独立尝试并记 task id;**全部 URL 失败时任务必须以非零退出可见**(禁止 `||continue` 吞错致静默变绿);**必须**有每月人工核对或心跳确认 cron 存活,**禁止**仅依赖 GH 默认通知(它不覆盖"cron 没跑"这一最可能的静默失败)
