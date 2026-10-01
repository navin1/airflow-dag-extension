import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main:      resolve(__dirname, 'index.html'),
        sqlViewer: resolve(__dirname, 'sql-viewer.html'),
        batch:     resolve(__dirname, 'batch-optimizer.html'),
      },
      output: { chunkFileNames: 'assets/[name]-[hash].js' },
    },
  },
});
