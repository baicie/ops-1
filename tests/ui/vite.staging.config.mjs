import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The measurement harness for a B3/B4 review run: the LOCAL source tree served against the
 * STAGING kernel.
 *
 * Why this exists: the defects under review are per-row and per-page, so they need rows. A fresh
 * checkout's kernel holds 1 job / 1 node / 2 plugins; staging holds the 14 / 1 / 4 the review
 * measured. Serving the local source through a proxy to staging measures the code in this
 * checkout against the data that produced the finding - no fixture, no invented payload.
 *
 *   pnpm --filter @opsweave/platform-web exec vite --port 5174 --config ../../tests/ui/vite.staging.config.mjs
 *
 * Not part of the product build: this file only re-points the dev proxy of vite.config.ts.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    proxy: {
      '/api': { target: 'http://82.156.234.84:3000', changeOrigin: false },
      '/assets': { target: 'http://82.156.234.84:3000', changeOrigin: false },
      '/internal': { target: 'http://82.156.234.84:3000', changeOrigin: false },
    },
  },
});
