import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: false },
  preview: { port: 4174 },
  build: { outDir: 'dist', sourcemap: true },
});
