import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

const daemonHttpTarget = process.env.OUROBOROS_DEV_DAEMON_URL || 'http://localhost:7777'
const daemonWebSocketTarget = daemonHttpTarget.replace(/^http/, 'ws')

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    host: true,
    allowedHosts: ['hematoxylic-chiasmal-thea.ngrok-free.dev'],
    proxy: {
      '/api': {
        target: daemonHttpTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/ws': {
        target: daemonWebSocketTarget,
        ws: true,
        changeOrigin: false,
      },
      '/auth/browser-session': {
        target: daemonHttpTarget,
        changeOrigin: false,
      },
      '/rpc': {
        target: daemonHttpTarget,
        changeOrigin: true,
      },
    },
  },
})
