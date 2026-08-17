import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies API calls to the Express backend (see server/.env.example
// PORT=3000); production build is served BY that same backend (see
// server/src/app.js), so there's no separate frontend host to configure.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
      '/webhook': 'http://localhost:3000',
      // /dev only exists when server/scripts/devPreview.js is running
      // (local visual QA) — harmless to proxy in normal dev too.
      '/dev': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
  },
});
