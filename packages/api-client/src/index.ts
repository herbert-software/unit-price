// @unit-price/api-client — transport-agnostic shared API contract. Carries the
// GET /rankings and GET /categories contracts (Zod schemas + inferred types)
// plus pure helpers (buildRankingsUrl / parseRankingsResponse /
// buildCategoriesUrl / parseCategoryTreeResponse). NO network calls, NO runtime/
// framework dependency — only @unit-price/core + Zod. Each client wires its own
// transport. The single source of truth for these response schemas: apps/api
// and every client depend on this one definition.
export {
  RankingsItemSchema,
  RankingsResponseSchema,
  type RankingsItem,
  type RankingsResponse,
} from './rankings.js';
export {
  CategoryTreeNodeSchema,
  CategoryTreeResponseSchema,
  type CategoryTreeNode,
  type CategoryTreeResponse,
} from './categories.js';
export {
  buildRankingsUrl,
  parseRankingsResponse,
  buildCategoriesUrl,
  parseCategoryTreeResponse,
  type RankingsParams,
} from './client.js';
