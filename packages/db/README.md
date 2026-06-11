# @unit-price/db

商品库持久层：Drizzle schema（sqlite 方言）+ 类型化 repository + 迁移。把 `@unit-price/core` 产出的领域对象（`RawProduct` / `ParsedSpec` / `CalcResult`）落库，落库前后均过 core 的 Zod schema 校验。

表：`product_raw` / `product` / `unit_price` / `corrections`。表清单与设计的 SOT 见 [`docs/architecture.md`](../../docs/architecture.md) §五；`comparison_group` 不物化（对比组改动态查询，见 [`docs/taxonomy-and-tagging.md`](../../docs/taxonomy-and-tagging.md) §九）。

schema 只用 SQLite↔Postgres 可移植类型（TEXT id / JSON-text / 整数分 / REAL / epoch INTEGER；禁用原生数组、`jsonb`、`serial`、`numeric`），撑爆 D1 时可平滑迁 Postgres。

## 连接约定

repository 不自取连接——`createDb()` 接受**注入连接**，缺失/打不开时抛错（不会返回看似可用的空实例）：

| 环境 | 连接 | 说明 |
| --- | --- | --- |
| 生产 | Cloudflare D1 binding | 由 Worker 注入（wrangler 的 binding 声明归 `public-deploy` 变更）；迁移经 wrangler 对 binding 应用 |
| 本地开发 | SQLite 文件 | `drizzle-kit` 读 `DB_FILE` 环境变量，默认 `file:./.local/dev.sqlite`（gitignore，见 `.local/`） |
| 测试 | in-memory SQLite | `better-sqlite3` 的 `:memory:` 库，测试基座自建（见下） |

```ts
import Database from 'better-sqlite3';
import { createDb, createRepository } from '@unit-price/db';

const db = createDb(new Database('.local/dev.sqlite')); // 或 createDb(env.DB) — D1 binding
const repo = createRepository(db);
```

## 迁移

```sh
mkdir -p packages/db/.local             # .local/ 已 gitignore，fresh clone 不存在，drizzle-kit 不自建目录
pnpm --filter @unit-price/db generate   # schema → drizzle/ 生成迁移 SQL
pnpm --filter @unit-price/db migrate    # 对 DB_FILE 指向的本地库应用迁移
```

幂等由 migration journal（`__drizzle_migrations`）保证：重复 `migrate` 跳过已应用项。生成的 SQL 是裸 `CREATE TABLE`（非 `IF NOT EXISTS`），不要绕过 journal 重放同一 SQL 文件。

#### `dedupe_key` 列迁移：空表是唯一自动支持路径

`product.dedupe_key`（`NOT NULL` 无 DEFAULT）+ 唯一索引迁移的迁移路径：

- **空表 = 唯一自动支持路径**：SQLite 对空表加 `NOT NULL` 无 DEFAULT 列 + `CREATE UNIQUE INDEX` 直接成功（生产整体删重录、测试 harness 用空 `:memory:` 库），无回填、无唯一索引撞重复。
- **非空旧库（本地已有数据、可能含等价重复行）= 不自动支持**：SQLite 拒绝对非空表加 `NOT NULL` 无 DEFAULT 列，且回填后唯一索引会撞重复值。处置二选一：
  - **(a)** 直接 drop & re-migrate（最简，本地数据无价值）；或
  - **(b)** 先跑可选清理脚本 `DB_FILE=<path> pnpm --filter @unit-price/db dedupe:cleanup`（应用层算键去重、保留每键最老一行，含 `--dry-run`，见 `scripts/dedupe-cleanup.ts`）→ 再应用列+约束迁移。

清理脚本**不**纳入 `deploy.yml` 自动路径——生产整体删重录。

`drizzle-kit migrate` 只治理**本地** SQLite 文件，**禁止**对生产/preview D1 执行——它查无自己的 journal 会从 `0000` 重放裸 `CREATE TABLE`、撞「table already exists」。生产/preview 迁移一律走 wrangler，见下。

### 生产 / preview 迁移（Cloudflare D1）

生产与 preview D1 的迁移经 wrangler 对 binding 执行，**不**走 `drizzle-kit migrate`：

```sh
wrangler d1 migrations apply DB --env production --remote --config apps/api/wrangler.toml
wrangler d1 migrations apply DB --env preview    --remote --config apps/api/wrangler.toml
```

- wrangler 直接应用 drizzle-kit 在 `drizzle/` 生成的同一批 SQL（文件名 `0000_*.sql`，数字前缀与 wrangler 有序命名兼容）。`apps/api/wrangler.toml` 的 `[[d1_databases]]` 内 `migrations_dir` 指向该目录（`../../packages/db/drizzle`，按 `wrangler.toml` 所在目录解析）。
- 所有 `wrangler` 调用（本地与 CI）必须显式 `--config apps/api/wrangler.toml`（或以 `apps/api/` 为工作目录），否则 `migrations_dir` 的 `../../` 命不中本目录。
- 幂等由 wrangler 自有的 `d1_migrations` 跟踪表保证：已应用的迁移被跳过、不重放 `CREATE TABLE`。这与本地 drizzle journal `__drizzle_migrations` **互不相交**——后者只在本地 SQLite，生产 D1 上 drizzle journal 从不存在。
- 部署流程把迁移作为显式步骤（push 到 `main` 时 build → 生产 D1 `migrations apply` → `deploy`，见 `.github/workflows/deploy.yml`），非应用启动时隐式建表。CI 一个 guard 作业确认无 `drizzle-kit migrate` 指向生产/preview binding。
- 半完成态：单次 apply 多条 `CREATE TABLE` 中途失败（D1 DDL 非完整事务）会留半建 schema 且 wrangler 未标记已应用，直接重跑会撞表——恢复为手动介入（清理半建对象后重跑）。

## 测试

`pnpm --filter @unit-price/db test` 全程 in-memory SQLite，不需要任何外部数据库。D1 平台语义（batch 原子、拒绝显式 BEGIN、强制 FK）另由 miniflare/workerd 的真运行时测试覆盖（`d1-workerd.test.ts`），同样不需要任何外部数据库。测试基座（`src/__tests__/harness.ts`）会显式 `PRAGMA foreign_keys = ON`——裸 SQLite 默认关 FK、驱动行为可能随版本/换型漂移，显式开与 D1 强制 FK 对齐，否则 FK 回滚断言会假绿。
