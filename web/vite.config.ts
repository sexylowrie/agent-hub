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
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
})
