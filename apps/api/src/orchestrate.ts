// /parse orchestration: tier1 (core regex) -> tier2 (SpecParserLLM, only when
// tier1 is insufficient) -> tier3 (core calculate + consistency) -> assemble.
//
// Merge semantics (spec): tier1 non-empty fields are AUTHORITATIVE; the LLM may
// only fill fields tier1 left empty. The merged spec is re-validated against
// ParsedSpecSchema. Confidence is the SINGLE authoritative value from the core
// calculator's final-result banding — no min, no second axis.
import {
  ParsedSpecSchema,
  calculate,
  isVolumeUnit,
  isWeightUnit,
  meetsComputeRequiredSet,
  parseTier1,
  type ParsedSpec,
  type RawProduct,
  type UnitPrice,
} from '@unit-price/core';
import type { ParseResult, SpecParserLLM } from './llm.js';

export interface ParseResponse {
  spec: ParsedSpec;
  unitPrice: UnitPrice;
  confidence: number;
  warnings: string[];
}

/** Distinguishable 5xx outcomes (info-insufficient vs runtime config error). */
export type OrchestrationOutcome =
  | { kind: 'ok'; response: ParseResponse }
  | { kind: 'insufficient'; message: string }
  | { kind: 'config-error'; message: string };

const WARN_NO_LLM_REVIEW = '未经 LLM 复核';
const WARN_LLM_REJECTED = 'LLM 解析结果未通过校验，已忽略';

/** Is a field "present" (non-null, non-undefined)? */
function present<T>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined;
}

/**
 * Merge tier1 (authoritative for its non-empty fields) with an LLM spec that
 * may only fill tier1's gaps. `multipliers` stays `[1]` this change; `category`
 * is always tier1's deterministic value (never from the LLM).
 */
function mergeSpecs(tier1: ParsedSpec, llm: ParsedSpec): ParsedSpec {
  const unitSize = present(tier1.unitSize) ? tier1.unitSize : llm.unitSize ?? null;
  const quantity = present(tier1.quantity) ? tier1.quantity : llm.quantity ?? null;
  let totalAmount = present(tier1.totalAmount) ? tier1.totalAmount : llm.totalAmount ?? null;

  // Deterministically derive a canonical totalAmount from unitSize*quantity when
  // both are present and totalAmount is still absent — mirrors tier1's own
  // derivation so an LLM-completed full spec isn't penalized to mid band for a
  // field the system can compute. Confidence is "result quality only" (spec).
  // Applies on either axis (volume ml/L OR weight g/kg). The derived total keeps
  // the unitSize's own axis unit — parsing never crosses ml<->L or g<->kg (the
  // calculator converts later) — matching the tier1 parser derivation.
  if (
    !present(totalAmount) &&
    present(unitSize) &&
    present(quantity) &&
    (isVolumeUnit(unitSize.unit) || isWeightUnit(unitSize.unit))
  ) {
    totalAmount = { value: unitSize.value * quantity, unit: unitSize.unit };
  }

  return {
    unitSize,
    quantity,
    multipliers: [1],
    totalAmount,
    packageUnit: present(tier1.packageUnit) ? tier1.packageUnit : llm.packageUnit ?? null,
    category: tier1.category,
    confidence: tier1.confidence,
  };
}

/**
 * The 5xx (info-insufficient) gate. Per parse-api: 5xx is reserved for the case
 * where we cannot even judge whether a result is computable — i.e. tier1
 * extracted NO spec shape at all. Once tier1 has any spec field (even a bare
 * `unitSize` such as a weight `2kg` or a volume `6000ml` without quantity),
 * tier3 can render a DETERMINATE verdict (a number, or a certain `null`), which
 * is a 200 — never a 5xx. Truly-empty extraction (e.g. `农夫山泉`) is the only
 * case with no shape to judge.
 */
function hasAnyShapeForJudgement(spec: ParsedSpec): boolean {
  return (
    present(spec.totalAmount) || present(spec.unitSize) || present(spec.quantity)
  );
}

