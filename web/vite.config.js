import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { randomBytes } from 'node:crypto';

// One page: the Orbit page (index.html, served at /). The first dashboard, kept at
// /classic.html for a week after the flip (Orbit Phase 5), was removed 2026-11-18.
// Neither /orbit.html (the Orbit page's address before the flip) nor /classic.html
// has a file: the server's single-page fallback answers both with index.html.

// Each build gets an id, compiled into the page as __BUILD_ID__ and written beside
// it as build.json. The page compares the two and reloads itself once when they
// differ (src/orbit/buildWatch.js). The dev server has no id, so it never reloads.
const buildId = () => `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;

export default defineConfig(({ command }) => {
  const id = command === 'build' ? buildId() : null;
  return {
    plugins: [
      react(),
      {
        name: 'build-id',
        apply: 'build',
        generateBundle() {
          this.emitFile({ type: 'asset', fileName: 'build.json', source: `${JSON.stringify({ build: id })}\n` });
        }
      }
    ],
    define: { __BUILD_ID__: JSON.stringify(id) },
    server: { proxy: { '/api': 'http://127.0.0.1:8322' } }
  };
});
