import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig(({ mode }) => ({
  base: mode === 'desktop' ? './' : '/',
  plugins: [
      vue(),
      tailwindcss(),
      {
        name: 'desktop-local-resources',
        transformIndexHtml(html) {
          if (mode !== 'desktop') return html
          // Desktop uses the existing system-font fallback without external font requests.
          return html.replace(/<link\b[^>]*https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '')
        },
      },
    ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
}))
