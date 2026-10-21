import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Two pages, built side by side: the classic dashboard (index.html, served at /)
// and the Orbit redesign (orbit.html), until the Orbit page replaces it.
const page = name => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:8322' } },
  build: {
    rolldownOptions: {
      input: { main: page('./index.html'), orbit: page('./orbit.html') }
    }
  }
});
