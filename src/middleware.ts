import { defineMiddleware } from 'astro:middleware'

/**
 * /admin 配下のゲート。
 * - production: 404（ルートはコード上残すが公開しない）
 * - development: 通過（将来ここに認証を追加する）
 *
 * 認証追加時の想定:
 * 1. session / cookie 検証
 * 2. 未ログインなら 401/302
 * 3. 通った場合のみ next()
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url

  if (!pathname.startsWith('/admin')) {
    return next()
  }

  // production では管理画面を公開しない
  if (import.meta.env.PROD) {
    return new Response('Not Found', {
      status: 404,
      statusText: 'Not Found',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    })
  }

  // --- future auth hook (DEV) ---
  // const session = await getAdminSession(context)
  // if (!session) return context.redirect('/admin/login')

  return next()
})
