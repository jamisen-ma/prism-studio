import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 43110,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:43120' },
  },
});
