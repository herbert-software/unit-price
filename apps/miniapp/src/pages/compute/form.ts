// Pure compute-form logic, extracted from the Taro page so the cohort derivation,
// unit-axis constraint, light validation, and ComputeRequest assembly are
// unit-testable WITHOUT the Taro runtime (the page can't run under vitest).
//
// Boundary: this module does ZERO network and ZERO on-device price math — it only
// shapes the structured form into a ComputeRequest the server (POST /compute)
// authoritatively validates and computes. The client checks here are LIGHT UX
// guards (positive numbers, the two-of-one exclusivity, unit↔cohort axis) to avoid
// empty round-trips (decision D7); the authoritative validation stays server-side.
import type {
  CategoryTreeNode,
  ComputeRequest,
  ComputeResult,
  ComputeUnit,
} from '@unit-price/api-client';

/** The cohort axis the server resolves a category into. Mirrors core's
 *  ComparableUnit subset the structured form supports (volume / mass). */
export type CohortAxis = 'per_100ml' | 'per_100g';

/** One selectable leaf cohort in the 品类 picker — derived from /categories, NOT
 *  hardcoded (防漂移, decision D8). `axis` drives the unit constraint. */
export interface Cohort {
  slug: string;
  name: string;
  axis: CohortAxis;
}

export const VOL_UNITS = ['ml', 'L'] as const;
export const WEIGHT_UNITS = ['g', 'kg'] as const;

/** 单件容量 (need quantity) / 总容量 — the two mutually-exclusive amount paths. */
export type AmountMode = 'unit' | 'total';

/**
 * Derive the selectable leaf cohorts from a GET /categories tree. A node is a
 * selectable cohort iff it is itself a single comparable cohort (`rankable`) with
 * at least one rankable member (`rankableCount > 0`) — the same population the
 * /rankings board would show, so a user can only price into a cohort that has a
 * board to position against. Non-rankable group headers (root 饮料 / 酒类 parent)
 * are excluded: pricing into them would hit the server's cross-cohort 400.
 *
 * Each cohort's axis comes from the server-resolved (is-a inherited)
 * `comparableUnit`. This period the server 400s a per_100g cohort (weight axis
 * unservable until the重量轴 backfill lands), so we derive ONLY per_100ml leaf
 * cohorts — the UI never offers a cohort the server would reject. A `rankable`
 * node always has a non-null comparableUnit, but we still guard and skip any
 * unexpected null/non-per_100ml axis rather than guess. Server order preserved.
 */
export function toCohorts(nodes: CategoryTreeNode[]): Cohort[] {
  const cohorts: Cohort[] = [];
  for (const n of nodes) {
    if (!n.rankable || n.rankableCount <= 0) continue;
    const axis = n.comparableUnit;
    if (axis !== 'per_100ml') continue;
    cohorts.push({ slug: n.slug, name: n.name, axis });
  }
  return cohorts;
}

/** The unit set a cohort axis allows: per_100ml → ml/L, per_100g → g/kg. Mirrors
 *  the server's cross-axis 不可比 400 guard so the form pre-constrains the choice
 *  (decision D4) and never offers a unit the server would reject. */
export function unitsForAxis(axis: CohortAxis): readonly ComputeUnit[] {
  return axis === 'per_100g' ? WEIGHT_UNITS : VOL_UNITS;
}

/** Is `unit` on the cohort axis? Used to (a) clamp a stale unit when the cohort
 *  changes and (b) reject a cross-axis submit on the client before any request. */
export function isUnitOnAxis(unit: ComputeUnit, axis: CohortAxis): boolean {
  return (unitsForAxis(axis) as readonly string[]).includes(unit);
}

/** Human-readable 比价口径 for the selected cohort axis (shown as a hint). */
export function axisCaption(axis: CohortAxis): string {
  return axis === 'per_100g' ? '该品类按每 100g 比价' : '该品类按每 100ml 比价';
}

/** Raw, still-string form state the page holds. Kept string-typed (Input gives
 *  strings) so validation owns the number coercion in one place. */
export interface ComputeFormInput {
  totalPrice: string;
  quantity: string;
  mode: AmountMode;
  amount: string;
  unit: ComputeUnit;
  cohort: Cohort | undefined;
}

export type ComputeFormResult =
  | { ok: true; request: ComputeRequest }
  | { ok: false; hint: string };

