export default defineAppConfig({
  // pages/board is a non-tab page (category-scoped 分类榜, reached via
  // navigateTo from the 分类 Tab); it keeps a back button and a per-category title.
  pages: ['pages/index/index', 'pages/category/index', 'pages/mine/index', 'pages/board/index', 'pages/compute/index'],
  // Inject only the custom components each page actually uses, cutting startup
  // cost. Satisfies WeChat's "组件按需注入" optimization check.
  lazyCodeLoading: 'requiredComponents',
  window: {
    backgroundTextStyle: 'light',
    // P0 浅纸底(=--paper),品牌蓝只用于前景与选中态,导航栏不刷蓝。
    navigationBarBackgroundColor: '#F1F3F6',
    navigationBarTitleText: '会员商店值不值',
    navigationBarTextStyle: 'black',
  },
  // 原生 tabBar 配色字段不能引 CSS 变量,故写字面量;取值与 app.css token 同值:
  // color=--muted、selectedColor=--blue、backgroundColor=--paper-card。
  tabBar: {
    color: '#8B95A2',
    selectedColor: '#014B90',
    backgroundColor: '#FFFFFF',
    borderStyle: 'white',
    list: [
      {
        pagePath: 'pages/index/index',
        text: '榜单',
        iconPath: 'assets/tabbar/rank.png',
        selectedIconPath: 'assets/tabbar/rank-active.png',
      },
      {
        pagePath: 'pages/category/index',
        text: '分类',
        iconPath: 'assets/tabbar/category.png',
        selectedIconPath: 'assets/tabbar/category-active.png',
      },
      {
        pagePath: 'pages/mine/index',
        text: '我的',
        iconPath: 'assets/tabbar/mine.png',
        selectedIconPath: 'assets/tabbar/mine-active.png',
      },
    ],
  },
});
