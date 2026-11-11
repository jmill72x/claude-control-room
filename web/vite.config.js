import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

// Two pages, built side by side: the Orbit page (index.html, served at /) and the
// classic dashboard (classic.html), kept for a week after the flip (Orbit Phase 5),
// then deleted. /orbit.html, the Orbit page's address before the flip, has no file
// of its own: the server's single-page fallback answers it with index.html.
const page = name => fileURLToPath(new URL(name, import.meta.url));

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
    server: { proxy: { '/api': 'http://127.0.0.1:8322' } },
    build: {
      rolldownOptions: {
        input: { main: page('./index.html'), classic: page('./classic.html') }
      }
    }
  };
});
