import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

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
    proxy: {
      '/admin/api': 'http://127.0.0.1:3690',
      '/cloud/api': 'http://127.0.0.1:3690',
    },
  },
  build: {
    outDir: '../../packages/server/public/admin',
    emptyOutDir: true,
  },
})