/**
 * Whether tier1 alone already yields a DETERMINATE verdict, so tier2 (the LLM)
 * cannot change the outcome and must be skipped. Determinate when: (a) tier1
 * meets the compute-required set (a number on either axis), (b) price <= 0
 * (certain null — the LLM can't fix price), or (c) tier1 extracted a WEIGHT unit
 * (g/kg). A weight unit is determinate: tier1 already gives the certain verdict
 * for the weight axis — either a computed `per100g` (single-unit-inferred, met
 * by the compute-required check above) or a certain `null` (e.g. a free-digit
 * piece count such as `30枚` suppresses the single-unit inference) — and the LLM
 * can neither move a weight onto the volume axis nor override tier1's extracted
 * weight size. A volume unit is NOT listed here: a bare volume `unitSize` whose
 * quantity is genuinely missing is fillable by tier2, so it must fall through.
 * Only when none of (a)/(b)/(c) holds (price > 0, compute set unmet, and no
 * weight signal — i.e. a fillable gap on the volume axis) do we call tier2.
 */
function tier1YieldsDeterminate(spec: ParsedSpec, price: number): boolean {
  if (meetsComputeRequiredSet(spec, price)) return true; // computable -> a number
  if (!(price > 0)) return true; // price <= 0 -> certain null
  const t = spec.totalAmount;
  const u = spec.unitSize;
  // Weight unit -> tier1 verdict is determinate (a per100g number above, or a
  // certain null); the LLM can't move a weight onto the volume axis.
  if (t && isWeightUnit(t.unit)) return true;
  if (u && isWeightUnit(u.unit)) return true;
  // Derivable-but-non-positive total: tier1 has both an on-axis unitSize and a
  // quantity, but unitSize.value<=0 or quantity<=0 -> derived total<=0 is a
  // CERTAIN null the LLM cannot fix (it can't change tier1's extracted qty).
  // Weight already returned above; this guards the volume case symmetrically.
  if (
    u &&
    present(spec.quantity) &&
    (isVolumeUnit(u.unit) || isWeightUnit(u.unit)) &&
    (u.value <= 0 || spec.quantity <= 0)
  ) {
    return true;
  }
  return false;
}

/**
 * Orchestrate one parse. `price` is taken separately so the calculator price
 * guard (price <= 0 -> uncomputable, 200) is exercised even for valid numbers.
 */
export async function orchestrate(input: RawProduct, llm: SpecParserLLM): Promise<OrchestrationOutcome> {
  const tier1 = parseTier1(input);
  const extraWarnings: string[] = [];

  let spec = tier1.spec;

  // Only call tier2 if tier1 didn't already yield a determinate verdict
  // (clean titles, price<=0, and non-volume units skip the LLM entirely —
  // never touches the network/key).
  const tier1Determinate = tier1YieldsDeterminate(tier1.spec, input.price);

  if (!tier1Determinate) {
    let llmResult: ParseResult;
    try {
      llmResult = await llm.parse(input);
    } catch (err) {
      // Defensive: a throwing port is treated as a transport failure.
      llmResult = { ok: false, kind: 'transport', message: err instanceof Error ? err.message : String(err) };
    }

    if (llmResult.ok) {
      // Merge: tier1 authoritative, LLM fills gaps; re-validate via Zod.
      const merged = mergeSpecs(tier1.spec, llmResult.spec);
      const reparsed = ParsedSpecSchema.safeParse(merged);
      // mergeSpecs only recombines already-valid fields, so this should hold;
      // if it ever fails we keep tier1's spec rather than fabricate.
      spec = reparsed.success ? reparsed.data : tier1.spec;
    } else if (llmResult.kind === 'config') {
      // Runtime config error — distinguishable 5xx (different from insufficient).
      return { kind: 'config-error', message: llmResult.message };
    } else if (llmResult.kind === 'transport') {
      // tier2 transport failure. If tier1 has no shape to even judge
      // computability, this is "information insufficient" -> 5xx. Otherwise
      // fall through to tier3 on tier1 alone with a "no LLM review" warning.
      if (!hasAnyShapeForJudgement(tier1.spec)) {
        return { kind: 'insufficient', message: llmResult.message };
      }
      extraWarnings.push(WARN_NO_LLM_REVIEW);
    } else {
      // kind === 'invalid': LLM output rejected. Do not adopt; proceed on tier1.
      // The calculator's final banding will reflect tier1's (lower) quality.
      extraWarnings.push(WARN_LLM_REJECTED);
    }
  }

  // tier3: compute per100ml + canonical formula + authoritative confidence.
  const calc = calculate(spec, input.price);

  // Surface tier1's informational warnings (e.g. "数量按单件推断为 1") so the
  // single-unit inference is identifiable downstream. Dedupe across all sources.
  const warnings = [...new Set([...tier1.warnings, ...calc.warnings, ...extraWarnings])];

  return {
    kind: 'ok',
    response: {
      spec,
      unitPrice: calc.unitPrice,
      confidence: calc.confidence,
      warnings,
    },
  };
}
