// HAR extractor — build golden-set corpus samples from a packet-capture HAR.
//
// Parses a HAR (HTTP Archive) log, locates Sam's Club product-list responses
// (host `api-sams.walmartmobile.cn`, path containing `/goods-portal/grouping/list`),
// de-duplicates products by `spuId` (keeping the FIRST occurrence), and emits
// only the calibration-relevant fields into `CorpusSample`s.
//
// Hard contract (see spec "HAR 提取器"):
//  - dedupe by spuId, keep first occurrence; source = `har:<basename>`
//  - `priceInfo[0].price` is a cents string ("10990" = ¥109.90) → integer
//    `priceCents`; missing / non-numeric → omit priceCents, count "no-price"
//  - `smallPackagePriceDisplay` is a display string (`￥18.32/瓶`) → parse to a
//    single numeric `samUnitPrice` (yuan); unparseable (promo / range / missing)
//    → omit, count "no-unit-price"
//  - never write raw responses or auth / personal fields into the corpus
//  - non-product responses are ignored (not errors)
//  - corrupt / truncated / non-JSON body → skip that response and count it,
//    never crash or abort the whole extraction

import { z } from 'zod';
import type { CorpusSample } from './corpus.js';
import { CorpusSampleSchema } from './corpus.js';

/** Result of extracting one HAR file. */
export interface ExtractResult {
  /** Validated corpus samples (deduped by spuId, first occurrence kept). */
  samples: CorpusSample[];
  /** Number of product-list responses skipped due to a corrupt / non-JSON body. */
  skippedBodies: number;
  /** Number of products with no parseable price (priceCents omitted). */
  noPrice: number;
  /** Number of products with no parseable unit price (samUnitPrice omitted). */
  noUnitPrice: number;
}

const PRODUCT_LIST_HOST = 'api-sams.walmartmobile.cn';
const PRODUCT_LIST_PATH = '/goods-portal/grouping/list';

// Minimal, tolerant view of the HAR structures we touch. We deliberately avoid
// validating the whole HAR — only the few fields we read. Unknown / missing
// shapes degrade to "skip" rather than throw.
interface HarEntryContent {
  text?: unknown;
  encoding?: unknown;
}
interface HarEntry {
  request?: { url?: unknown };
  response?: { content?: HarEntryContent };
}

/** True when a URL points at the Sam's Club product-list endpoint. */
function isProductListUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  return url.includes(PRODUCT_LIST_HOST) && url.includes(PRODUCT_LIST_PATH);
}

/**
 * Decode a HAR response body. base64-encoded bodies are decoded; everything
 * else is treated as a raw UTF-8 string. Returns `null` when no usable text is
 * present.
 */
