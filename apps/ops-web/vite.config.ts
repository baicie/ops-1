import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Ops Web is its own build and its own artifact. It has no import path to
// the Platform Console, so an ops build failure cannot stop the console build -
// the property ADR-022 asks for and a shared bundle cannot give.
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
