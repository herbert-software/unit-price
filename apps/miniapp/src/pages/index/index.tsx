// Read-only rankings home (榜单 Tab). Composes the P1 shared components per the
// P0 design baseline (design/sams-zhibuzhi/index.html) in order: brand head →
// search entry → static scope bar → ranking list.
//
// Consumes prod GET /rankings via @unit-price/api-client (buildRankingsUrl +
// parseRankingsResponse, jitless) over Taro.request — wired through useRankings.
// NO entry/scan/photo path, NO core tier1/calc on device: the list is
// already-computed per100ml from /rankings. The search entry is a real input that,
// on confirm, navigates to the board list page reused for search (GET /rankings?q=…,
// still READ-ONLY); it NEVER computes or reorders the list on device.
//
// Data layer (the state machine + Taro lifecycle hooks) stays in the page (D4);
// the components are pure presentation. Renders the spec's three states (loading
// / empty / first-screen error) with the two error positions kept distinct
// (whole-screen first-screen error vs list-preserving page error), pull-to-refresh
// + reach-bottom pagination, and the degraded in-list ad slot (zero-height in v1).
import { View, Text } from '@tarojs/components';
import { useLoad, usePullDownRefresh, useReachBottom } from '@tarojs/taro';
import Taro from '@tarojs/taro';
import { Fragment } from 'react';
import { useRankings } from './useRankings';
import { isAdSlotAfterRank } from './adSlots';
import AdSlot from '../../components/AdSlot';
import BrandHead from '../../components/BrandHead';
import SearchEntry from '../../components/SearchEntry';
import ScopeBar from '../../components/ScopeBar';
import RankingRow from '../../components/RankingRow';
import ListFooter from '../../components/ListFooter';
import { ListLoading, ListEmpty, FirstScreenError } from '../../components/ListStates';

import './index.css';

/** Header block shown above every list state so the brand / search / scope are
 *  present whether the list is loading, empty, errored, or ready. */
function Header() {
  return (
    <Fragment>
      <BrandHead />
      {/* Real input: on confirm it navigates to the board list page reused for
          search (board?q=…). NO request fires here; the board page makes the
          read-only GET /rankings?q=… call. See SearchEntry. */}
      <SearchEntry />
      {/* 比价辅入口(视觉次于搜索)。主入口是搜索无结果态的 ComputeCta;此处给
          「搜索前就知道没收录」的用户一个常驻 handle。→ pages/compute。 */}
      <View
        className="homecalc"
        onClick={() => { void Taro.navigateTo({ url: '/pages/compute/index' }); }}
      >
        <Text className="homecalc__t">
          店里有、榜上没有的？<Text className="homecalc__lnk">输入规格算单价 ›</Text>
        </Text>
      </View>
      <ScopeBar />
    </Fragment>
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

  // FIRST-SCREEN error: whole-screen error + retry. Never a blank screen. Error
  // judgement stays in useRankings (unchanged); the page just renders it.
  if (r.phase === 'error') {
    return (
      <View className="screen">
        <Header />
        <FirstScreenError onRetry={() => r.retryFirst()} />
      </View>
    );
  }

  // First-screen loading (no list yet).
  if (r.phase === 'idle' || (r.phase === 'loading' && r.items.length === 0)) {
    return (
      <View className="screen">
        <Header />
        <ListLoading />
      </View>
    );
  }

  // Empty state: a validated [] from /rankings → explicit empty, not blank/error.
  if (r.phase === 'ready' && r.items.length === 0) {
    return (
      <View className="screen">
        <Header />
        <ListEmpty />
      </View>
    );
  }

  // Ready with items: render the list (per100ml ascending, already sorted by the
  // server) interleaved with degraded ad slots after render rank 10/22/34/…
  return (
    <View className="screen">
      <Header />
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

      <ListFooter
        pageLoading={r.pageLoading}
        pageError={r.pageError}
        reachedEnd={r.reachedEnd}
        onRetryNext={() => r.retryNext()}
      />
    </View>
  );
}
