# Taxonomy Backfill 运维 Runbook

## 目的

首次部署后,对**生产存量商品**跑 Taxonomy 打标签 backfill:经打标签管线产出品类归属(叶 `product_tag` / `pending_category_tag_id`)、重算 `rankable`、补 `category_closure` 命中。该入口为可重复驱动的受控运维端点,**不重放 `/ingest`**。

## 前置

1. **代码已合并 main 并自动部署**:GH Actions 在 push 到 main 时自动 migrate + deploy prod。
2. **设两个独立 secret**(经 `wrangler secret put`,不写进仓库 / 不写进 `wrangler.toml`):

   ```sh
   # admin 端点鉴权凭据(逗号分隔多 key);与公共 API_KEYS 分离。
   wrangler secret put ADMIN_API_KEYS

   # 审计日志 keyed 哈希的 keying 输入;必须与 ADMIN_API_KEYS 不同源。
   wrangler secret put AUDIT_LOG_HMAC_SECRET
   ```

   `ADMIN_API_KEYS` 未配 / 空 → admin 端点 fail-closed 返回 `500 config-error`、不驱动 backfill。

## 驱动

以脚本循环 `POST https://<api-域>/admin/backfill` 带 `Authorization: Bearer <admin-key>`:

- `limit` **省略即可**(服务端注入默认有界 limit、恒走 keyset 分块)。
- 每次响应取 `nextCursor`,作下次 `?cursor=<nextCursor>` 入参;首次不带 `cursor`。
- 循环直到 `nextCursor` 为 `null`。

示例 shell 循环(curl + jq):

```sh
API="https://<api-域>"
KEY="<admin-key>"
cursor=""

while :; do
  if [ -z "$cursor" ]; then
    url="$API/admin/backfill"
  else
    url="$API/admin/backfill?cursor=$cursor"
  fi

  resp=$(curl -sS -X POST "$url" -H "Authorization: Bearer $KEY")
  echo "$resp"

  cursor=$(echo "$resp" | jq -r '.nextCursor')
  if [ "$cursor" = "null" ]; then
    echo "backfill 完成:nextCursor=null"
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
{ "total": …, "classified": …, "pending": …, "manual": …, "rankable": …, "nextCursor": … }
```

只回计数 + `nextCursor`,**不含逐商品明细**(`nextCursor` 为 `null` 表示已耗尽)。

## 归档前(运维项)

- 确认**首轮 backfill 已实跑**并达成上面的覆盖判据(游标推进到 `nextCursor=null` 且覆盖每个快照 id ≥ 一次)。
- **记录** backfill 前后 `manual`(待人工)绝对计数作**观测项**——非门:tier1 对某批恰好全不命中时 `manual` 可能持平而逻辑仍正确,门只是覆盖判据。

## 安全注

- admin 端点走独立 `ADMIN_API_KEYS` 鉴权(与公共 `API_KEYS` 分离),**不纳入公共限频**(不消耗公共 60/60s 窗口、不写公共 `rl:` / `usage:` 槽)。
- 审计日志以 keyed 哈希(`HMAC-SHA256(key, AUDIT_LOG_HMAC_SECRET)` 定长截断)记 key,**不落原文**、无前缀子串。
