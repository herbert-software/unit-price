# Taxonomy Backfill 运维 Runbook

## 目的

首次部署后,对**生产存量商品**跑 Taxonomy 打标签 backfill:经打标签管线产出品类归属(叶 `product_tag` / `pending_category_tag_id`)、重算 `rankable`、补 `category_closure` 命中。该入口为可重复驱动的受控运维端点,**不重放 `/ingest`**。

## 两类回填(勿混)

本 runbook 涉及**两种不同**的"回填",二者**都不重放 `/ingest`**(遵 [[ingest-write-once-needs-backfill]]:`/ingest`/`upsertRaw` 是 first-write-wins、且会把 title/price 覆写为重放观测、触发后台解析),但机制与产物不同:

1. **打标签 backfill(`runBackfill` / `POST /admin/backfill`)= 重读列再打标签**。它**不写 `product_raw`**:只**读**既有 `product_raw`(title + store + `native_category_id`)经打标签管线**重新计算**品类归属,写 `product_tag` / `pending_category_tag_id` / `rankable` / `category_closure`。幂等、可重复驱动(本文「驱动」节)。native-id 接通后,`native_category_id` 非空的行经此入口由 store-map 重分类。

2. **native-id 回填 = 单独的 native-id-only `UPDATE` 步骤**(不经 admin 端点)。存量 ~376 行当初仅采标题/价格、`native_category_id` 为 null;经山姆 HAR 提取器抽每条 `(store, storeSku, categoryIdList 叶 id)`,产出幂等 SQL,用 `wrangler d1 execute` 对既有行做 **`UPDATE product_raw SET native_category_id = COALESCE(...)`**——**只补 `native_category_id` 一列、不碰 title/price、不触发解析、不新增 admin 路由**(见下「native-id-only UPDATE 回填」节)。

**先后顺序**:先做 ② native-id 回填(把 native 列灌进存量),再做 ① 打标签 backfill(让 store-map 在已落 native-id 的行上点火重分类)。

## 前置

1. **代码已合并 main 并自动部署**:GH Actions 在 push 到 main 时自动 migrate + deploy prod。
2. **设两个独立 secret**(不写进仓库 / 不写进 `wrangler.toml`)。两值都用**强随机**(低熵 key 可被离线爆破),且**互不相同**:

   生产 Worker 是 `wrangler.toml` 的 `[env.production]` 环境,故 `wrangler secret put` **必须带 `--env production`**——否则会设到顶层 dev(`unit-price-dev`)、prod 仍未配。从 `apps/api/` 跑(wrangler 在 cwd 找 `wrangler.toml`):

   ```sh
   cd apps/api

   # admin 端点鉴权凭据(逗号分隔多 key);与公共 API_KEYS 分离。
   openssl rand -hex 32                       # 生成强随机值,记下来(驱动时作 Bearer token)
   npx wrangler secret put ADMIN_API_KEYS --env production         # 粘上面的值

   # 审计日志 keyed 哈希的 keying 输入;必须与 ADMIN_API_KEYS【不同源】。
   openssl rand -hex 32                       # 另生成一个不同的强随机值
   npx wrangler secret put AUDIT_LOG_HMAC_SECRET --env production  # 粘这个值
   ```

   wrangler 需先 `wrangler login`(或设 `CLOUDFLARE_API_TOKEN`)。**替代:** Cloudflare 控制台 → Workers & Pages → `unit-price-api`(production)→ Settings → Variables and Secrets → 加两个加密 secret(免本地登录)。

   - `ADMIN_API_KEYS` 未配 / 空 → admin 端点 fail-closed 返回 `500 config-error`、不驱动 backfill。
   - `AUDIT_LOG_HMAC_SECRET` 未配 / 空 → 同样 fail-closed `500 config-error`(审计 keying 必需、不以弱常量盐降级运行)。**两个都设好前端点都会 500,这是设计、非故障。**

## 驱动

以脚本循环 `POST https://<api-域>/admin/backfill` 带 `Authorization: Bearer <admin-key>`:

- `limit` **省略即可**(服务端注入默认有界 limit、恒走 keyset 分块)。
- 每次响应取 `nextCursor`,作下次 `?cursor=<nextCursor>` 入参;首次不带 `cursor`。
- 循环直到 `nextCursor` 为 `null`。

示例 shell 循环(curl + jq)。**zsh 注意**:`KEY`/`API` 用**单引号**赋值——双引号下 key/URL 里的 `!` 会触发 zsh 历史展开报 `zsh: event not found`;`set +H` 再加一道保险(或直接把本段存成文件用 `bash 文件` 跑,脚本文件不做历史展开):

