import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Reads VITE_* variables from the repo-root .env so there is one
// environment file for the whole monorepo.
export default defineConfig({
  plugins: [react()],
  envDir: path.resolve(__dirname, '../..'),
  server: {
    port: 5173,
    strictPort: false,
  },
});
