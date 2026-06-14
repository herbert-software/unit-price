// tier1 deterministic category/attribute tagging rules + arbitration. Pure,
// no IO (no network/DB/LLM/fs). The category/comparability red line: the LLM
// never decides a category — leaves are assigned by these keyword rules (and,
// in apps/api, by store_category_map) plus a deterministic arbiter; everything
// here is same-input-same-output.
//
// Scope (v1): leaf rules emit a single soft-drink LEAF (no intermediate
// nodes — `软饮`/`饮料` are reached via is-a closure downstream, not here).
// Persistence-row schemas (tag/product_tag/store_category_map/category_closure)
// live in packages/db, NOT here. This module only defines the tier1 rule input/
// output types + shared enums and the pure decision functions.
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared enums (Zod is the SOT; TS types are inferred — no hand-written dups).
// ---------------------------------------------------------------------------

/** Tag kind. Only `category` participates in the is-a tree / closure. */
export const TagKindSchema = z.enum(['category', 'attribute', 'brand', 'product_line']);
export type TagKind = z.infer<typeof TagKindSchema>;

/**
 * Comparable unit bound on a category node (single-point binding + is-a
 * inheritance). `per_100ml` is the only value seeded this period (v1 soft
 * drinks); `per_100g`/`per_100sheet` are TYPE-ONLY placeholders for v2 — they
 * are intentionally NOT seeded and bind to no node this period.
 */
export const ComparableUnitSchema = z.enum(['per_100ml', 'per_100g', 'per_100sheet']);
export type ComparableUnit = z.infer<typeof ComparableUnitSchema>;

/**
 * Provenance of a product↔tag edge. This period only: `rule` (tier1 keyword
 * rules), `store-map` (store_category_map), `manual` (human correction). No
 * `llm` — LLM candidate tagging is v2.
 */
export const TagSourceSchema = z.enum(['rule', 'store-map', 'manual']);
export type TagSource = z.infer<typeof TagSourceSchema>;

/**
 * Stable leaf identifiers for the v1 soft-drink subtree (canonical naming,
 * store-agnostic). These are the only leaves tier1 can emit this period.
 * Mapped to seeded `tag.slug` in packages/db.
 */
export const CategoryLeafSlugSchema = z.enum([
  'carbonated', // 碳酸饮料 — 含糖配方汽水(可乐/汽水/雪碧)
  'juice-plant', // 果汁·植物饮
  'coffee-tea', // 咖啡·茶饮(茶饮/咖啡饮料/能量饮料)
  'drinking-water', // 饮用水(气泡水/苏打水归此 + attribute 气泡)
]);
export type CategoryLeafSlug = z.infer<typeof CategoryLeafSlugSchema>;

/** Controlled attribute values that tier1 can emit this period. */
export const AttributeSlugSchema = z.enum([
  'sugar-free', // 无糖
  'sparkling', // 气泡
  'imported', // 进口
]);
export type AttributeSlug = z.infer<typeof AttributeSlugSchema>;

// ---------------------------------------------------------------------------
// tier1 rule input / output types (Zod SOT; types inferred).
// ---------------------------------------------------------------------------

/** Input to the tier1 category/attribute rules. */
export const Tier1TagInputSchema = z.object({
  title: z.string(),
});
export type Tier1TagInput = z.infer<typeof Tier1TagInputSchema>;

/** A single matched keyword span, for replayable traceability. */
export const TagEvidenceSchema = z.object({
  /** The literal keyword that matched (e.g. "可乐"). */
  keyword: z.string(),
  /** Where it matched in the (lower-cased) title. */
  index: z.number(),
});
export type TagEvidence = z.infer<typeof TagEvidenceSchema>;

/** One candidate leaf produced by tier1, with its hit evidence + priority. */
export const Tier1LeafCandidateSchema = z.object({
  leafSlug: CategoryLeafSlugSchema,
  /** Explicit rule priority (higher wins). Tie at equal priority + depth. */
  priority: z.number(),
  /** Tree depth of the target leaf (deeper wins first). v1 leaves are equidepth. */
  depth: z.number(),
  /** Total matched-keyword length (末位 tiebreak only). */
  matchLength: z.number(),
  /** The keyword spans that produced this candidate. */
  evidence: z.array(TagEvidenceSchema),
});
export type Tier1LeafCandidate = z.infer<typeof Tier1LeafCandidateSchema>;

