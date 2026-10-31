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
 * OPSWEAVE_PROXY_TARGET re-points the same config at any other kernel - a locally rebuilt one,
 * for example - without editing this file or disturbing a staging run someone else has open:
 *
 *   OPSWEAVE_PROXY_TARGET=http://127.0.0.1:18199 pnpm --filter @opsweave/platform-web exec vite \
 *     --port 5199 --config ../../tests/ui/vite.staging.config.mjs
 *
 * Not part of the product build: this file only re-points the dev proxy of vite.config.ts.
 */
const target = process.env.OPSWEAVE_PROXY_TARGET || 'http://82.156.234.84:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    proxy: {
      '/api': { target, changeOrigin: false },
      '/assets': { target, changeOrigin: false },
      '/internal': { target, changeOrigin: false },
    },
  },
});
