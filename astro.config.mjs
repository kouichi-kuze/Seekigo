// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

/**
 * @param {string | Uint8Array} body
 * @param {string} contentType
 */
function formFields(body, contentType) {
  if (typeof body === 'string' && !contentType.includes('multipart/form-data')) {
    return new URLSearchParams(body);
  }
  const text = Buffer.from(body).toString('latin1');
  const params = new URLSearchParams();
  for (const name of ['intent', 'event_id', 'return_to', 'ajax', 'event_ids']) {
    const marker = `name="${name}"`;
    let idx = text.indexOf(marker);
    while (idx >= 0) {
      const after = text.indexOf('\r\n\r\n', idx);
      const end = after >= 0 ? text.indexOf('\r\n', after + 4) : -1;
      if (after >= 0 && end >= 0) params.append(name, text.slice(after + 4, end));
      idx = text.indexOf(marker, idx + marker.length);
    }
  }
  return params;
}

/** DEV のみ: static prerender では POST body が届かないため Vite 層で Publish を処理 */
function seekigoAdminPublishDev() {
  return {
    name: 'seekigo-admin-publish-dev',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0] ?? '';
        const isAdminEventsPost =
          req.method === 'POST' &&
          (path === '/admin/events/' || path === '/admin/events/draft/');
        if (!isAdminEventsPost) {
          return next();
        }

        /** @type {Buffer[]} */
        const chunks = [];
        req.on('data', (chunk) => {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        });
        req.on('end', () => {
          void (async () => {
            const raw = Buffer.concat(chunks);
            const contentType = String(req.headers['content-type'] ?? '');
            const isMultipart = contentType.includes('multipart/form-data');
            if (isMultipart && raw.length > 12 * 1024 * 1024) {
              const tooBig = formFields(new Uint8Array(raw), contentType);
              const back = tooBig.get('return_to') ?? '';
              const eventId = tooBig.get('event_id') ?? '';
              const failPath = back.startsWith('/admin/events/')
                ? back.split('?')[0]
                : eventId
                  ? `/admin/events/${eventId}/`
                  : '/admin/events/reviews/image/';
              res.statusCode = 302;
              res.setHeader(
                'Location',
                `${failPath}?error=${encodeURIComponent('画像ファイルが大きすぎます')}`,
              );
              res.end();
              return;
            }
            const body = isMultipart ? new Uint8Array(raw) : raw.toString('utf8');
            if (process.env.NODE_ENV !== 'production') {
              const logged = formFields(body, contentType);
              console.log('[admin-dev] POST', path, {
                intent: logged.get('intent'),
                event_id: logged.get('event_id'),
                event_ids: logged.getAll('event_ids'),
              });
            }
            try {
              const host = req.headers.host ?? 'localhost:4321';
              const origin = `http://${host}`;
              const { handleViteAdminPublish } = await server.ssrLoadModule(
                '/src/lib/admin-vite-publish.ts',
              );
              const result = await handleViteAdminPublish({
                body,
                contentType,
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
              const wantsJson = formFields(body, contentType).get('ajax') === '1';
              if (wantsJson) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ ok: false, message }));
                return;
              }
              res.statusCode = 302;
              const failParams = formFields(body, contentType);
              const failIntent = failParams.get('intent') ?? '';
              const failBack = failParams.get('return_to') ?? '';
              const failEventId = failParams.get('event_id') ?? '';
              const failPath = failIntent.startsWith('generated_image_')
                ? (failBack.startsWith('/admin/events/')
                    ? failBack.split('?')[0]
                    : failEventId
                      ? `/admin/events/${failEventId}/`
                      : '/admin/events/reviews/image/')
                : '/admin/events/draft/';
              res.setHeader(
                'Location',
                `${failPath}?error=${encodeURIComponent(message)}`,
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
      filter: (page) => !page.includes('/admin') && !page.includes('/dev'),
    }),
  ],
  vite: {
    plugins: [seekigoAdminPublishDev()],
  },
});
