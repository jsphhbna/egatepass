import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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

// Local API middleware routing /api/* directly to Vercel-style handlers in api/
const vercelApiDevPlugin = (): Plugin => {
  return {
    name: 'vercel-api-dev',
    configureServer(server) {
      server.middlewares.use(async (req: any, res: any, next: any) => {
        if (!req.url?.startsWith('/api/')) return next();

        const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost:5173'}`);
        const relativePath = parsedUrl.pathname.replace(/^\/api\//, '');

        const candidatePaths = [
          resolve(import.meta.dirname, 'api', `${relativePath}.ts`),
          resolve(import.meta.dirname, 'api', relativePath, 'index.ts'),
        ];

        const handlerFile = candidatePaths.find((p) => existsSync(p));
        if (!handlerFile) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'not_found', path: parsedUrl.pathname }));
          return;
        }

        try {
          const mod = await server.ssrLoadModule(handlerFile);
          const method = req.method || 'GET';
          const handler = mod.default?.fetch || mod[method] || mod.default;

          if (typeof handler !== 'function') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'method_not_allowed' }));
            return;
          }

          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
          }
          const bodyBuffer = (method === 'GET' || method === 'HEAD' || chunks.length === 0)
            ? undefined
            : Buffer.concat(chunks);

          const headers = new Headers();
          for (const [key, val] of Object.entries(req.headers)) {
            if (Array.isArray(val)) {
              val.forEach((v) => headers.append(key, v));
            } else if (val !== undefined) {
              headers.set(key, String(val));
            }
          }

          const webRequest = new Request(parsedUrl.href, {
            method,
            headers,
            body: bodyBuffer,
          });

          const webResponse = await handler(webRequest);
          res.statusCode = webResponse.status;
          webResponse.headers.forEach((val: string, key: string) => {
            res.setHeader(key, val);
          });

          const resBuf = Buffer.from(await webResponse.arrayBuffer());
          res.end(resBuf);
        } catch (err: unknown) {
          console.error(`[Local API Dev] Handler error for ${parsedUrl.pathname}:`, err);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'internal_server_error', message: err instanceof Error ? err.message : 'Unknown error' }));
        }
      });
    },
  };
};

export default defineConfig({
  plugins: [react(), tailwindcss(), fixMimeTypesPlugin(), vercelApiDevPlugin()],
  resolve: {
    alias: {
      '@': import.meta.dirname + '/src',
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
