## 0. 上线前实测两项未文档化行为(go/no-go,先于实现定稿)

- [x] 0.1 **query 键被预热当缓存键 = 已实测确认 PASS**(2026-06-24):对唯一探针键 `…/rankings?limit=20&offset=0&_warm=p472030751`(push 前确认 MISS)调 `PushObjectCache`(全 URL 含 scheme 形态,返回 `PushTaskId`),~2min 后首次 `curl` 该精确键 → `X-Cache: HIT`、`Age=127`(≈距 push 时长,证明预热灌入、非自造);对照键(不同 `_warm`、从未 push)仍 `MISS`。**结论:`PushObjectCache --ObjectPath 'https://域名/路径?query'`(含 scheme)会把精确 query 串当缓存键灌入国内 POP**。ObjectPath 形态 = 全 URL 含 scheme。
- [ ] 0.2 **预热对仍新鲜对象 (a) no-op 还是 (b) 重置 TTL**:预热某 URL 灌入后,在其 TTL(86400s)**临到期前**(如 T+23h)再预热一次,然后 `curl -D -` 看 `Age` 是否回落到 ~0((b),重置)还是继续逼近 86400 后转 MISS((a),no-op)。据此定频率:(b) → 每天一次够;(a) → 间隔取可容忍冷窗口(起步 12h)。

## 1. 定时预热 workflow

- [x] 1.1 新建 `.github/workflows/cdn-warm.yml`:
  - **触发**:`on.schedule` cron **非整点 12h 两次** `17 8,20 * * *`(=16:17/04:17 北京;实测 0.2=(b) 后可回落每天一次)+ `workflow_dispatch`。
  - **最小权限/并发**:顶层 `permissions: {}`(仅调外部 API、不读仓库;若需 checkout 则 `contents: read`)+ `concurrency` group `cancel-in-progress: false`(避免 schedule 与 dispatch 叠跑重复 push)。
  - **步骤**:装 **pin 到具体版本 + sha256 校验**的 `aliyun` CLI(**禁** `-latest-`,版本号记入 workflow)→ `aliyun configure set --mode AK … --region cn-hangzhou`(读 secret;CDN 是 center endpoint、不按 region 路由,但 CLI 签名**需非空 region**——region-less AK profile 报 `region can't be empty`,故 **必带** `--region cn-hangzhou`,**禁**写成"可省")→ **逐 URL** `timeout 60 aliyun cdn PushObjectCache --ObjectPath "$u"`(**每调用包 `timeout 60`**:挂起→SIGTERM→非零→被守卫接住,防一个挂起卡死整循环/空耗 job timeout),用 **`if !`/`push || { fail++; continue; }`** 守卫——**禁裸命令**(`set -euo pipefail` 下裸命令首个失败即中断整循环、毁掉 per-URL 隔离);每 URL **一次有界重试**(瞬态 throttle/5xx:`sleep 2` 后重试一次再计 `fail`,让 `fail` 只记真故障、避免 region-wide 瞬态误触全失败门);记 `PushTaskId`(部分失败隔离)。**脚本末尾若全失败(`fail==total`)→ `exit 1`**(全失败必须红——防 AK 过期 / RAM 撤权 / CLI 变更下 job 静默变绿)。**禁** `set -x` / `echo` AK 环绕 configure。
- [x] 1.2 预热 URL 清单 = **landing + /categories + 全部 rankable cohort**(共 17 条;纳入谓词 = `rankable = (继承解析后 comparableUnit !== null)` 即分类树可点达节点,**含**非叶 `soft-drink`/`dairy`、**排除**非 rankable 的 `beverage`/`alcohol` 父):
  - `https://unit-price.herbert-dev.cn/rankings?limit=20&offset=0`(落地,无 category)
  - `https://unit-price.herbert-dev.cn/categories`
  - `…/rankings?limit=20&offset=0&category=<slug>`,`<slug>` ∈ 字面英文 slug **`soft-drink, carbonated, juice-plant, coffee-tea, drinking-water, dairy, milk, yogurt, lactic-drink, baijiu, wine, spirits, whisky, beer, sake-fruit-wine`**(15 个;**禁**中文标签 → 服务端 400)。
  - 注:**含 `category=soft-drink`**——它与落地无-category 键**同 body 但不同 CDN 键**(分类树下钻软饮发的是带 `category` 的键),须各自预热。发参顺序 `limit→offset→category` 同 `buildRankingsUrl`;`PAGE_SIZE` / cohort 变更须**手动同步**此列表(对照 `packages/db/src/seed.ts` rankable 集),新增 cohort 未同步前其 board 自愈(非目标:不动态枚举)。
- [x] 1.3 用 0.1 实测确认的 `ObjectPath` 形态(含/不含 scheme)**逐 URL** 调用(保留 per-URL 成败粒度 + task-id);**不**用 `\n` 批量(会丢 per-URL 粒度与计数)。

## 2. 凭据(运维,最小权限)

- [ ] 2.1 阿里云建 RAM 子账号,附**仅 `cdn:PushObjectCache`** 的自定义策略,记录策略 JSON(`{"Statement":[{"Effect":"Allow","Action":["cdn:PushObjectCache"],"Resource":"*"}],"Version":"1"}`),生成 AK(非主账号)。
- [ ] 2.2 GH repo secrets 加 `ALIYUN_ACCESS_KEY_ID` / `ALIYUN_ACCESS_KEY_SECRET`(密文,不入库)。

## 3. 验收与存活

- [x] 3.1 `workflow_dispatch` 实跑(run 28094322674)= **success**:Configure 步 `--region cn-hangzhou` 无 region 报错(DOA 风险确认关闭)、17 个 URL 逐个返 `PushTaskId`、全失败门未触发。
- [x] 3.2 **真正热度门已验**:push 过的 cohort 键(soft-drink/baijiu 等,本会话此前未 curl)实测 `X-Cache: HIT TCP_MEM_HIT`、`total ~40ms`、`max-age=86400`;对照"从未 push 的全新键"= MISS、`~1.7s`(~40×)。受理→真实热度确认(闭 CLI-acceptance≠warmth)。首见 `Age+MISS` 是 L1 从已暖 L2 域内填充、非跨境。
- [x] 3.3 **存活 runbook(记录,长期执行)**:GH `schedule` 仓库 60 天无活动自动停 + cron 漏跑不告警 → **每月人工核对 Actions 历史** + `workflow_dispatch` 兜底;(可选)healthchecks.io/CloudMonitor 心跳。属持续运维实践、随 cron 生命周期执行。
- [ ] 0.2(可选频率调优,非阻塞):某热 URL 灌入后 ~24h 看 `Age` 是否重置定 (a)/(b) → 决定 12h 是否回落每天;现 12h 为已验证可工作的保守默认。
