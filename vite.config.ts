import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Fix for Windows MIME type issue where the registry returns an empty string for JS/TS files
const fixMimeTypesPlugin = (): Plugin => {
  return {
    name: 'fix-mime-types',
    configureServer(server) {
      server.middlewares.use((req: any, res: any, next: any) => {
        const originalSetHeader = res.setHeader;
        res.setHeader = function (name: string, value: any) {
          if (name.toLowerCase() === 'content-type') {
            if (req.url) {
              const url = req.url.split('?')[0];
              if (
                url.endsWith('.ts') ||
                url.endsWith('.tsx') ||
                url.endsWith('.js') ||
                url.endsWith('.jsx')
              ) {
                value = 'application/javascript';
              }
            }
          }
          return originalSetHeader.call(this, name, value);
        };
        next();
      });
    },
  };
};

export default defineConfig({
  plugins: [react(), tailwindcss(), fixMimeTypesPlugin()],
  resolve: {
    alias: {
      '@': import.meta.dirname + '/src',
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8888/.netlify/functions',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
    watch: {
      ignored: ['**/.netlify/**'],
    },
  },
});
