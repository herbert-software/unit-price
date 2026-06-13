// @unit-price/api-client — transport-agnostic shared API contract. Carries the
// GET /rankings contract (Zod schema + inferred types) plus pure helpers
// (buildRankingsUrl / parseRankingsResponse). NO network calls, NO runtime/
// framework dependency — only @unit-price/core + Zod. Each client wires its own
// transport. The single source of truth for RankingsResponseSchema: apps/api
// and every client depend on this one definition.
export {
  RankingsItemSchema,
  RankingsResponseSchema,
  type RankingsItem,
  type RankingsResponse,
} from './rankings.js';
export { buildRankingsUrl, parseRankingsResponse, type RankingsParams } from './client.js';
