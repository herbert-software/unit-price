// Single configuration constant for the rankings data source.
//
// v1 connects DIRECTLY to the prod /rankings worker (public, key-free). In the
// WeChat devtools tick "不校验合法域名" to hit prod from the IDE; real-device
// preview / store release require registering this origin under "请求合法域名"
// (a release gate bound to AppID/备案, NOT a development gate).
//
// BASE must be a CLEAN http(s) origin (no path/query/fragment) — buildRankingsUrl
// fails fast otherwise.
//
// [手动验证] 填入 prod worker 域名（workers.dev 子域或自定义域），例如
//   'https://unit-price-api.<account>.workers.dev'
export const BASE = 'https://unit-price-api.herbertgao.workers.dev';

/**
 * True until BASE is filled with a real prod origin. The data layer checks this
 * BEFORE building a URL so an unfilled placeholder surfaces a clear "BASE 未配置"
 * error state (not a generic URL-parse failure) — and an unfilled placeholder can
 * never be mistaken for a real config. Fill BASE per the `[手动验证]` step (5.2)
 * before WeChat-devtools verification / store upload.
 */
export const BASE_IS_PLACEHOLDER = BASE.includes('<待填');

/** Page size for /rankings pagination (limit). */
export const PAGE_SIZE = 20;
