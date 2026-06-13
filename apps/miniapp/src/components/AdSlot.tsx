// In-list native ad slot — DEGRADED placeholder for v1.
//
// v1 connects NO real ad unit and depends on NO 流量主 (the platform's hard gate
// is cumulative UV ≥ 1000; an app on launch day cannot serve ads). So the slot
// is a "position that collapses to nothing":
//   - FILLED (future: a real unit returns an ad) → it occupies the reserved
//     fixed card height.
//   - UNFILLED (v1, ALWAYS) → it renders ZERO-height empty content: no visible
//     placeholder card, the list does not jump.
//
// "No visible placeholder" ≠ "no host node": the wrapper host <View> stays
// mounted (so a future fill can attach), but its subtree is empty in v1, hence
// height===0 and zero visual footprint. (The first-10-rows segment, by contrast,
// renders NO AdSlot at all — truly no ad DOM there; that is enforced by the
// page's insertion rule, not by this component.)
//
// NO interstitial. Rewarded video is deferred (v1 is read-only, no reward hook).
import { View } from '@tarojs/components';

export interface AdSlotProps {
  /** Stable host-node id so a real layout source (Taro.createSelectorQuery /
   *  boundingClientRect) can measure this slot's height in tests / on device. */
  id?: string;
}

// Reserved fixed card height for the FUTURE filled state (rpx). Applied ONLY
// when filled; v1 is never filled so it is never applied. Kept here so future
// wiring has one place to read the reserved height.
export const AD_SLOT_FILLED_HEIGHT_RPX = 180;

export default function AdSlot({ id }: AdSlotProps) {
  // v1: hard-coded unfilled. When a real ad unit is wired, this becomes data
  // (e.g. driven by an ad-load callback) and the filled branch renders the unit
  // inside a fixed-height card.
  const filled = false;

  if (!filled) {
    // Zero-height empty content. The host node exists for future mount, carries
    // NO height/padding/border, and an explicit height:0 so the layout source
    // measures exactly 0 (real layout, not jsdom's always-0 stub).
    return (
      <View
        id={id}
        className="ad-slot ad-slot--empty"
        style={{ height: '0', padding: '0', margin: '0', overflow: 'hidden' }}
      />
    );
  }

  // Unreachable in v1. Reserved fixed-height card for a future filled ad unit.
  return (
    <View
      id={id}
      className="ad-slot ad-slot--filled"
      style={{ height: `${AD_SLOT_FILLED_HEIGHT_RPX}rpx` }}
    >
      <View className="ad-slot__unit">{/* future: real ad unit mounts here */}</View>
    </View>
  );
}
