import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import type { ProxyOptions } from 'vite'

const apiProxy: ProxyOptions = {
  target: 'http://127.0.0.1:3690',
  changeOrigin: true,
  configure(proxy) {
    proxy.on('proxyReq', (request, incoming) => {
      // Keep production origin checks intact while allowing this fixed local dev UI.
      if (['http://localhost:5174', 'http://127.0.0.1:5174'].includes(incoming.headers.origin ?? '')) {
        request.setHeader('Origin', 'http://127.0.0.1:3690')
      }
    })
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  // absolute subpath: page may be served at /admin (no trailing slash),
  // where a relative './' base would resolve assets against the root
  base: '/admin/',
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/admin/api': apiProxy,
      '/cloud/api': apiProxy,
    },
  },
  build: {
    outDir: '../../packages/server/public/admin',
    emptyOutDir: true,
  },
})