/** One attribute hit produced by tier1. */
export const Tier1AttributeHitSchema = z.object({
  slug: AttributeSlugSchema,
  evidence: z.array(TagEvidenceSchema),
});
export type Tier1AttributeHit = z.infer<typeof Tier1AttributeHitSchema>;

/**
 * Result of tier1 leaf resolution.
 * - `leaf` non-null + `tie=false`: a single determinate leaf.
 * - `leaf=null` + `tie=true`: ≥2 equal-priority candidates (no determinate
 *   output — treated downstream as "tier1 produced nothing", so a clean
 *   store-map leaf can still win without locking 待人工).
 * - `leaf=null` + `tie=false`: no keyword hit at all.
 * `candidates` always carries the full ranked candidate set for traceability.
 */
export const Tier1LeafResultSchema = z.object({
  leaf: CategoryLeafSlugSchema.nullable(),
  tie: z.boolean(),
  candidates: z.array(Tier1LeafCandidateSchema),
});
export type Tier1LeafResult = z.infer<typeof Tier1LeafResultSchema>;

// ---------------------------------------------------------------------------
// 1.2 tier1 category LEAF keyword rules (pure, leaf-only).
// ---------------------------------------------------------------------------

interface LeafRule {
  leafSlug: CategoryLeafSlug;
  /** Tree depth of the target leaf. v1 soft-drink leaves are all depth 2. */
  depth: number;
  /** Explicit priority to break same-depth ties (higher wins). */
  priority: number;
  /** Keywords that signal this leaf (matched as substrings, case-insensitive). */
  keywords: string[];
}

// All v1 leaves sit at the same depth (软饮's children), so depth is uniform
// and `priority` is the primary same-depth tiebreak. `碳酸饮料` is given a
// higher priority than `饮用水` so that a sugared-cola title carrying an
// incidental water-ish token still resolves to carbonated; sparkling/soda water
// is steered to drinking-water purely by its own keywords (苏打水/气泡水), which
// do NOT include 可乐/汽水 — so 屈臣氏苏打水 hits only drinking-water, never
// carbonated. The physical "含气" is carried by the `sparkling` attribute, not
// by the category leaf.
const LEAF_DEPTH = 2;

const LEAF_RULES: readonly LeafRule[] = [
  {
    leafSlug: 'carbonated',
    depth: LEAF_DEPTH,
    priority: 30,
    // 含糖配方汽水类。注意:不含「苏打/气泡」——那些归饮用水。
    keywords: ['可乐', '汽水', '雪碧', '碳酸'],
  },
  {
    leafSlug: 'juice-plant',
    depth: LEAF_DEPTH,
    priority: 20,
    keywords: ['果汁', '果蔬汁', '植物饮', '椰汁', '豆奶'],
  },
  {
    leafSlug: 'coffee-tea',
    depth: LEAF_DEPTH,
    priority: 20,
    keywords: ['茶', '咖啡', '能量饮', '拿铁', '美式'],
  },
  {
    leafSlug: 'drinking-water',
    depth: LEAF_DEPTH,
    priority: 10,
    // 苏打水/气泡水/含气矿泉 + 普通矿泉水/纯净水。气泡由 attribute 承载。
    keywords: ['苏打水', '气泡水', '含气矿泉', '矿泉水', '纯净水', '饮用水'],
  },
];

function normalizeTitle(title: string): string {
  return title.toLowerCase();
}

/**
 * Collect every keyword hit for a rule, returning the evidence spans and the
 * total matched length (sum of keyword lengths actually present).
 */
function collectHits(haystack: string, keywords: string[]): TagEvidence[] {
  const hits: TagEvidence[] = [];
  for (const kw of keywords) {
    const idx = haystack.indexOf(kw.toLowerCase());
    if (idx >= 0) {
      hits.push({ keyword: kw, index: idx });
    }
  }
  return hits;
}

