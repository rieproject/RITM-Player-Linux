import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  // path relatif agar bisa dimuat lewat file:// di Electron
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@ritm/player': path.resolve(__dirname, '../ritm-player/src'),
    },
  },
  server: { port: 5176 },
  build: { outDir: 'dist', emptyOutDir: true },
});
