import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:18181',
      '/assets': 'http://127.0.0.1:18181',
      '/internal': 'http://127.0.0.1:18181',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