```sh
set +H                              # 关闭 zsh ! 历史展开(双保险)
API='https://<api-域>'              # 单引号:URL 含 ! 也安全
KEY='<admin-key>'                   # 单引号:key 含 ! 也安全
cursor=''

while :; do
  if [ -z "$cursor" ]; then
    url="$API/admin/backfill"
  else
    url="$API/admin/backfill?cursor=$cursor"
  fi

  resp=$(curl -sS -X POST "$url" -H "Authorization: Bearer $KEY")
  echo "$resp"

  cursor=$(echo "$resp" | jq -r '.nextCursor')
  if [ "$cursor" = 'null' ]; then
    echo 'backfill 完成:nextCursor=null'
    break
  fi
done
```

## 完成判据(机械)

- 游标**单调推进**到 `nextCursor=null`。
- 累计处理覆盖 bootstrap 起始快照存量的**每个 product id 至少一次**。
- 续跑期间并发 `/ingest` 新落的行落入**下一轮 sweep**、不计入本轮分母。
- **注**:存量恰为 `limit` 整数倍时,末尾会观测到一次 `total:0` 且 `nextCursor=null` 的空读——这是**正常终止信号、非错误**。

## 响应字段

```json
{ "total": …, "classified": …, "pending": …, "manual": …, "rankable": …, "storeMapDecisions": …, "nextCursor": … }
```

只回计数 + `nextCursor`,**不含逐商品明细**(`nextCursor` 为 `null` 表示已耗尽)。

- `storeMapDecisions`:本块内由 **store-map 定叶**(`decidedBy=store-map` — store-map 叶**异于** tier1 叶,或 tier1-miss 由 store-map 叶兜住)的决定数。按设计**不含**同叶认同(记 tier1)与粗 native(落 pending),故 `>0` 即证 store-map 在主动定叶。**backfill 分块续跑,门值须跨所有块累加**——单块响应非全量;判 6.3「store-map 决定数 > 0」门时把各块 `storeMapDecisions` 相加。

## 归档前(运维项)

- 确认**首轮 backfill 已实跑**并达成上面的覆盖判据(游标推进到 `nextCursor=null` 且覆盖每个快照 id ≥ 一次)。
- **记录** backfill 前后 `manual`(待人工)绝对计数作**观测项**——非门:tier1 对某批恰好全不命中时 `manual` 可能持平而逻辑仍正确,门只是覆盖判据。

## native-id-only UPDATE 回填 + 重跑 backfill + 精度抽样

存量行的 native-id 接通流程(上面「两类回填」的 ②→① 串联 + 验收),全程**不重放 `/ingest`**:

### ① 先验 join-rate(必做,非默认成立)

回填命中依赖 HAR 提取器抽的 `(store, storeSku)` 与既有 `product_raw` 行键一致;若不一致,`UPDATE` **0 命中**、本步收益落空。**批量 UPDATE 前**先做一次**只读** join-rate 校验(抽取键 ∩ 既有 `product_raw` 命中率)。命中率过低**先查 key 口径**(storeSku 应与当初 ingest 落库去重键同源)、**勿盲灌**。漏配行 `native_category_id` 留 null(退化 tier1、不回退、不损坏)。

### ② native-id-only `UPDATE` 回填

HAR 提取器抽存量每条 `(store, storeSku, categoryIdList 叶 id)`,产出**幂等 SQL 文件**,每行形如:

```sql
UPDATE product_raw SET native_category_id = COALESCE(native_category_id, '<nativeId>') WHERE store='<s>' AND store_sku='<sku>';
```

`COALESCE` **只补空**(保留已有 native_category_id[如前向 ingest 已写],仅填 null 行)。对 prod 执行:

```sh
wrangler d1 execute DB --env production --remote --config apps/api/wrangler.toml --file <生成.sql>
```

`--config` **必带**(否则从仓根解析不到 `DB` 绑定)。此步**只动 `native_category_id` 列、不碰 title/price、不触发解析、不新增 admin 路由、不走 `/ingest`**;`d1 execute` 不被部署守卫 `check-no-prod-drizzle-migrate.sh` 拦(它只拦 `drizzle-kit migrate`)。

### ③ 重跑打标签 backfill

native-id 已落后,按本文「驱动」节重跑 `POST /admin/backfill`(幂等):`native_category_id` 非空的行经 store-map 重分类,归属变化重算 `rankable`(既有契约)。读响应的 `storeMapDecisions`(**跨所有续跑块累加**)确认 store-map 在主动定叶(`>0`)。

### ④ store-map 精度抽样(必做)

