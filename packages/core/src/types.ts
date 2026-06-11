// Zod schema is the single source of truth; TS types are inferred from schema.
// This change deliberately omits `comparable`/`excludedReason` (non-goal).
import { z } from 'zod';

/** Canonical unit enum: volume (ml, L) and weight (g, kg). */
export const UnitSchema = z.enum(['ml', 'L', 'g', 'kg']);
export type Unit = z.infer<typeof UnitSchema>;

/** A measurement: a positive-or-zero magnitude plus a canonical unit. */
export const MeasurementSchema = z.object({
  value: z.number(),
  unit: UnitSchema,
});
export type Measurement = z.infer<typeof MeasurementSchema>;

/** Raw input: at minimum a non-empty title and a numeric price. */
export const RawProductSchema = z.object({
  title: z.string().min(1),
  price: z.number(),
  categoryHint: z.string().optional(),
});
export type RawProduct = z.infer<typeof RawProductSchema>;

/**
 * Structured spec parsed from a RawProduct. Possibly-missing fields are
 * explicitly nullable so a partial tier1 hit round-trips through Zod.
 * `multipliers` is the extra-layer scalar array (this change is always `[1]`);
 * the scalar `multiplier = product(multipliers)`.
 */
export const ParsedSpecSchema = z.object({
  unitSize: MeasurementSchema.nullable().optional(),
  quantity: z.number().nullable().optional(),
  multipliers: z.array(z.number()).default([1]),
  totalAmount: MeasurementSchema.nullable().optional(),
  packageUnit: z.string().nullable().optional(),
  category: z.string(),
  confidence: z.number().min(0).max(1),
});
export type ParsedSpec = z.infer<typeof ParsedSpecSchema>;

/**
 * Unit price result. The product falls on exactly one axis: `per100ml` (volume)
 * XOR `per100g` (weight); at most one is non-null (both null = uncomputable).
 * `per100ml`, `per100g` and `formula` are explicitly nullable.
 */
export const UnitPriceSchema = z.object({
  per100ml: z.number().nullable(),
  per100g: z.number().nullable(),
  formula: z.string().nullable(),
});
export type UnitPrice = z.infer<typeof UnitPriceSchema>;

/** Top-level response warnings collector. */
export const WarningsSchema = z.array(z.string());
export type Warnings = z.infer<typeof WarningsSchema>;
