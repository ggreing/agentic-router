import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Served by the daemon under /dashboard (decision 132); assets are emitted to dist/ and served read-only.
// In dev, proxy the metrics API to a locally running daemon via VITE_DAEMON_PORT (default 8787).
const daemonPort = Number(process.env.VITE_DAEMON_PORT ?? 8787);

export default defineConfig({
  plugins: [vue()],
  base: '/dashboard/',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  server: {
    proxy: {
      '/router/v1': { target: `http://127.0.0.1:${daemonPort}`, changeOrigin: false },
    },
  },
});
