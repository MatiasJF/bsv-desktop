import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
  // dxs-bsv-token-sdk is a CJS package installed via `file:` (sibling dir).
  // Vite's auto-discovery does not reliably pre-bundle file:-linked subpaths,
  // and serving raw CJS to the browser breaks named-export imports
  // (e.g. `import { LockingScriptReader } from 'dxs-bsv-token-sdk/bsv'`).
  // Listing the subpaths here forces esbuild pre-bundling, which converts the
  // CJS exports into ESM named exports.
  optimizeDeps: {
    include: [
      'dxs-bsv-token-sdk/bsv',
      'dxs-bsv-token-sdk/dstas',
    ],
  },
});
