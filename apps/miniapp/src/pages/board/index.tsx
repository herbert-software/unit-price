// Rankings board list — the per100ml-ascending list reused by TWO entries:
//   - 分类下钻: GET /rankings?category=<slug>, title = category's Chinese name.
//   - 搜索:     GET /rankings?q=<term>,       title = `搜索：<decoded q>`.
// Non-tab page (has a back button).
//
// Reuses the 榜单 Tab's tested data layer VERBATIM: useRankings(category, q) threads
// the params into buildRankingsUrl → GET /rankings?category=…&q=…. Same three-state
// render + pagination + page-error semantics; only the header chrome (brand / search
// / scope / ads) is dropped — a board is just the list.
import { View } from '@tarojs/components';
import Taro, { useRouter, useLoad, usePullDownRefresh, useReachBottom } from '@tarojs/taro';
import { useRankings } from '../index/useRankings';
import { readBoardParams } from './params';
import RankingRow from '../../components/RankingRow';
import ListFooter from '../../components/ListFooter';
import { ListLoading, ListEmpty, FirstScreenError } from '../../components/ListStates';
import ComputeCta from '../../components/ComputeCta';

// Reuse the 榜单 Tab's .screen/.list rules — same list chrome, no second copy.
import '../index/index.css';

export default function Board() {
  const router = useRouter();
  // `category` is the cohort slug (undefined for a missing/blank hand-typed route →
  // un-scoped list); `q` is the decoded search term (undefined for non-search); `name`
  // is the title already derived by precedence (decoded non-empty q → `搜索：<q>`,
  // else category name, else `分类榜`). See readBoardParams.
  const { category, q, name } = readBoardParams(router.params);

  const r = useRankings(category, q);

  useLoad(() => {
    // `name` is already the decoded-q-or-category title (not the encoded q).
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

  // Empty: in SEARCH mode (q set) → the 比价 CTA (highest-intent "not found"
  // moment, primary entry to /compute); in category-drill mode → plain empty.
  if (r.phase === 'ready' && r.items.length === 0) {
    return (
      <View className="screen">
        {q ? <ComputeCta term={q} /> : <ListEmpty />}
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