function decodeBody(content: HarEntryContent | undefined): string | null {
  if (!content || typeof content.text !== 'string') return null;
  const text = content.text;
  if (content.encoding === 'base64') {
    try {
      return Buffer.from(text, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  return text;
}

// Shape of a single product in `data.dataList[]`. All fields tolerant — the
// extractor maps what it can and omits the rest.
const ProductSchema = z
  .object({
    spuId: z.union([z.string(), z.number()]).optional(),
    title: z.string().optional(),
    priceInfo: z
      .array(z.object({ price: z.unknown() }).passthrough())
      .optional(),
    smallPackageNum: z.unknown().optional(),
    smallPackageUnit: z.unknown().optional(),
    smallPackagePriceDisplay: z.unknown().optional(),
    isCompare: z.unknown().optional(),
  })
  .passthrough();

const ProductListBodySchema = z
  .object({
    data: z
      .object({
        dataList: z.array(z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * Parse `priceInfo[0].price` (cents string, e.g. "10990") into an integer cent
 * count. Returns `null` when missing or non-numeric (caller counts "no-price").
 */
export function parsePriceCents(priceInfo: unknown): number | null {
  if (!Array.isArray(priceInfo) || priceInfo.length === 0) return null;
  const first = priceInfo[0] as { price?: unknown } | undefined;
  const raw = first?.price;
  if (typeof raw === 'number') {
    // Negative prices are nonsensical here → null (aligns with the string
    // branch's `/^\d+$/`, which is implicitly non-negative).
    return Number.isInteger(raw) && raw >= 0 ? raw : null;
  }
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || !/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Parse Sam's display string `smallPackagePriceDisplay` (e.g. `￥18.32/瓶`) into
 * a single numeric per-unit price in yuan. Returns `null` when the string is
 * missing, holds a price range, or otherwise does not reduce to exactly one
 * number (promo copy / range price / unusual format) — caller counts
 * "no-unit-price".
 */
export function parseUnitPriceDisplay(display: unknown): number | null {
  if (typeof display !== 'string') return null;
  const matches = display.match(/\d+(?:\.\d+)?/g);
  // Exactly one numeric token → a single unit price. Zero (no digits) or more
  // than one (range like "18.32~20.00") are treated as unparseable.
  if (!matches || matches.length !== 1) return null;
  const n = Number(matches[0]);
  // A displayed unit price of 0 (or below) carries no usable truth → null.
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Coerce an optional integer field (`smallPackageNum`). Non-integer → omit. */
function toOptionalInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    if (Number.isSafeInteger(n)) return n;
  }
  return undefined;
}

/** Coerce an optional non-empty string field (`smallPackageUnit`). */
function toOptionalString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value;
  return undefined;
}

/** Stringify a spuId (string or number) into a stable dedupe key. */
function spuKey(spuId: unknown): string | null {
  if (typeof spuId === 'string' && spuId !== '') return spuId;
  if (typeof spuId === 'number') return String(spuId);
  return null;
}

/**
 * Extract corpus samples from a HAR file's parsed JSON content.
 *
 * @param harJson  the parsed HAR document (`{ log: { entries: [...] } }`)
 * @param source   provenance marker for emitted samples, e.g. `har:cap.har`
 */
export function extractFromHar(harJson: unknown, source: string): ExtractResult {
  const result: ExtractResult = {
    samples: [],
    skippedBodies: 0,
    noPrice: 0,
    noUnitPrice: 0,
  };

  const entries = (harJson as { log?: { entries?: unknown } } | undefined)?.log
    ?.entries;
  if (!Array.isArray(entries)) return result;

  const seen = new Set<string>();

  for (const rawEntry of entries) {
    const entry = rawEntry as HarEntry;
    const url = entry?.request?.url;
    if (!isProductListUrl(url)) continue; // non-product response → ignore

    const bodyText = decodeBody(entry?.response?.content);
    if (bodyText === null) {
      result.skippedBodies += 1;
      continue;
    }

    let bodyJson: unknown;
    try {
      bodyJson = JSON.parse(bodyText);
    } catch {
      result.skippedBodies += 1; // truncated / non-JSON body → skip + count
      continue;
    }

    const parsedBody = ProductListBodySchema.safeParse(bodyJson);
    if (!parsedBody.success) {
      result.skippedBodies += 1;
      continue;
    }

    const dataList = parsedBody.data.data?.dataList;
    if (!Array.isArray(dataList)) continue; // shape present but no products

    for (const rawProduct of dataList) {
      const parsedProduct = ProductSchema.safeParse(rawProduct);
      if (!parsedProduct.success) continue;
      const product = parsedProduct.data;

      const key = spuKey(product.spuId);
      if (key === null) continue; // no dedupe key → skip
      if (seen.has(key)) continue; // dedupe: keep first occurrence
      seen.add(key);

      if (typeof product.title !== 'string' || product.title.trim() === '') {
        continue; // title is mandatory in the corpus schema
      }

      const sample: Record<string, unknown> = {
        title: product.title,
        source,
      };

      const priceCents = parsePriceCents(product.priceInfo);
      if (priceCents === null) {
        result.noPrice += 1;
      } else {
        sample.priceCents = priceCents;
      }

      const samPkgNum = toOptionalInt(product.smallPackageNum);
      if (samPkgNum !== undefined) sample.samPkgNum = samPkgNum;

      const samPkgUnit = toOptionalString(product.smallPackageUnit);
      if (samPkgUnit !== undefined) sample.samPkgUnit = samPkgUnit;

      const samUnitPrice = parseUnitPriceDisplay(product.smallPackagePriceDisplay);
      if (samUnitPrice === null) {
        result.noUnitPrice += 1;
      } else {
        sample.samUnitPrice = samUnitPrice;
      }

      if (typeof product.isCompare === 'boolean') {
        sample.isCompare = product.isCompare;
      }

      // Validate against the corpus schema before emitting — guarantees the
      // output is loadCorpus-clean and that no stray raw / auth fields leak in
      // (`.strict()` rejects unknown keys).
      const validated = CorpusSampleSchema.safeParse(sample);
      if (validated.success) {
        result.samples.push(validated.data);
      }
    }
  }

  return result;
}
