import { describe, expect, it } from 'vitest';
import { loadCorpus } from './corpus.js';
import {
  extractFromHar,
  parsePriceCents,
  parseUnitPriceDisplay,
} from './har.js';

const PRODUCT_LIST_URL =
  'https://api-sams.walmartmobile.cn/api/v1/sams/goods-portal/grouping/list?x=1';

/** Build a HAR entry for a product-list response with the given JSON body. */
function productListEntry(body: unknown): unknown {
  return {
    request: { url: PRODUCT_LIST_URL },
    response: { content: { text: JSON.stringify(body) } },
  };
}

/** Build a HAR entry with a raw (already-stringified) body text. */
function rawBodyEntry(url: string, text: string, encoding?: string): unknown {
  return {
    request: { url },
    response: { content: encoding ? { text, encoding } : { text } },
  };
}

function har(entries: unknown[]): unknown {
  return { log: { entries } };
}

function product(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    spuId: 'spu-1',
    title: '默认标题',
    priceInfo: [{ price: '10990' }],
    smallPackageNum: 6,
    smallPackageUnit: '瓶',
    smallPackagePriceDisplay: '￥18.32/瓶',
    isCompare: true,
    ...overrides,
  };
}

describe('parsePriceCents', () => {
  it('parses a cents string into an integer', () => {
    expect(parsePriceCents([{ price: '10990' }])).toBe(10990);
  });

  it('returns null for empty / missing priceInfo', () => {
    expect(parsePriceCents([])).toBeNull();
    expect(parsePriceCents(undefined)).toBeNull();
  });

  it('returns null for a non-numeric price string', () => {
    expect(parsePriceCents([{ price: '促销价' }])).toBeNull();
    expect(parsePriceCents([{ price: '10.99' }])).toBeNull();
    expect(parsePriceCents([{ price: '' }])).toBeNull();
  });

  it('returns null for a negative numeric price', () => {
    expect(parsePriceCents([{ price: -5 }])).toBeNull();
  });
});

describe('parseUnitPriceDisplay', () => {
  it('parses a display string into a number', () => {
    expect(parseUnitPriceDisplay('￥18.32/瓶')).toBe(18.32);
    expect(parseUnitPriceDisplay('1.5/罐')).toBe(1.5);
  });

  it('returns null for a zero (≤0) unit price', () => {
    expect(parseUnitPriceDisplay('￥0/瓶')).toBeNull();
  });

  it('returns null for a range / multi-number string', () => {
    expect(parseUnitPriceDisplay('￥18.32~20.00/瓶')).toBeNull();
  });

  it('returns null for promo copy / missing / no digits', () => {
    expect(parseUnitPriceDisplay('促销价')).toBeNull();
    expect(parseUnitPriceDisplay(null)).toBeNull();
    expect(parseUnitPriceDisplay(undefined)).toBeNull();
  });
});

describe('extractFromHar', () => {
  it('extracts calibration fields and produces loadCorpus-clean samples', () => {
    const result = extractFromHar(
      har([productListEntry({ data: { dataList: [product({})] } })]),
      'har:cap.har',
    );

    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]).toEqual({
      title: '默认标题',
      source: 'har:cap.har',
      priceCents: 10990,
      samPkgNum: 6,
      samPkgUnit: '瓶',
      samUnitPrice: 18.32,
      isCompare: true,
    });

    // Round-trips through the group-A loader/schema.
    const jsonl = result.samples.map((s) => JSON.stringify(s)).join('\n');
    expect(loadCorpus(jsonl)).toHaveLength(1);
  });

  it('dedupes by spuId, keeping the first occurrence', () => {
    const result = extractFromHar(
      har([
        productListEntry({
          data: {
            dataList: [
              product({ spuId: 'dup', title: '第一条', priceCents: undefined }),
              product({ spuId: 'dup', title: '第二条(应被丢弃)' }),
            ],
          },
        }),
        // Same spuId across a second product-list response.
        productListEntry({
          data: { dataList: [product({ spuId: 'dup', title: '第三条' })] },
        }),
      ]),
      'har:cap.har',
    );

    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]?.title).toBe('第一条');
  });

  it('omits priceCents on empty/non-numeric price and counts no-price', () => {
    const result = extractFromHar(
      har([
        productListEntry({
          data: {
            dataList: [
              product({ spuId: 'a', priceInfo: [] }),
              product({ spuId: 'b', priceInfo: [{ price: '促销' }] }),
            ],
          },
        }),
      ]),
      'har:cap.har',
    );

    expect(result.samples).toHaveLength(2);
    expect(result.samples[0]?.priceCents).toBeUndefined();
    expect(result.samples[1]?.priceCents).toBeUndefined();
    expect(result.noPrice).toBe(2);
    // Still corpus-valid.
    const jsonl = result.samples.map((s) => JSON.stringify(s)).join('\n');
    expect(loadCorpus(jsonl)).toHaveLength(2);
  });

  it('omits samUnitPrice on unparseable display and counts no-unit-price', () => {
    const result = extractFromHar(
      har([
        productListEntry({
          data: {
            dataList: [
              product({ spuId: 'a', smallPackagePriceDisplay: null }),
              product({
                spuId: 'b',
                smallPackagePriceDisplay: '￥10~20/瓶',
              }),
            ],
          },
        }),
      ]),
      'har:cap.har',
    );

    expect(result.samples).toHaveLength(2);
    expect(result.samples[0]?.samUnitPrice).toBeUndefined();
    expect(result.samples[1]?.samUnitPrice).toBeUndefined();
    expect(result.noUnitPrice).toBe(2);
  });

  it('ignores non-product responses without erroring', () => {
    const result = extractFromHar(
      har([
        rawBodyEntry('https://example.com/config.json', '{"foo":1}'),
        rawBodyEntry('https://cdn.example.com/img.png', 'not-json-binary'),
        rawBodyEntry(
          'https://api-sams.walmartmobile.cn/api/v1/tracking/report',
          '{"data":{"dataList":[{"spuId":"x","title":"埋点"}]}}',
        ),
        productListEntry({ data: { dataList: [product({ spuId: 'real' })] } }),
      ]),
      'har:cap.har',
    );

    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]?.title).toBe('默认标题');
    expect(result.skippedBodies).toBe(0); // non-product responses are not "skipped bodies"
  });

  it('skips a truncated / non-JSON product-list body and counts it', () => {
    const result = extractFromHar(
      har([
        rawBodyEntry(PRODUCT_LIST_URL, '{"data":{"dataList":[{"spuId":'), // truncated
        rawBodyEntry(PRODUCT_LIST_URL, 'not json at all'),
        productListEntry({ data: { dataList: [product({ spuId: 'ok' })] } }),
      ]),
      'har:cap.har',
    );

    expect(result.samples).toHaveLength(1);
    expect(result.skippedBodies).toBe(2);
  });

  it('decodes a base64-encoded product-list body', () => {
    const body = JSON.stringify({
      data: { dataList: [product({ spuId: 'b64', title: 'B64 标题' })] },
    });
    const result = extractFromHar(
      har([rawBodyEntry(PRODUCT_LIST_URL, Buffer.from(body, 'utf8').toString('base64'), 'base64')]),
      'har:cap.har',
    );

    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]?.title).toBe('B64 标题');
  });

  it('does not crash on a HAR with no entries or a malformed shape', () => {
    expect(extractFromHar({}, 'har:x').samples).toHaveLength(0);
    expect(extractFromHar(null, 'har:x').samples).toHaveLength(0);
    expect(extractFromHar({ log: {} }, 'har:x').samples).toHaveLength(0);
  });
});
