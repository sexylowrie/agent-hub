import { defineConfig } from 'vite'

// 开发期：vite dev 把 /api 与 /ws 转给本机 Hub；生产由 Hub 直接托管 dist/
const HUB = process.env.HUB_URL ?? 'http://127.0.0.1:7788'

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  server: {
    proxy: {
      '/api': HUB,
      '/ws': { target: HUB.replace(/^http/, 'ws'), ws: true },
    },
  },
  // cssTarget 写明浏览器版本：只写 es2022 时压缩器会把 backdrop-filter 与 -webkit- 前缀版当重复声明去掉一个，Chrome 上毛玻璃失效
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', cssTarget: ['chrome111', 'safari16.4', 'firefox128'] },
})
