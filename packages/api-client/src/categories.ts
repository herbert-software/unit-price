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
 *    all the way to root). Soft-drink line resolves to `per_100ml`; alcohol /
 *    root resolve to `null`. NEVER the raw un-inherited column value.
 *  - `rankable`: whether the node ITSELF carries a comparable unit
 *    (`comparableUnit !== null`) — i.e. whether it is itself a sort axis. This
 *    flag is ORTHOGONAL to whether the node's closure has rankable members
 *    (`rankableCount`); the two are not inter-derivable. Consumers MUST decide
 *    "is this node clickable into a ranking" by `rankableCount > 0`, NOT by
 *    `rankable` (root `beverage` is `rankable=false` but is the default ranking).
 *  - `rankableCount`: count of rankable members under the node's closure
 *    (non-negative integer). Equals the basis of `GET /rankings?category=<slug>`
 *    for that node (and, for root, the default `/rankings` basis). Orthogonal to
 *    `rankable`: root is `rankable=false` yet `rankableCount > 0`.
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
