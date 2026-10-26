import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const target = process.env.ACC_API ?? 'http://127.0.0.1:7820';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: false },
      '/ws': { target: target.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
});
