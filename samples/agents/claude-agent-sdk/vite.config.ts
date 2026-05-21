import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite builds the chat UI (src-ui/) into dist-ui/. The Node server
// (src/server.ts) serves that bundle as static assets. No vite dev
// middleware — keeps the sample's Node side minimal.
export default defineConfig({
  root: '.',
  plugins: [react()],
  build: {
    outDir: 'dist-ui',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
  },
});
