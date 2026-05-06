import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html') },
      output: { chunkFileNames: 'assets/[name]-[hash].js' },
    },
  },
  // Vite copies everything in public/ to dist/ automatically
});
