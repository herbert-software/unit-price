// Category-tree contract — transport-agnostic single source of truth for
// GET /categories (the store-agnostic category is-a tree the miniapp's "分类树"
// Tab renders). Lives here (NOT in apps/api/src/routes.ts) so `apps/api` and
// every client depend on ONE schema. This module is pure: it defines the Zod
// schema + inferred types ONLY; no network calls (fetch/Taro.request/
// wx.request) and no dependency on any runtime/framework package.
import { z } from 'zod';
import { ComparableUnitSchema } from '@unit-price/core';

/**
 * One node of the category is-a tree in the GET /categories response. The
 * response carries ONLY `kind=category` is-a nodes (no attribute/brand/
 * product_line axes — those have no is-a closure and do not participate in
 * category navigation).
 *
 *  - `slug`: stable ASCII identifier (e.g. `beverage` / `soft-drink` /
 *    `carbonated`); non-empty.
 *  - `name`: Chinese display name (`tag.name`, e.g. `饮料` / `软饮` / `碳酸饮料`);
 *    non-empty.
 *  - `parentSlug`: parent node slug; `null` for the root. Reuses the same
 *    `ComparableUnit` enum the write path / core use (no divergent string set).
 *  - `comparableUnit`: the comparable unit AFTER is-a inheritance resolution
 *    (node's own `comparable_unit`, else the nearest non-empty ancestor; `null`
 *    all the way to root). The soft-drink line, the dairy line, and EACH alcohol
 *    leaf (`白酒`/`葡萄酒`/`洋酒`/`威士忌`/`啤酒`/`清酒果酒`) resolve to `per_100ml`;
 *    the `alcohol` PARENT and root `beverage` resolve to `null`. NEVER the raw
 *    un-inherited column value.
 *  - `rankable`: whether the node ITSELF carries a (resolved) comparable unit
 *    (`comparableUnit !== null`) — equivalently, whether the node is a single
 *    comparable cohort that is clickable into a ranking board. Consumers MUST
 *    decide "is this node clickable into a ranking" by `node.rankable`, NOT by
 *    `rankableCount > 0`: the `alcohol` parent has `rankableCount > 0` (it has
 *    rankable 酒种 leaf descendants) but `rankable=false` and is NOT clickable —
 *    `GET /rankings?category=alcohol` returns `400` (cohort guard). `true` for
 *    soft-drink / its leaves / dairy / its leaves / each alcohol leaf; `false`
 *    for root `beverage` and the `alcohol` parent.
 *  - `rankableCount`: count of rankable members under the node's closure
 *    (non-negative integer). For a `rankable=true` (clickable) node it equals the
 *    basis of `GET /rankings?category=<slug>` for that node. For a `rankable=false`
 *    node (root `beverage` / `alcohol` parent — both rejected by `/rankings` with
 *    `400`) it is an informational branch count of rankable descendants with NO
 *    corresponding board. Orthogonal to `rankable`: the `alcohol` parent is
 *    `rankable=false` yet `rankableCount > 0`.
 */
export const CategoryTreeNodeSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  parentSlug: z.string().min(1).nullable(),
  comparableUnit: ComparableUnitSchema.nullable(),
  rankable: z.boolean(),
  rankableCount: z.number().int().min(0),
});

export type CategoryTreeNode = z.infer<typeof CategoryTreeNodeSchema>;

/**
 * GET /categories response body: `{ nodes: CategoryTreeNode[] }`. An empty
 * `nodes` array is the valid response for an unseeded taxonomy (DB connected but
 * no kind=category rows — the migrate-before-seed window) — a 200, never an
 * error. Validated before send / after receive to keep the contract honest.
 */
export const CategoryTreeResponseSchema = z.object({
  nodes: z.array(CategoryTreeNodeSchema),
});

export type CategoryTreeResponse = z.infer<typeof CategoryTreeResponseSchema>;
