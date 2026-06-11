// tier1 regex parser. Pure, no IO. Extracts `<number><unit> [x <quantity>]`
// from a title, producing a candidate ParsedSpec + hit evidence. A clean title
// (full-spec hit) does not require the LLM; category is passed through from
// categoryHint (default `beverage`) and never decided by the LLM.
import type { Measurement, ParsedSpec, RawProduct } from './types.js';
import {
  isVolumeUnit,
  isWeightUnit,
  normalizeMeasurement,
  normalizePackageUnit,
  toMl,
} from './units.js';

export interface Tier1Evidence {
  /** The substring(s) that matched, for traceability. */
  matched: string[];
  /** Which fields tier1 populated. */
  hits: {
    unitSize: boolean;
    quantity: boolean;
    packageUnit: boolean;
    totalAmount: boolean;
  };
}

export interface Tier1Result {
  spec: ParsedSpec;
  evidence: Tier1Evidence;
  /**
   * True when tier1 alone produced a full, self-derivable spec and thus no LLM
   * is needed (clean title). Callers use this to skip tier2.
   */
  clean: boolean;
  /**
   * Informational warnings about HOW tier1 derived the spec (e.g. quantity was
   * inferred as a single unit rather than read from the title). These annotate
   * provenance only and never change the confidence band.
   */
  warnings: string[];
}

const DEFAULT_CATEGORY = 'beverage';

const WARN_INFERRED_SINGLE = '数量按单件推断为 1';

// `斤` is a weight alias handled by normalizeMeasurement; include it so weight
// titles are recognized (then routed to the uncomputable terminal downstream).
const UNIT_TOKEN = '(ml|mL|ML|毫升|l|L|升|g|G|克|kg|KG|Kg|公斤|千克|斤)';
const PACKAGE_TOKEN = '(听|罐|瓶|盒|袋)';

