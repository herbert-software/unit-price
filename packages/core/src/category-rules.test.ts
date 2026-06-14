import { describe, expect, it } from 'vitest';
import {
  arbitrate,
  tagTier1Attributes,
  tagTier1Leaf,
  type StoreMapResult,
  type Tier1LeafResult,
} from './category-rules.js';

// --------------------------------------------------------------------------
// 1.2 tier1 leaf keyword rules — dirty-title sample set.
// --------------------------------------------------------------------------

describe('tagTier1Leaf — leaf attribution', () => {
  it('可乐/汽水/雪碧 → carbonated', () => {
    for (const title of [
      '可口可乐 无糖 330ml*24',
      '雪碧柠檬味汽水 330ml*12',
      '芬达橙味汽水 500ml',
    ]) {
      const r = tagTier1Leaf({ title });
      expect(r.leaf).toBe('carbonated');
      expect(r.tie).toBe(false);
    }
  });

  it('果汁/植物饮 → juice-plant', () => {
    const r = tagTier1Leaf({ title: '农夫山泉NFC橙汁果汁 300ml*5' });
    expect(r.leaf).toBe('juice-plant');
  });

  it('茶/咖啡/能量 → coffee-tea', () => {
    expect(tagTier1Leaf({ title: '东方树叶乌龙茶 500ml*15' }).leaf).toBe('coffee-tea');
    expect(tagTier1Leaf({ title: '雀巢丝滑拿铁咖啡 268ml*15' }).leaf).toBe('coffee-tea');
    expect(tagTier1Leaf({ title: '红牛维生素功能能量饮料 250ml*24' }).leaf).toBe(
      'coffee-tea',
    );
  });

  it('矿泉水/纯净水 → drinking-water', () => {
    expect(tagTier1Leaf({ title: '怡宝纯净水 555ml*24' }).leaf).toBe('drinking-water');
    expect(tagTier1Leaf({ title: '百岁山饮用天然矿泉水 570ml*24' }).leaf).toBe(
      'drinking-water',
    );
  });

  // sparkling/soda water goes to drinking-water (NOT carbonated); its keywords
  // (苏打水/气泡水) never overlap with carbonated's (可乐/汽水/雪碧/碳酸).
  it('苏打水/气泡水/含气矿泉 → drinking-water, never carbonated', () => {
    for (const title of [
      '屈臣氏苏打水 330ml*24',
      '巴黎水气泡水柠檬味 330ml*24',
      '圣培露含气矿泉水 500ml*24',
    ]) {
      const r = tagTier1Leaf({ title });
      expect(r.leaf).toBe('drinking-water');
      expect(r.leaf).not.toBe('carbonated');
    }
  });

  it('no keyword hit → null leaf, no tie', () => {
    const r = tagTier1Leaf({ title: '某不明商品 礼盒装 1套' });
    expect(r.leaf).toBeNull();
    expect(r.tie).toBe(false);
    expect(r.candidates).toEqual([]);
  });

  it('multi-leaf equal-priority tie → null leaf + tie=true', () => {
    // juice-plant (果汁) and coffee-tea (咖啡) share priority 20, depth, and an
    // equal 2-char match length → indistinguishable on all three keys = tie.
    const r = tagTier1Leaf({ title: '果汁咖啡混合饮 300ml' });
    expect(r.leaf).toBeNull();
    expect(r.tie).toBe(true);
    expect(r.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it('higher-priority leaf wins over lower-priority co-hit', () => {
    // carbonated (priority 30) beats drinking-water (priority 10) when both hit.
    const r = tagTier1Leaf({ title: '可乐味苏打水气泡 330ml' });
    expect(r.leaf).toBe('carbonated');
    expect(r.tie).toBe(false);
  });
});

// --------------------------------------------------------------------------
// 1.3 attribute rules.
// --------------------------------------------------------------------------

describe('tagTier1Attributes', () => {
  it('无糖 → sugar-free', () => {
    const hits = tagTier1Attributes({ title: '可口可乐 无糖 330ml*24' });
    expect(hits.map((h) => h.slug)).toContain('sugar-free');
  });

  it('气泡/苏打 → sparkling', () => {
    expect(
      tagTier1Attributes({ title: '屈臣氏苏打水 330ml*24' }).map((h) => h.slug),
    ).toContain('sparkling');
    expect(
      tagTier1Attributes({ title: '巴黎水气泡水 330ml' }).map((h) => h.slug),
    ).toContain('sparkling');
  });

  it('进口 → imported', () => {
    expect(
      tagTier1Attributes({ title: '原装进口 圣培露气泡水 500ml' }).map((h) => h.slug),
    ).toEqual(expect.arrayContaining(['imported', 'sparkling']));
  });

  it('no attribute keyword → empty', () => {
    expect(tagTier1Attributes({ title: '怡宝纯净水 555ml*24' })).toEqual([]);
  });

  // Attributes are orthogonal to the leaf: sparkling on a drinking-water leaf.
  it('气泡水 carries sparkling attribute but stays drinking-water leaf', () => {
    const title = '屈臣氏苏打水 330ml*24';
    expect(tagTier1Leaf({ title }).leaf).toBe('drinking-water');
    expect(tagTier1Attributes({ title }).map((h) => h.slug)).toContain('sparkling');
  });
});

// --------------------------------------------------------------------------
// 1.4 deterministic arbitration — taxonomy §五 full table.
// --------------------------------------------------------------------------

function tier1Leaf(slug: Tier1LeafResult['leaf']): Tier1LeafResult {
  return { leaf: slug, tie: false, candidates: [] };
}
const tier1Tie: Tier1LeafResult = { leaf: null, tie: true, candidates: [] };
const tier1None: Tier1LeafResult = { leaf: null, tie: false, candidates: [] };

const smLeaf = (slug: 'carbonated' | 'juice-plant'): StoreMapResult => ({
  kind: 'leaf',
  leafSlug: slug,
});
const smCoarse: StoreMapResult = { kind: 'coarse', coarseNodeSlug: 'soft-drink' };
const smNone: StoreMapResult = { kind: 'none' };

describe('arbitrate — taxonomy §五', () => {
  it('① granularity conflict: tier1 leaf vs store-map coarse → deeper leaf (tier1)', () => {
    const v = arbitrate(tier1Leaf('carbonated'), smCoarse);
    expect(v).toEqual({ verdict: 'leaf', leafSlug: 'carbonated', decidedBy: 'tier1' });
  });

  it('② same-granularity different leaf → tier1 > store-map', () => {
    const v = arbitrate(tier1Leaf('carbonated'), smLeaf('juice-plant'));
    expect(v).toEqual({ verdict: 'leaf', leafSlug: 'carbonated', decidedBy: 'tier1' });
  });

  it('② both hit same leaf → that leaf', () => {
    const v = arbitrate(tier1Leaf('carbonated'), smLeaf('carbonated'));
    expect(v).toEqual({ verdict: 'leaf', leafSlug: 'carbonated', decidedBy: 'tier1' });
  });

  it('③ only tier1 leaf → take it', () => {
    const v = arbitrate(tier1Leaf('juice-plant'), smNone);
    expect(v).toEqual({ verdict: 'leaf', leafSlug: 'juice-plant', decidedBy: 'tier1' });
  });

  it('③ only store-map clean leaf → take it', () => {
    const v = arbitrate(tier1None, smLeaf('carbonated'));
    expect(v).toEqual({ verdict: 'leaf', leafSlug: 'carbonated', decidedBy: 'store-map' });
  });

  // store-map can carry ANY leaf, not just the soft-drink set: a tier1 miss +
  // a non-soft-drink leaf (e.g. baijiu) → that leaf, decidedBy store-map — never
  // forced down to coarse/manual (the leaf's rankability is a downstream concern).
  it('③ only store-map non-soft-drink leaf (baijiu) → take it', () => {
    const v = arbitrate(tier1None, { kind: 'leaf', leafSlug: 'baijiu' });
    expect(v).toEqual({ verdict: 'leaf', leafSlug: 'baijiu', decidedBy: 'store-map' });
  });

  // The headline rule: tier1 tie + clean store-map leaf → take store-map, do
  // NOT lock 待人工.
  it('③ tier1 tie but store-map clean leaf → take store-map leaf (not manual)', () => {
    const v = arbitrate(tier1Tie, smLeaf('juice-plant'));
    expect(v).toEqual({
      verdict: 'leaf',
      leafSlug: 'juice-plant',
      decidedBy: 'store-map',
    });
  });

  it('③ only store-map coarse node → 待细化 (pending)', () => {
    const v = arbitrate(tier1None, smCoarse);
    expect(v).toEqual({ verdict: 'pending', pendingNodeSlug: 'soft-drink' });
  });

  it('④ both no determinate leaf (tier1 none + store-map none) → 待人工', () => {
    const v = arbitrate(tier1None, smNone);
    expect(v).toEqual({ verdict: 'manual' });
  });

  it('④ tier1 tie + store-map none → 待人工', () => {
    const v = arbitrate(tier1Tie, smNone);
    expect(v).toEqual({ verdict: 'manual' });
  });
});

// --------------------------------------------------------------------------
// End-to-end working examples from taxonomy §二/§五.
// --------------------------------------------------------------------------

describe('working examples (taxonomy §二/§五)', () => {
  it('可口可乐 无糖 → carbonated + sugar-free', () => {
    const title = '可口可乐 无糖 330ml*24';
    const leaf = tagTier1Leaf({ title });
    expect(leaf.leaf).toBe('carbonated');
    const attrs = tagTier1Attributes({ title }).map((h) => h.slug);
    expect(attrs).toContain('sugar-free');
    // Arbiter with store-map none → carbonated leaf.
    expect(arbitrate(leaf, { kind: 'none' })).toEqual({
      verdict: 'leaf',
      leafSlug: 'carbonated',
      decidedBy: 'tier1',
    });
  });

  it('屈臣氏苏打水 → drinking-water + sparkling (not carbonated)', () => {
    const title = '屈臣氏苏打水 330ml*24';
    const leaf = tagTier1Leaf({ title });
    expect(leaf.leaf).toBe('drinking-water');
    expect(tagTier1Attributes({ title }).map((h) => h.slug)).toContain('sparkling');
    expect(arbitrate(leaf, { kind: 'none' })).toEqual({
      verdict: 'leaf',
      leafSlug: 'drinking-water',
      decidedBy: 'tier1',
    });
  });
});