/**
 * tier1 category leaf keyword rule (1.2). Pure: `title → 候选叶 + 命中证据`,
 * LEAF-ONLY. Disambiguation order is explicit: deeper leaf > priority number >
 * matched length (length is a末位 tiebreak only). When ≥2 candidates remain
 * tied after all three keys, the result is a `tie` (no determinate leaf) so the
 * arbiter can fall back to a clean store-map leaf instead of guessing.
 */
export function tagTier1Leaf(input: Tier1TagInput): Tier1LeafResult {
  const haystack = normalizeTitle(input.title);
  const candidates: Tier1LeafCandidate[] = [];

  for (const rule of LEAF_RULES) {
    const evidence = collectHits(haystack, rule.keywords);
    if (evidence.length === 0) continue;
    const matchLength = evidence.reduce((sum, e) => sum + e.keyword.length, 0);
    candidates.push({
      leafSlug: rule.leafSlug,
      priority: rule.priority,
      depth: rule.depth,
      matchLength,
      evidence,
    });
  }

  if (candidates.length === 0) {
    return { leaf: null, tie: false, candidates };
  }

  // Rank: deeper depth first, then higher priority, then longer match length.
  const ranked = [...candidates].sort((a, b) => {
    if (b.depth !== a.depth) return b.depth - a.depth;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return b.matchLength - a.matchLength;
  });

  const top = ranked[0]!;
  const second = ranked[1];
  // A tie exists only when the second-best is indistinguishable from the top on
  // ALL three keys (depth, priority, matchLength).
  const isTie =
    second !== undefined &&
    second.depth === top.depth &&
    second.priority === top.priority &&
    second.matchLength === top.matchLength;

  if (isTie) {
    return { leaf: null, tie: true, candidates: ranked };
  }
  return { leaf: top.leafSlug, tie: false, candidates: ranked };
}

// ---------------------------------------------------------------------------
// 1.3 attribute rules (pure).
// ---------------------------------------------------------------------------

interface AttributeRule {
  slug: AttributeSlug;
  keywords: string[];
}

const ATTRIBUTE_RULES: readonly AttributeRule[] = [
  { slug: 'sugar-free', keywords: ['无糖', '0糖', '零糖', '零度', 'zero'] },
  { slug: 'sparkling', keywords: ['气泡', '苏打', '含气', '汽泡'] },
  { slug: 'imported', keywords: ['进口', '原装进口', '海外'] },
];

/**
 * tier1 attribute rules (1.3). Pure: title → controlled attribute tags (flat,
 * multi-valued, cross-category). Attributes are orthogonal to the category leaf
 * (e.g. sparkling on a drinking-water leaf), so an attribute hit never changes
 * the leaf decision. Returns the hits in a stable rule order.
 */
