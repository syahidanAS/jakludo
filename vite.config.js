import { resolve } from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function adminSpaFallbackPlugin() {
  return {
    name: 'playgo-admin-spa-fallback',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url ? req.url.split('?')[0] : '';
        if (url === '/admin' || url.startsWith('/admin/')) {
          req.url = '/admin.html';
        }
        next();
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), adminSpaFallbackPlugin()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin.html')
      }
    }
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5172',
        changeOrigin: true
      },
      '/socket.io': {
        target: 'http://localhost:5172',
        ws: true
      }
    }
  }
});
