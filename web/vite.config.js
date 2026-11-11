import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Two pages, built side by side: the Orbit page (index.html, served at /) and the
// classic dashboard (classic.html), kept for a week after the flip (Orbit Phase 5),
// then deleted. /orbit.html, the Orbit page's address before the flip, has no file
// of its own: the server's single-page fallback answers it with index.html.
const page = name => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:8322' } },
  build: {
    rolldownOptions: {
      input: { main: page('./index.html'), classic: page('./classic.html') }
    }
  }
});
