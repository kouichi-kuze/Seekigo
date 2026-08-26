import { defineMiddleware } from 'astro:middleware'

/**
 * /admin 配下のゲート。
 * - astro dev のみ通過（ローカル管理画面）
 * - build / preview / 本番相当では 404
 *
 * Publish POST は astro.config.mjs の Vite dev middleware で処理
 * （static prerender では Astro 層に POST body が届かないため）
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url

  if (!pathname.startsWith('/admin')) {
    return next()
  }

  if (!import.meta.env.DEV) {
    return new Response('Not Found', {
      status: 404,
      statusText: 'Not Found',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    })
  }

  return next()
})
