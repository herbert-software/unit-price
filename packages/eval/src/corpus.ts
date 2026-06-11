// Golden-set corpus format (JSONL, one sample per line) + line-by-line loader.
// Zod is the SOT; TS types are derived. See spec: "黄金集语料格式".

import { z } from 'zod';

/**
 * Human-annotated expected spec. All fields optional / nullable — partial
 * annotation is allowed (a sample may carry only some expected fields).
 */
export const ExpectedSpecSchema = z
  .object({
    unitSize: z.number().nullable().optional(),
    quantity: z.number().nullable().optional(),
    totalAmount: z.number().nullable().optional(),
    per100ml: z.number().nullable().optional(),
    per100g: z.number().nullable().optional(),
  })
  .passthrough();

export type ExpectedSpec = z.infer<typeof ExpectedSpecSchema>;

/**
 * One golden-set corpus sample.
 *
 * - `title`     non-empty string (the raw product title fed to the parser)
 * - `source`    provenance marker, e.g. `har:<file>` or `manual`
 * - `priceCents`        optional integer, price in cents (分)
 * - `samPkgNum`         optional integer, Sam's `smallPackageNum` ground truth
 * - `samPkgUnit`        optional string, Sam's `smallPackageUnit`
 * - `samUnitPrice`      optional number, per-unit price in yuan (元), already
 *                       parsed from the display string (NOT a display string)
 * - `isCompare`         optional boolean, Sam's comparable flag — placeholder
 *                       truth field, no metric consumes it yet
 * - `expected`          optional human-annotated expected spec
 */
export const CorpusSampleSchema = z
  .object({
    title: z.string().min(1, 'title must be a non-empty string'),
    source: z.string().min(1, 'source must be a non-empty string'),
    priceCents: z.number().int().nonnegative().optional(),
    samPkgNum: z.number().int().optional(),
    samPkgUnit: z.string().optional(),
    samUnitPrice: z.number().optional(),
    isCompare: z.boolean().optional(),
    expected: ExpectedSpecSchema.optional(),
  })
  .strict();

export type CorpusSample = z.infer<typeof CorpusSampleSchema>;

/** Error carrying the offending 1-based line number for actionable diagnostics. */
export class CorpusLoadError extends Error {
  readonly line: number;
  constructor(line: number, message: string) {
    super(`corpus line ${line}: ${message}`);
    this.name = 'CorpusLoadError';
    this.line = line;
  }
}

/**
 * Parse a JSONL corpus string into validated samples.
 *
 * Validates line by line. A line that is not valid JSON, fails schema
 * validation, or is missing / has an empty `title` is rejected with a
 * `CorpusLoadError` carrying the 1-based line number — never silently skipped.
 * Blank lines (whitespace only) are ignored so trailing newlines are tolerated.
 *
 * Samples missing truth fields (`sam*` / `expected`) are still accepted; only
 * truth-requiring metrics will later skip them.
 */
export function loadCorpus(jsonl: string): CorpusSample[] {
  const lines = jsonl.split('\n');
  const samples: CorpusSample[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const lineNo = i + 1;
    if (raw.trim() === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new CorpusLoadError(lineNo, `invalid JSON (${detail})`);
    }

    const result = CorpusSampleSchema.safeParse(parsed);
    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => {
          const path = issue.path.join('.');
          return path ? `${path}: ${issue.message}` : issue.message;
        })
        .join('; ');
      throw new CorpusLoadError(lineNo, detail);
    }

    samples.push(result.data);
  }

  return samples;
}
