// Read-only rankings screen. Consumes the prod GET /rankings via
// @unit-price/api-client (buildRankingsUrl + parseRankingsResponse) over
// Taro.request. NO entry/scan/photo path, NO core tier1/calc on device — the
// list is already-computed per100ml from /rankings.
//
// Renders the spec's three states (loading / empty / error) with the two error
// positions kept distinct (whole-screen first-screen error vs list-preserving
// page error), pull-to-refresh + reach-bottom pagination, and the degraded
// in-list ad slot (zero-height in v1).
import { View, Text } from '@tarojs/components';
import { useLoad, usePullDownRefresh, useReachBottom } from '@tarojs/taro';
import Taro from '@tarojs/taro';
import { Fragment } from 'react';
import type { RankingsItem } from '@unit-price/api-client';
import { useRankings } from './useRankings';
import { isAdSlotAfterRank } from './adSlots';
import AdSlot from '../../components/AdSlot';

import './index.css';

/** Format integer cents → yuan string with 2 decimals (display precision only).
 *  This is the per-PACKAGE reference price (priceCents/100); it is NEVER used to
 *  derive or replace per100ml (the authoritative comparable unit price). */
function formatYuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Format the comparable unit price (元 / 100ml) for display. per100ml is the
 *  server-computed comparable truth; shown verbatim, not back-derived. */
function formatPer100ml(per100ml: number): string {
  return per100ml.toFixed(2);
}

function RankingRow({ item }: { item: RankingsItem }) {
  return (
    <View className="row">
      <View className="row__rank">
        <Text className="row__rank-num">{item.rank}</Text>
      </View>
      <View className="row__body">
        <Text className="row__title">{item.title}</Text>
        <View className="row__meta">
          <Text className="row__per100ml">{formatPer100ml(item.per100ml)} 元/100ml</Text>
          <Text className="row__price">整件 ¥{formatYuan(item.priceCents)}</Text>
        </View>
      </View>
    </View>
  );
}

export default function Index() {
  const r = useRankings();

  useLoad(() => {
    r.loadFirst();
  });

  // Pull-to-refresh: reset offset=0, replace the list; stop the native spinner
  // once the request settles (success OR failure).
  usePullDownRefresh(() => {
    void r.refresh().finally(() => {
      void Taro.stopPullDownRefresh();
    });
  });

  // Reach-bottom: append the next page (no-op while loading / at end / in a
  // first-screen error / when a page error is pending its local retry).
  useReachBottom(() => {
    r.loadNext();
  });

  // FIRST-SCREEN error: whole-screen error + retry. Never a white screen.
  if (r.phase === 'error') {
    return (
      <View className="screen screen--center">
        <Text className="state__title">榜单加载失败</Text>
        <Text className="state__hint">请检查网络后重试</Text>
        <View className="btn" onClick={() => r.retryFirst()}>
          <Text className="btn__text">重试</Text>
        </View>
      </View>
    );
  }

  // First-screen loading (no list yet).
  if (r.phase === 'idle' || (r.phase === 'loading' && r.items.length === 0)) {
    return (
      <View className="screen screen--center">
        <Text className="state__hint">加载中…</Text>
      </View>
    );
  }

  // Empty state: a validated [] from /rankings → explicit empty, not blank/error.
  if (r.phase === 'ready' && r.items.length === 0) {
    return (
      <View className="screen screen--center">
        <Text className="state__title">榜单暂无数据</Text>
        <Text className="state__hint">下拉刷新试试</Text>
      </View>
    );
  }

  // Ready with items: render the list (per100ml ascending, already sorted by the
  // server) interleaved with degraded ad slots after render rank 10/22/34/…
  return (
    <View className="screen">
      <View className="list">
        {r.items.map((item) => {
          const showAdAfter = isAdSlotAfterRank(item.rank);
          return (
            <Fragment key={`${item.store}:${item.storeSku}:${item.rank}`}>
              <RankingRow item={item} />
              {showAdAfter ? <AdSlot id={`ad-slot-after-${item.rank}`} /> : null}
            </Fragment>
          );
        })}
      </View>

      {/* Footer: page-load spinner OR page-error local retry (list preserved). */}
      {r.pageLoading ? (
        <View className="footer">
          <Text className="state__hint">加载中…</Text>
        </View>
      ) : null}
      {r.pageError ? (
        <View className="footer">
          <Text className="state__hint">下一页加载失败</Text>
          <View className="btn btn--small" onClick={() => r.retryNext()}>
            <Text className="btn__text">重试本页</Text>
          </View>
        </View>
      ) : null}
      {r.reachedEnd && !r.pageError ? (
        <View className="footer">
          <Text className="state__hint">已到底</Text>
        </View>
      ) : null}
    </View>
  );
}
