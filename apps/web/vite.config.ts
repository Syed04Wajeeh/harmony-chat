import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const backend = process.env['VITE_API_TARGET'] ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': { target: backend, ws: true }, '/healthz': backend, '/readyz': backend },
  },
});
