import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const version = process.env.PLUGIN_VERSION || '0.0.1';

export default defineConfig({
  plugins: [react()],
  define: {
    __PLUGIN_VERSION__: JSON.stringify(version),
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    lib: {
      entry: 'src/remoteEntry.tsx',
      name: 'OpsWeaveHello',
      formats: ['umd'],
      fileName: () => 'remoteEntry.js',
    },
    cssCodeSplit: false,
    emptyOutDir: true,
    rollupOptions: {
      external: ['react', 'react-dom'],
      output: {
        globals: { react: 'React', 'react-dom': 'ReactDOM' },
        inlineDynamicImports: true,
      },
    },
  },
});
