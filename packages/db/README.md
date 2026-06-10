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

## 测试

`pnpm --filter @unit-price/db test` 全程 in-memory SQLite，不需要任何外部数据库。D1 平台语义（batch 原子、拒绝显式 BEGIN、强制 FK）另由 miniflare/workerd 的真运行时测试覆盖（`d1-workerd.test.ts`），同样不需要任何外部数据库。测试基座（`src/__tests__/harness.ts`）会显式 `PRAGMA foreign_keys = ON`——裸 SQLite 默认关 FK、驱动行为可能随版本/换型漂移，显式开与 D1 强制 FK 对齐，否则 FK 回滚断言会假绿。
