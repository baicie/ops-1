import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Platform Console is its own build and its own artifact. It has no import
// path to the Ops application, so an Ops build failure cannot stop this one -
// which is the property ADR-022 asks for and a shared bundle cannot give.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:18181',
      '/assets': 'http://127.0.0.1:18181',
      '/internal': 'http://127.0.0.1:18181',
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
