import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwind()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: { port: 5173, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false }, '/media': { target: 'http://127.0.0.1:8787', changeOrigin: false } } },
  test: { root: '.', include: ['tests/**/*.test.ts'], testTimeout: 30000 },
} as any);
