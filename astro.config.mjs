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
            try {
              const body = Buffer.concat(chunks).toString('utf8');
              const host = req.headers.host ?? 'localhost:4321';
              const origin = `http://${host}`;
              const { handleViteAdminPublish } = await server.ssrLoadModule(
                '/src/lib/admin-vite-publish.ts',
              );
              const { redirectTo } = await handleViteAdminPublish({
                body,
                cookieHeader: req.headers.cookie ?? '',
                origin,
              });
              res.statusCode = 302;
              res.setHeader('Location', redirectTo);
              res.end();
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
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