// e.g. "330ml", "1.25L", "500克"
const SIZE_RE = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${UNIT_TOKEN}`, 'i');

// Global variant of SIZE_RE for scanning ALL size tokens in a window (used by
// the total-restatement rebind). Built from the same source so the two never
// drift. Note: this also matches weight tokens (2kg/100g); the rebind's volume
// sub-check (gate (a)) filters those out.
const SIZE_G = new RegExp(SIZE_RE.source, 'ig');

// Self-consistency tolerance for the total-restatement rebind: relative error
// (单件Vol×N vs 前导Vol, in ml) at or below this is treated as a restated total.
const RESTATEMENT_TOLERANCE = 0.1;

// quantity after a `*`/`×`/`x`, optionally followed by a package unit:
// "*24听", "×6", "x 12 瓶"
const QTY_RE = new RegExp(`[*×x]\\s*(\\d+)\\s*${PACKAGE_TOKEN}?`, 'i');

// a standalone package count without a multiplier symbol: "24听", "6瓶"
const PKG_COUNT_RE = new RegExp(`(\\d+)\\s*${PACKAGE_TOKEN}`, 'i');

// A count multiplier glued immediately BEFORE the size, with no space in
// between: "24x", "24×", "24*" (as in "24x500mL"). Used only as a fallback
// when no trailing quantity is found, and only against the substring that ends
// exactly at the size span — never the whole title (which would re-introduce
// the "可口可乐X20" misread).
const QTY_BEFORE_RE = /(\d+)\s*[*×x]\s*$/i;

// Any digit-bearing quantity signal OTHER than the size token: a `*`/`×`/`x`
// multiplier, a `数字 + 包装单位` count (packaging set aligned with the main
// spec: 瓶/罐/支/盒/袋/听/提/箱), or any other free-floating digit. The single-
// unit inference fires only when NONE of these appears outside the size span.
const PACKAGE_SIGNAL_TOKEN = '(瓶|罐|支|盒|袋|听|提|箱)';
const QTY_SIGNAL_RE = new RegExp(
  `[*×x]|(\\d+)\\s*${PACKAGE_SIGNAL_TOKEN}|\\d`,
  'i',
);

// 含量描述符 token:`数字 + 含量后缀`(酒精度 度/°、%vol、百分比 %)。这些是商品
// 含量、不是数量,故在单件推断的「游离数字」判定里要先剥掉。global 以剥多次出现。
// 顺序:%vol/%\s*vol 在 % 之前(`55%vol` 整段抹、不留 vol);vol 单列兜底 `55vol`。
const CONTENT_TOKEN_RE = /\d+(?:\.\d+)?\s*(?:%\s*vol|%vol|vol|度|°|%)/gi;

/**
 * True when `rest` (the title with the size span removed) carries any digit-
 * bearing quantity signal: a multiplier symbol, a `数字 + 包装单位` count, or a
 * free-floating digit. Drives the single-unit inference guard.
 *
 * 含量描述符(`53度`/`55%vol`/`100%`)非数量,先剥再判:剥离只作用于本判据、
 * 不改 `rest` 本身、不影响 size/乘号/包装计数等正向抽取(它们在此之前已定)。
 */
function hasQuantitySignal(rest: string): boolean {
  return QTY_SIGNAL_RE.test(rest.replace(CONTENT_TOKEN_RE, ''));
}

/**
 * Resolve the category deterministically: passthrough categoryHint, else the
 * `beverage` constant. Never sourced from the LLM.
 */
export function resolveCategory(input: RawProduct): string {
  return input.categoryHint?.trim() || DEFAULT_CATEGORY;
}

export function parseTier1(input: RawProduct): Tier1Result {
  const title = input.title;
  const matched: string[] = [];

  const warnings: string[] = [];

  let unitSize: Measurement | null = null;
  let quantity: number | null = null;
  let packageUnit: string | null = null;

  const sizeMatch = SIZE_RE.exec(title);
  if (sizeMatch) {
    matched.push(sizeMatch[0]);
    const value = Number.parseFloat(sizeMatch[1]!);
    const unitToken = sizeMatch[2]!;
    unitSize = normalizeMeasurement(value, unitToken);
  }

  // The quantity multiplier always trails the size (e.g. "330ml*6听"), so when a
  // size is found, search for QTY_RE only in the substring after it. This avoids
  // mismatching a Latin `x` glued to the product name (e.g. "可口可乐X20").
  const sizeEnd = sizeMatch ? sizeMatch.index + sizeMatch[0].length : 0;
  const qtySearch = sizeMatch ? title.slice(sizeEnd) : title;
  const qtyMatch = QTY_RE.exec(qtySearch);
  if (qtyMatch) {
    matched.push(qtyMatch[0]);
    quantity = Number.parseInt(qtyMatch[1]!, 10);
    if (qtyMatch[2]) {
      packageUnit = normalizePackageUnit(qtyMatch[2]);
    }
  }

  // Total-restatement rebind: a title like "2.1L(100mL×21)" carries a LEADING
  // total ("2.1L") AND a per-unit×count restatement ("100mL×21"). QTY_RE finds
  // the `×21` after the FIRST size and would otherwise bind it to that leading
  // total, double-counting (44.1L). The `×N` actually multiplies the size
  // immediately to its LEFT (100mL). So when the multiplier's left window holds
  // ≥2 size tokens, the NEAREST (rightmost) size is the real unit, and the
  // first size is the restated total — but ONLY when they self-consistently
  // agree (nearest×N ≈ leading, both volume). Otherwise the leading size is
  // most likely a product-name marketing token (2L装/便携550mL) and we keep the
  // existing binding to avoid regressions.
  if (qtyMatch && sizeMatch && quantity !== null) {
    // Absolute position of the multiplier in `title`: qtyMatch.index is
    // relative to qtySearch (= title.slice(sizeEnd)), so add sizeEnd back.
    const mulAbs = sizeEnd + qtyMatch.index;
    // Scan ALL size tokens in the window from title start to the multiplier;
    // the rightmost is the per-unit candidate (nearestVol), the first is the
    // leading-total candidate. Any size between them is ignored.
    SIZE_G.lastIndex = 0;
    const window = title.slice(0, mulAbs);
    let nearestVol: Measurement | null = null;
    let nearestIndex = -1;
    for (const m of window.matchAll(SIZE_G)) {
      const v = Number.parseFloat(m[1]!);
      const measured = normalizeMeasurement(v, m[2]!);
      if (measured) {
        nearestVol = measured;
        nearestIndex = m.index;
      }
    }
    // Only consider rebinding when the nearest size is NOT the first size, i.e.
    // there is an earlier leading size to treat as the restated total.
    if (nearestVol !== null && nearestIndex > sizeMatch.index && unitSize !== null) {
      const leadingVol = unitSize; // first size = leading-total candidate
      const N = quantity;
      // Self-consistency gate, short-circuited so the comparison (d) runs last
      // and never divides by a non-positive/NaN leading-ml.
      const bothVolume = isVolumeUnit(leadingVol.unit) && isVolumeUnit(nearestVol.unit);
      const leadingMl = bothVolume ? toMl(leadingVol) : null;
      const nearestMl = bothVolume ? toMl(nearestVol) : null;
      if (
        bothVolume &&
        leadingMl !== null &&
        leadingMl > 0 && // (b) divide-by-zero / non-positive guard
        N > 0 && // (c)
        nearestMl !== null &&
        // (d) self-consistency: |nearest×N − leading| / leading ≤ tolerance
        Math.abs(nearestMl * N - leadingMl) / leadingMl <= RESTATEMENT_TOLERANCE
      ) {
        // Gate passed: rebind to the per-unit size; the leading size was a
        // restated total. totalAmount is re-derived below (unitSize×quantity).
        matched.push(nearestVol.value + nearestVol.unit);
        unitSize = nearestVol;
        quantity = N;
      }
      // Gate failed (non-volume / non-positive leading / N≤0 / inconsistent):
      // keep the existing binding; the leading size is product-name noise.
    }
  }

  // Count-before-size fallback: only when the trailing search found no
  // quantity. Look for a `数字 [*×x]` glued immediately before the size span
  // (e.g. "24x500mL"). Restricted to the window ending exactly at the size, so
  // it never re-introduces the "可口可乐X20" misread. The trailing side always
  // wins: "24x500mL*6" keeps quantity=6 (no multiply/stack with the prefix).
  if (quantity === null && sizeMatch) {
    const beforeMatch = QTY_BEFORE_RE.exec(title.slice(0, sizeMatch.index));
    if (beforeMatch) {
      matched.push(beforeMatch[0]);
      quantity = Number.parseInt(beforeMatch[1]!, 10);
    }
  }

  // Fallback: a package count not introduced by `*`/`×` (e.g. "可乐 24听").
  // Like QTY_RE, anchor the search to the substring after the size span when a
  // size is found, so a `<number><package-word>` in the product name (e.g.
  // "500瓶装礼盒 330ml") is not silently misread as the quantity.
  if (quantity === null) {
    const pkgMatch = PKG_COUNT_RE.exec(qtySearch);
    if (pkgMatch) {
      matched.push(pkgMatch[0]);
      quantity = Number.parseInt(pkgMatch[1]!, 10);
      packageUnit = normalizePackageUnit(pkgMatch[2]!);
    }
  }

  // Single-unit inference: a volume OR weight size with NO other digit-bearing
  // quantity signal in the rest of the title (no `*×x`, no `数字+包装单位`, no
  // free digit) is treated as a single unit (quantity=1). A multiplier in play
  // that resolved to quantity<=0 (e.g. "330ml*0") is NOT inferred — the
  // multiplier is itself a signal — and falls through to the downstream
  // zero-total state. Volume behavior is unchanged; weight is the symmetric
  // extension (judging criterion identical, only the size unit set differs).
  if (
    quantity === null &&
    unitSize !== null &&
    (isVolumeUnit(unitSize.unit) || isWeightUnit(unitSize.unit))
  ) {
    const rest = title.slice(0, sizeMatch!.index) + title.slice(sizeEnd);
    if (!hasQuantitySignal(rest)) {
      quantity = 1;
      warnings.push(WARN_INFERRED_SINGLE);
    }
  }

  // Derive totalAmount when unitSize + quantity are both known and unitSize is
  // on an axis (volume ml/L OR weight g/kg). Keep the derived total in the
  // unitSize's own unit — parsing never crosses the ml<->L or g<->kg boundary
  // (calc converts later). For a single inferred unit, totalAmount === unitSize.
  let totalAmount: Measurement | null = null;
  if (
    unitSize &&
    quantity !== null &&
    (isVolumeUnit(unitSize.unit) || isWeightUnit(unitSize.unit))
  ) {
    totalAmount = { value: unitSize.value * quantity, unit: unitSize.unit };
  }

  const hits = {
    unitSize: unitSize !== null,
    quantity: quantity !== null,
    packageUnit: packageUnit !== null,
    totalAmount: totalAmount !== null,
  };

  // Clean = full-spec hit: unitSize + quantity + a derivable totalAmount.
  const clean = hits.unitSize && hits.quantity && hits.totalAmount;

  const spec: ParsedSpec = {
    unitSize,
    quantity,
    multipliers: [1],
    totalAmount,
    packageUnit,
    category: resolveCategory(input),
    // Intermediate parse confidence; the authoritative top-level confidence is
    // re-derived from the final result by the calculator's banding.
    confidence: clean ? 0.9 : 0.5,
  };

  return { spec, evidence: { matched, hits }, clean, warnings };
}
