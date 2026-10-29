/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:4000', changeOrigin: false } } },
  build: { sourcemap: false },
  test: { environment: 'jsdom', setupFiles: ['./src/tests/setup.ts'], globals: true },
});