export function tagTier1Attributes(input: Tier1TagInput): Tier1AttributeHit[] {
  const haystack = normalizeTitle(input.title);
  const hits: Tier1AttributeHit[] = [];
  for (const rule of ATTRIBUTE_RULES) {
    const evidence = collectHits(haystack, rule.keywords);
    if (evidence.length > 0) {
      hits.push({ slug: rule.slug, evidence });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 1.4 deterministic arbitration (pure decision, no IO / no write).
// ---------------------------------------------------------------------------

/**
 * store_category_map lookup result, as seen by the arbiter. This module does
 * NOT perform the lookup (that is IO, done in apps/api); the caller passes the
 * resolved node here. `kind`:
 * - `leaf`: store-map resolved a clean leaf (`leafSlug` set).
 * - `coarse`: store-map resolved a coarse (non-leaf) node (`coarseNodeSlug`
 *   set) — leads to 待细化 (pending).
 * - `none`: no native_category_id matched.
 */
export const StoreMapResultSchema = z.discriminatedUnion('kind', [
  // store-map can resolve ANY category leaf (soft-drink or otherwise) — the
  // leaf's legality/unit is decided by the DB tree, not a core enum.
  z.object({ kind: z.literal('leaf'), leafSlug: z.string() }),
  z.object({ kind: z.literal('coarse'), coarseNodeSlug: z.string() }),
  z.object({ kind: z.literal('none') }),
]);
export type StoreMapResult = z.infer<typeof StoreMapResultSchema>;

/**
 * Arbiter verdict — a pure DECISION, never a write (writing the product_tag /
 * pending / rankable is apps/api's job).
 * - `leaf`: determinate leaf (`leafSlug` set) → caller attaches the leaf tag.
 * - `pending`: 待细化 (`pendingNodeSlug` set, a coarse non-leaf) → caller sets
 *   product.pending_category_tag_id.
 * - `manual`: 待人工 → caller leaves category attribution empty (no leaf, no
 *   pending). NEVER force-assigns; NEVER touches product.category.
 */
export const ArbitrationVerdictSchema = z.discriminatedUnion('verdict', [
  z.object({
    verdict: z.literal('leaf'),
    // The verdict leaf may come from store-map (any leaf) or tier1 (a
    // CategoryLeafSlug — a string subset, so still compatible).
    leafSlug: z.string(),
    decidedBy: z.enum(['tier1', 'store-map']),
  }),
  z.object({ verdict: z.literal('pending'), pendingNodeSlug: z.string() }),
  z.object({ verdict: z.literal('manual') }),
]);
export type ArbitrationVerdict = z.infer<typeof ArbitrationVerdictSchema>;

/**
 * Deterministic arbiter (1.4). `(tier1 leaf result, store-map result) → 终裁`.
 * Covers the full taxonomy §五 table over `tier1 ∈ {未命中, 命中叶, 多叶tie}` ×
 * `store-map ∈ {未命中, 命中叶, 命中粗节点}` (tier1 is leaf-only, so it has no
 * "命中粗节点" state):
 *
 * - ① 两方都命中、粒度冲突(tier1 细叶 vs store-map 粗节点)→ 取更深叶(tier1 叶)。
 * - ② 两方都命中叶、同粒度异叶 → tier1 > store-map(标题细证据强于商超粗映射)。
 *      (Same leaf → that leaf, attributed to tier1.)
 * - ③ 仅一方有确定叶输出(含 tier1 多叶tie 视为 tier1 无确定输出):
 *      仅 tier1 命中叶 → 采该叶;仅 store-map 命中叶 → 采该叶(含 tier1 tie 但
 *      store-map 有干净叶时采 store-map 叶,不锁待人工);仅 store-map 命中粗节点
 *      → 待细化(pending)。
 * - ④ 两方都无确定叶(tier1 tie/未命中 且 store-map 未命中)→ 待人工。
 *      (本期无 LLM 候选。)
 */
export function arbitrate(
  tier1: Tier1LeafResult,
  storeMap: StoreMapResult,
): ArbitrationVerdict {
  const tier1HasLeaf = tier1.leaf !== null;

  // ② / part of ① — tier1 has a determinate leaf.
  if (tier1HasLeaf) {
    if (storeMap.kind === 'leaf') {
      // Same leaf → that leaf; different leaf at same granularity → tier1 wins.
      // Either way tier1's leaf is the verdict (② / same-leaf).
      return { verdict: 'leaf', leafSlug: tier1.leaf!, decidedBy: 'tier1' };
    }
    // store-map coarse (① granularity conflict: take deeper = tier1 leaf) or
    // store-map none (③ only tier1) → tier1 leaf.
    return { verdict: 'leaf', leafSlug: tier1.leaf!, decidedBy: 'tier1' };
  }

  // tier1 produced no determinate leaf (未命中 OR 多叶tie). Fall back to
  // store-map.
  if (storeMap.kind === 'leaf') {
    // ③ only store-map clean leaf (incl. tier1 tie) → take it, do NOT lock 待人工.
    return { verdict: 'leaf', leafSlug: storeMap.leafSlug, decidedBy: 'store-map' };
  }
  if (storeMap.kind === 'coarse') {
    // ③ only store-map coarse node → 待细化.
    return { verdict: 'pending', pendingNodeSlug: storeMap.coarseNodeSlug };
  }
  // ④ both無确定叶 → 待人工.
  return { verdict: 'manual' };
}