/**
 * Light client-side validation + ComputeRequest assembly (PURE).
 *
 * Returns `{ ok:true, request }` only when the input set is sufficient and
 * self-consistent enough to be worth a round-trip; otherwise `{ ok:false, hint }`
 * with the first missing/invalid field named inline. The page MUST NOT send a
 * request on `ok:false` (spec: 空 / 非法输入禁止发起请求). The server still
 * authoritatively validates (Zod + meetsComputeRequiredSet + cohort guard).
 *
 * Required set by amount path (mirrors the server's per-path required set):
 *  - mode 'unit'  → totalPrice>0, quantity int>0, unitSize{value>0,unit}
 *  - mode 'total' → totalPrice>0, totalAmount{value>0,unit}
 * Plus: a cohort must be selected, and the unit must be on that cohort's axis.
 */
export function buildComputeRequest(input: ComputeFormInput): ComputeFormResult {
  const { cohort } = input;
  if (!cohort) return { ok: false, hint: '请选择品类' };

  if (!isUnitOnAxis(input.unit, cohort.axis)) {
    return { ok: false, hint: axisCaption(cohort.axis) };
  }

  const price = Number(input.totalPrice);
  if (!(price > 0)) return { ok: false, hint: '请输入有效总价' };

  const amount = Number(input.amount);
  if (!(amount > 0)) {
    return {
      ok: false,
      hint: input.mode === 'unit' ? '请输入单件容量' : '请输入总容量',
    };
  }

  const request: ComputeRequest = {
    totalPrice: price,
    category: cohort.slug,
  };

  if (input.mode === 'unit') {
    const qty = Number(input.quantity);
    if (!(Number.isInteger(qty) && qty > 0)) return { ok: false, hint: '请输入数量（正整数）' };
    request.quantity = qty;
    request.unitSize = { value: amount, unit: input.unit };
  } else {
    request.totalAmount = { value: amount, unit: input.unit };
  }

  return { ok: true, request };
}

// ————————————————————————————————————————————————————————————————
// Result-card derivation (PURE) — keeps the verdict / percent / position-marker
// logic unit-testable and honest. The "比 X% 便宜" percent comes STRAIGHT from the
// server's `percentile` (contract field; NOT a client recompute with a different
//口径); the verdict is a threshold over that same percentile; `pos` is clamped to
// the [0,1] track so a rank>total (user pricier than all) can't render off-track.

/** A green/red verdict, or `empty` when the cohort has no comparables (total=0):
 *  an empty cohort gets a NEUTRAL card — no verdict color, no position dot. */
export type Verdict = 'worth' | 'pricey' | 'mid' | 'empty';

export interface ResultView {
  /** total===0 → neutral 暂无同类可比 (no verdict color, no dot). */
  empty: boolean;
  verdict: Verdict;
  /** Server percentile rounded to a whole 比 X% 便宜 (0..100); 0 when empty. */
  cheaperPct: number;
  /** Bar-marker position 0..1 (0=cheapest left, 1=priciest right), clamped. */
  pos: number;
}

/**
 * Derive the result card's presentation from a server ComputeResult (PURE).
 * `cheaperPct`, `verdict`, AND `pos` ALL derive from the single server `percentile`
 * — so the bar dot, the verdict color, and the "比 X% 便宜" number can NEVER tell
 * contradictory stories (the round-3 tie bug: a rank-based `pos` put a tied user's
 * dot at the cheap-left edge while the percentile-based verdict painted it red,
 * because rank (strictly-cheaper) and percentile (strictly-pricier) handle ties
 * oppositely). Deriving everything from `percentile` removes that whole class.
 *  - total===0 → empty (neutral), no verdict / no dot, cheaperPct 0.
 *  - cheaperPct = round(server percentile) = the contract "比多少同类便宜".
 *  - verdict: thresholds on the ROUNDED cheaperPct (not raw percentile) so the
 *    displayed number and the verdict word never straddle a band boundary
 *    (e.g. pct 65.6 → cheaperPct 66 → worth, text "66%" — consistent).
 *  - pos: (100 - percentile)/100, clamped — pct 100 → 0 (cheapest, left edge),
 *    pct 0 → 1 (priciest, right edge). Same source as the verdict (no rank).
 */
export function deriveResultView(result: ComputeResult): ResultView {
  const { total, percentile } = result;
  if (total === 0) {
    return { empty: true, verdict: 'empty', cheaperPct: 0, pos: 0 };
  }
  const cheaperPct = Math.round(percentile);
  const verdict: Verdict = cheaperPct >= 66 ? 'worth' : cheaperPct <= 34 ? 'pricey' : 'mid';
  const pos = Math.max(0, Math.min(1, (100 - percentile) / 100));
  return { empty: false, verdict, cheaperPct, pos };
}
