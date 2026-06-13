export default defineAppConfig({
  pages: ['pages/index/index'],
  // Inject only the custom components each page actually uses, cutting startup
  // cost. Satisfies WeChat's "组件按需注入" optimization check.
  lazyCodeLoading: 'requiredComponents',
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#fff',
    navigationBarTitleText: '单价榜单',
    navigationBarTextStyle: 'black',
  },
});
