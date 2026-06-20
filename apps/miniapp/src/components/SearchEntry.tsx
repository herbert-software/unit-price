// Search entry — REAL input (P4 ".search"). A Taro `Input`: on confirm it
// normalizes the term by code points and, when valid (≥ 2 code points), navigates
// to the board list page reused for search (`?q=<encoded term>`, NO `name`).
// Still READ-ONLY: no parse / no unit-price calc / no entry / scan / photo path —
// board just runs GET /rankings?q=<term> via api-client.
//
// The magnifier glyph is drawn with bordered Views using currentColor (which
// inherits the placeholder text color, var(--muted)) — NO inline hex.
import { View, Input } from '@tarojs/components';
import type { BaseEventOrig, InputProps } from '@tarojs/components';
import Taro from '@tarojs/taro';

import { normalizeSearchTerm } from './searchTerm';
import './SearchEntry.css';

export const SEARCH_PLACEHOLDER = '搜软饮名，如 元气森林 / 无糖可乐';

export default function SearchEntry() {
  const onConfirm = (e: BaseEventOrig<InputProps.inputValueEventDetail>) => {
    const result = normalizeSearchTerm(e.detail.value ?? '');
    if (result.kind === 'empty') return; // no intent → no nav, no request
    if (result.kind === 'too-short') {
      // Single code point: too wide (server 400 parity) → inline hint, no nav.
      void Taro.showToast({ title: '至少输入 2 个字', icon: 'none' });
      return;
    }
    // ≥ 2 code points: navigate to the board list page reused for search. Only `q`
    // (encoded), NO `name` — q is the single free-text param under deterministic
    // decode; board derives the title from the decoded q.
    void Taro.navigateTo({
      url: `/pages/board/index?q=${encodeURIComponent(result.term)}`,
    });
  };

  return (
    <View className="searchentry">
      {/* Magnifier: a ring + a handle, stroked in currentColor (inherits --muted). */}
      <View className="searchentry__icon">
        <View className="searchentry__icon-ring" />
        <View className="searchentry__icon-handle" />
      </View>
      <Input
        className="searchentry__input"
        type="text"
        confirmType="search"
        placeholder={SEARCH_PLACEHOLDER}
        placeholderClass="searchentry__placeholder"
        onConfirm={onConfirm}
      />
    </View>
  );
}
