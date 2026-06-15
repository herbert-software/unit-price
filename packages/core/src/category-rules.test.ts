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
// P3.5 dirty-title sample set: 乳品 / 酒类 / 漏判软饮 + cross-cohort 反例.
// --------------------------------------------------------------------------

describe('tagTier1Leaf — P3.5 乳品/酒类/漏判软饮', () => {
  // ---- 乳品 positives ----
  it('牛奶/灭菌乳/巴氏 → milk', () => {
    for (const title of [
      'MM 全脂纯牛奶 1L*12',
      '特仑苏有机纯牛奶 250ml*16',
      '光明优倍鲜牛奶巴氏杀菌 950ml',
      '蒙牛灭菌乳 200ml*24',
    ]) {
      expect(tagTier1Leaf({ title }).leaf).toBe('milk');
    }
  });

  it('酸奶/酸牛奶 → yogurt', () => {
    expect(tagTier1Leaf({ title: '安慕希原味酸奶 200g*10' }).leaf).toBe('yogurt');
    expect(tagTier1Leaf({ title: '简爱裸酸牛奶 135g*12' }).leaf).toBe('yogurt');
  });

  it('乳酸菌/活菌型 → lactic-drink', () => {
    expect(tagTier1Leaf({ title: '养乐多活菌型乳酸菌饮料 100ml*5' }).leaf).toBe(
      'lactic-drink',
    );
  });

  // ---- 酒类 positives (6 叶各自映射, spirits ≠ whisky) ----
  it('赤霞珠红葡萄酒 → wine', () => {
    expect(tagTier1Leaf({ title: '赤霞珠红葡萄酒 750ml' }).leaf).toBe('wine');
    expect(tagTier1Leaf({ title: '智利干红葡萄酒 750ml*6' }).leaf).toBe('wine');
  });

  it('茅台王子酒 53%vol → baijiu (品牌词 茅台)', () => {
    expect(tagTier1Leaf({ title: '茅台王子酒 53%vol 500ml' }).leaf).toBe('baijiu');
    expect(tagTier1Leaf({ title: '泸州老窖头曲浓香型白酒 52度' }).leaf).toBe('baijiu');
  });

  it('国窖1573 → baijiu (品牌词命中、非长尾)', () => {
    expect(tagTier1Leaf({ title: '国窖1573 经典装 500ml' }).leaf).toBe('baijiu');
  });

  it('一番榨啤酒 → beer', () => {
    expect(tagTier1Leaf({ title: '麒麟一番榨啤酒 500ml*24' }).leaf).toBe('beer');
    expect(tagTier1Leaf({ title: '精酿 IPA 小麦啤 330ml*6' }).leaf).toBe('beer');
  });

  it('纯米大吟酿 → sake-fruit-wine', () => {
    expect(tagTier1Leaf({ title: '獭祭纯米大吟酿清酒 720ml' }).leaf).toBe(
      'sake-fruit-wine',
    );
  });

  it('麦卡伦单一麦芽威士忌 → whisky (品牌/型号词)', () => {
    expect(tagTier1Leaf({ title: '麦卡伦12年单一麦芽威士忌 700ml' }).leaf).toBe(
      'whisky',
    );
    expect(tagTier1Leaf({ title: '尊尼获加苏格兰威士忌 700ml' }).leaf).toBe(
      'whisky',
    );
  });

  it('轩尼诗 VSOP 干邑 → spirits (品牌词 轩尼诗/干邑)', () => {
    expect(tagTier1Leaf({ title: '轩尼诗 VSOP 干邑白兰地 700ml' }).leaf).toBe(
      'spirits',
    );
    expect(tagTier1Leaf({ title: '绝对伏特加原味 750ml' }).leaf).toBe('spirits');
  });

  it('spirits ≠ whisky: they are two distinct leaves, never merged', () => {
    expect(tagTier1Leaf({ title: '人头马XO 700ml' }).leaf).toBe('spirits');
    expect(tagTier1Leaf({ title: '波本威士忌 700ml' }).leaf).toBe('whisky');
    // 洋酒(spirits, len 2) + 威士忌(whisky, len 3) co-occur at equal priority;
    // the matchLength tiebreak deterministically picks the longer → whisky.
    expect(tagTier1Leaf({ title: '某洋酒威士忌烈酒礼盒' }).leaf).toBe('whisky');
  });

  // ---- 漏判软饮 positives ----
  it('燕麦奶/椰子水/豆浆 → juice-plant (植物基, 非乳品)', () => {
    expect(tagTier1Leaf({ title: 'oatly 燕麦奶 1L' }).leaf).toBe('juice-plant');
    expect(tagTier1Leaf({ title: '椰树椰子水 1L*6' }).leaf).toBe('juice-plant');
    expect(tagTier1Leaf({ title: '维他醇豆浆 250ml*16' }).leaf).toBe('juice-plant');
    expect(tagTier1Leaf({ title: '椰奶植物蛋白饮 245ml*10' }).leaf).toBe(
      'juice-plant',
    );
  });

  it('NFC 橙汁/葡萄汁/西梅汁 → juice-plant (全词果汁)', () => {
    expect(tagTier1Leaf({ title: '农夫山泉 NFC 橙汁 300ml*5' }).leaf).toBe(
      'juice-plant',
    );
    expect(tagTier1Leaf({ title: '味全每日C西梅汁 300ml' }).leaf).toBe(
      'juice-plant',
    );
  });

  it('电解质水/泉水 → drinking-water', () => {
    expect(tagTier1Leaf({ title: '外星人电解质水 600ml*15' }).leaf).toBe(
      'drinking-water',
    );
  });

  // ---- cross-cohort 误归反例 (样本集必含) ----
  it('零度可乐 / 可口可乐 0 度 → carbonated, never baijiu (禁裸 度 + 软饮优先)', () => {
    expect(tagTier1Leaf({ title: '零度可乐 330ml*24' }).leaf).toBe('carbonated');
    expect(tagTier1Leaf({ title: '可口可乐 0 度 330ml*12' }).leaf).toBe(
      'carbonated',
    );
  });

  it('啤梨汁 → manual (禁裸 啤 → not beer; no juice 全词 hit → no juice-plant)', () => {
    const r = tagTier1Leaf({ title: '丰水啤梨汁 1L' });
    expect(r.leaf).toBeNull();
    expect(r.tie).toBe(false);
  });

  it('香槟色气泡水 → drinking-water (命中 气泡水, 禁裸 香槟 → not wine)', () => {
    const r = tagTier1Leaf({ title: '某品牌香槟色气泡水 330ml' });
    expect(r.leaf).toBe('drinking-water');
  });

  it('巴黎水葡萄汁味气泡水 → juice-plant (全词 葡萄汁, 非 wine)', () => {
    // 葡萄汁 (juice-plant) and 气泡水 (drinking-water) both hit; juice-plant has
    // higher priority (20 > 10). Either way it is a soft-drink, never wine
    // (禁裸 葡萄 → 葡萄酒 keyword 葡萄酒 not a substring of 葡萄汁).
    const r = tagTier1Leaf({ title: '巴黎水葡萄汁味气泡水 330ml' });
    expect(r.leaf).toBe('juice-plant');
  });

  it('山楂酒 → manual (山楂酒 ⊉ 山楂汁 且无酒类关键词)', () => {
    const r = tagTier1Leaf({ title: '同仁堂山楂酒 500ml' });
    expect(r.leaf).toBeNull();
    expect(r.tie).toBe(false);
  });

  it('果酒/梅酒 → sake-fruit-wine, never juice-plant (全词 果酒 ⊄ 果汁)', () => {
    expect(tagTier1Leaf({ title: '梅见青梅酒 330ml' }).leaf).toBe(
      'sake-fruit-wine',
    );
    expect(tagTier1Leaf({ title: '某牌桂花果酒 500ml' }).leaf).toBe(
      'sake-fruit-wine',
    );
  });

  it('稀奶油 → not any beverage leaf (烹饪料, 禁裸 奶 → not milk)', () => {
    const r = tagTier1Leaf({ title: '英国进口紫米勒稀奶油 1L' });
    expect(r.leaf).toBeNull();
    expect(r.tie).toBe(false);
  });

  it('青岛啤酒风味苏打水 → drinking-water (软饮叶 priority 优先于酒类叶, 共现兜底)', () => {
    // Both 苏打水 (drinking-water, priority 10) and 啤酒 (beer, priority 5) hit;
    // the soft-drink leaf MUST win by the priority order — locks the cross-cohort
    // arbitration, not just the bare-char ban.
    const r = tagTier1Leaf({ title: '青岛啤酒风味苏打水 330ml*6' });
    expect(r.leaf).toBe('drinking-water');
  });

  it('未列入纯品牌长尾 → manual (无类型词且品牌不在规则表)', () => {
    // 剑南春/水井坊 are NOT in the keyword tables and these titles carry no
    // type word → correctly fall to 待人工 (诚实边界, 非误归).
    for (const title of ['剑南春水晶剑 500ml', '水井坊井台装 500ml']) {
      const r = tagTier1Leaf({ title });
      expect(r.leaf).toBeNull();
      expect(r.tie).toBe(false);
    }
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