仲裁反转后(native 叶 ≻ tier1 叶),一行错 map 会压过本来分对的 tier1 叶,blast radius 增大,故精度抽样是回填验收**必做项**、非可选。**离线判定**(`product_tag.source` 只存终态、反推不出 tier1 本会判什么):离线重放 `tagTier1Leaf(title)` + `lookupStoreCategory(store, nativeId)`,筛 `tier1.leaf != storeMap.leafSlug ∧ 两者皆非空`(= 被 store-map 改写的 tier1 叶)的样本 → **人工**核对其标题语义 / 山姆自身展示分类与 store-map 落叶是否一致。出现 tier1-对→store-map-错 = **blocker**:回滚该 `SAM_CATEGORY_MAP` 行后再宣告成功。(eval-harness 当前无 native 叶真值字段[corpus 只有 `samPkgNum`、无 `samCategoryLeafId`],本期门用人工抽样、不依赖尚不存在的自动评测。)

## 数据更新后:刷新 CDN(长 TTL 的配套,必做)

公共读端点 `/rankings`、`/categories` 的 `Cache-Control` 是 **`public, max-age=86400`(1 天)**(`apps/api/src/routes.ts` 的 `PUBLIC_CACHE_CONTROL`)。长 TTL 是为了让国内访问命中阿里云 POP、绕开跨境回源——代价是**任何改了 prod 数据的操作(`/ingest` 新批次、临时优惠、本文的 backfill / native-id 回填)生效前,边缘还会按旧缓存服务,最多 1 天**。

数据变更后**主动刷新阿里云 CDN**让其立即生效(否则只能等 TTL 自然过期)。**两个端点 ObjectType 不同**(`/rankings` 有 `?limit/offset/category` 等 query 变体、`/categories` 无 query):

- `/rankings` 用**目录(Directory)**刷新,一刀覆盖全部 query 变体:
  `aliyun cdn RefreshObjectCaches --ObjectPath 'https://unit-price.herbert-dev.cn/rankings' --ObjectType Directory`
- `/categories` 用 **URL(File)**刷新该精确地址(它无 query,目录型反而刷不到这个精确文件):
  `aliyun cdn RefreshObjectCaches --ObjectPath 'https://unit-price.herbert-dev.cn/categories' --ObjectType File`
- 控制台等价:`/rankings` 选"目录"、`/categories` 选"URL"。

**刷新后预热(建议,且必须预热客户端真实请求的精确 URL)**:单次回源跨境要 ~3–7s(实测 TTFB,POP→海外 CF/D1),purge 后**第一个真实用户会吃满这一跳**。CDN **按完整 query 串分键**,所以**必须预热小程序逐字节实际发的 URL**——榜单落地 Tab 调 `useRankings()` **不带 category**、发的是 `/rankings?limit=20&offset=0`(**不是** `?category=soft-drink`),预热错键等于没热。用 `PushObjectCache`(或直接 `curl`)逐条预热:

- 落地榜:`https://unit-price.herbert-dev.cn/rankings?limit=20&offset=0`
- 各 category-scoped 榜(用户从品类树下钻会发的):`…/rankings?limit=20&offset=0&category=<slug>`(soft-drink/乳品/酒种各叶)。**发参顺序必须与 `buildRankingsUrl` 一致(`limit→offset→category`)**——CDN 按原始 query 串分键,顺序错即键错、等于没热
- 品类树:`https://unit-price.herbert-dev.cn/categories`

(`limit`/`offset` 必须与端上 `PAGE_SIZE=20`、首页 `offset=0` 一致;改了 `PAGE_SIZE` 这里同步改。)命中后 total 降到 ~50ms。

**遵循源站(部署/依赖前必复验)**:长 TTL 生效的前置是阿里云 CDN **遵循源站 `Cache-Control`**(不以自有 TTL 规则覆盖)。当前实测满足(无自定义 TTL 规则;二次请求 `X-Cache: HIT`),但这是**控制台活配置、仓库管不住**——任何人加一条自定义 TTL/忽略源站规则就会静默让 86400 失效。故**不是一次性"已确认无需配置"**:每次依赖长 TTL 前、以及改动该域名 CDN 配置后,`curl -D - 'https://unit-price.herbert-dev.cn/rankings?category=soft-drink'` 看二次请求 `X-Cache` 是否 `HIT` 且 `Cache-Control` 透传为 `max-age=86400`,不满足说明源站头被覆盖、需到控制台修。`no-store`(搜索 `?q=`、`/compute`)不受影响、永不被缓存。

## 安全注

- admin 端点走独立 `ADMIN_API_KEYS` 鉴权(与公共 `API_KEYS` 分离),**不纳入公共限频**(不消耗公共 60/60s 窗口、不写公共 `rl:` / `usage:` 槽)。
- 审计日志以 keyed 哈希(`HMAC-SHA256(key, AUDIT_LOG_HMAC_SECRET)` 定长截断)记 key,**不落原文**、无前缀子串。
