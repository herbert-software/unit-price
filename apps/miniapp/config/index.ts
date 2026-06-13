import path from 'node:path';
import { defineConfig } from '@tarojs/cli';

// Minimal Taro 4 (React + TS) weapp build config. This project is a pnpm
// workspace member but is OUTSIDE the root `tsc -b` reference graph — Taro owns
// its build (webpack5 bundler + its own tsconfig). It consumes the PRE-BUILT
// dist of @unit-price/api-client (api-client + core must be built BEFORE this
// Taro build runs).
export default defineConfig(async () => ({
  projectName: 'unit-price-miniapp',
  date: '2026-6-13',
  designWidth: 750,
  deviceRatio: {
    640: 2.34 / 2,
    750: 1,
    375: 2,
    828: 1.81 / 2,
  },
  sourceRoot: 'src',
  outputRoot: 'dist',
  // Redirect the @unit-price/api-client RUNTIME import to a pre-bundled,
  // weapp-safe esbuild output (vendor/api-client.js, built by
  // scripts/vendor-api-client.mjs). This keeps Zod OUT of babel-preset-taro —
  // babel's class transform breaks Zod's runtime ("w is not a function"),
  // whereas esbuild lowers the unsupported syntax while preserving classes. The
  // alias is webpack-only; TS still resolves the real package for types.
  alias: {
    '@unit-price/api-client': path.resolve(__dirname, '..', 'vendor', 'api-client.js'),
  },
  plugins: [],
  defineConstants: {},
  copy: {
    patterns: [],
    options: {},
  },
  framework: 'react',
  compiler: {
    type: 'webpack5',
    prebundle: { enable: false },
  },
  cache: {
    enable: false,
  },
  mini: {
    postcss: {
      pxtransform: {
        enable: true,
        config: {},
      },
      cssModules: {
        enable: false,
      },
    },
  },
  h5: {
    publicPath: '/',
    staticDirectory: 'static',
    output: {
      filename: 'js/[name].[hash:8].js',
      chunkFilename: 'js/[name].[chunkhash:8].js',
    },
    postcss: {
      autoprefixer: {
        enable: true,
        config: {},
      },
      cssModules: {
        enable: false,
      },
    },
  },
}));
