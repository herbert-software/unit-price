// Category-scoped rankings board (分类榜) — the per-cohort, per100ml-ascending
// list reached by tapping a rankable node in the 分类 Tab. Non-tab page (has a
// back button); the nav title is the tapped category's Chinese name.
//
// Reuses the 榜单 Tab's tested data layer VERBATIM: useRankings(category) threads
// the category slug into buildRankingsUrl → GET /rankings?category=<slug>. Same
// three-state render + pagination + page-error semantics; only the header chrome
// (brand / search / scope / ads) is dropped — a board is just the list.
import { View } from '@tarojs/components';
import Taro, { useRouter, useLoad, usePullDownRefresh, useReachBottom } from '@tarojs/taro';
import { useRankings } from '../index/useRankings';
import { readBoardParams } from './params';
import RankingRow from '../../components/RankingRow';
import ListFooter from '../../components/ListFooter';
import { ListLoading, ListEmpty, FirstScreenError } from '../../components/ListStates';

// Reuse the 榜单 Tab's .screen/.list rules — same list chrome, no second copy.
import '../index/index.css';

export default function Board() {
  const router = useRouter();
  // `category` is the cohort slug (undefined for a missing/blank hand-typed route →
  // un-scoped list); `name` is the title, decoded crash-safely. See readBoardParams.
  const { category, name } = readBoardParams(router.params);

  const r = useRankings(category);

  useLoad(() => {
    void Taro.setNavigationBarTitle({ title: name });
    r.loadFirst();
  });

  usePullDownRefresh(() => {
    void r.refresh().finally(() => {
      void Taro.stopPullDownRefresh();
    });
  });

  useReachBottom(() => {
    r.loadNext();
  });

  if (r.phase === 'error') {
    return (
      <View className="screen">
        <FirstScreenError onRetry={() => r.retryFirst()} />
      </View>
    );
  }

  if (r.phase === 'idle' || (r.phase === 'loading' && r.items.length === 0)) {
    return (
      <View className="screen">
        <ListLoading />
      </View>
    );
  }

  if (r.phase === 'ready' && r.items.length === 0) {
    return (
      <View className="screen">
        <ListEmpty />
      </View>
    );
  }

  return (
    <View className="screen">
      <View className="list">
        {r.items.map((item) => (
          <RankingRow key={`${item.store}:${item.storeSku}:${item.rank}`} item={item} />
        ))}
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
