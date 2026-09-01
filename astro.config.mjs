// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

/** DEV のみ: static prerender では POST body が届かないため Vite 層で Publish を処理 */
function seekigoAdminPublishDev() {
  return {
    name: 'seekigo-admin-publish-dev',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0] ?? '';
        if (req.method !== 'POST' || path !== '/admin/events/') {
          return next();
        }

        /** @type {Buffer[]} */
        const chunks = [];
        req.on('data', (chunk) => {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        });
        req.on('end', () => {
          void (async () => {
            const body = Buffer.concat(chunks).toString('utf8');
            try {
              const host = req.headers.host ?? 'localhost:4321';
              const origin = `http://${host}`;
              const { handleViteAdminPublish } = await server.ssrLoadModule(
                '/src/lib/admin-vite-publish.ts',
              );
              const result = await handleViteAdminPublish({
                body,
                cookieHeader: req.headers.cookie ?? '',
                origin,
                originHeader: req.headers.origin ?? '',
                refererHeader: req.headers.referer ?? '',
              });
              if ('json' in result) {
                res.statusCode = result.status ?? 200;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(JSON.stringify(result.json));
                return;
              }
              res.statusCode = 302;
              res.setHeader('Location', result.redirectTo);
              res.end();
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              const wantsJson = new URLSearchParams(body).get('ajax') === '1';
              if (wantsJson) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ ok: false, message }));
                return;
              }
              res.statusCode = 302;
              res.setHeader(
                'Location',
                `/admin/events/?error=${encodeURIComponent(message)}`,
              );
              res.end();
            }
          })();
        });
      });
    },
  };
}

// 公開サイトは完全 SSG（Xserver へ dist/ を配置）
// /admin は astro dev 専用（本番 build では 404 スタブのみ）
export default defineConfig({
  output: 'static',
  site: 'https://seekigo.com',
  integrations: [
    sitemap({
      filter: (page) => !page.includes('/admin'),
    }),
  ],
  vite: {
    plugins: [seekigoAdminPublishDev()],
  },
});
