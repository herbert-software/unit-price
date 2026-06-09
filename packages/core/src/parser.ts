// tier1 regex parser. Pure, no IO. Extracts `<number><unit> [x <quantity>]`
// from a title, producing a candidate ParsedSpec + hit evidence. A clean title
// (full-spec hit) does not require the LLM; category is passed through from
// categoryHint (default `beverage`) and never decided by the LLM.
import type { Measurement, ParsedSpec, RawProduct } from './types.js';
import { isVolumeUnit, normalizeMeasurement, normalizePackageUnit } from './units.js';

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

/**
 * True when `rest` (the title with the size span removed) carries any digit-
 * bearing quantity signal: a multiplier symbol, a `数字 + 包装单位` count, or a
 * free-floating digit. Drives the single-unit inference guard.
 */
function hasQuantitySignal(rest: string): boolean {
  return QTY_SIGNAL_RE.test(rest);
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

  // Single-unit inference: a volume size with NO other digit-bearing quantity
  // signal in the rest of the title (no `*×x`, no `数字+包装单位`, no free
  // digit) is treated as a single unit (quantity=1). A multiplier in play that
  // resolved to quantity<=0 (e.g. "330ml*0") is NOT inferred — the multiplier
  // is itself a signal — and falls through to the downstream zero-total state.
  if (
    quantity === null &&
    unitSize !== null &&
    isVolumeUnit(unitSize.unit)
  ) {
    const rest = title.slice(0, sizeMatch!.index) + title.slice(sizeEnd);
    if (!hasQuantitySignal(rest)) {
      quantity = 1;
      warnings.push(WARN_INFERRED_SINGLE);
    }
  }

  // Derive totalAmount when unitSize + quantity are both known and unitSize is
  // a volume unit (ml/L). Keep the derived total in the unitSize's own unit —
  // parsing never crosses the ml<->L boundary (calc converts later). For a
  // single inferred unit, totalAmount === unitSize.
  let totalAmount: Measurement | null = null;
  if (unitSize && quantity !== null && isVolumeUnit(unitSize.unit)) {
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
