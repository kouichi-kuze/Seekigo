import { defineMiddleware } from 'astro:middleware'

/**
 * /admin 配下のゲート。
 * - astro dev のみ通過（ローカル管理画面）
 * - build / preview / 本番相当では 404
 *
 * 静的ホスト（Xserver）では middleware はリクエスト時に動かないが、
 * build 時のガードと preview 用に残す。
 *
 * 認証追加時の想定（DEV）:
 * 1. session / cookie 検証
 * 2. 未ログインなら 401/302
 * 3. 通った場合のみ next()
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url

  if (!pathname.startsWith('/admin')) {
    return next()
  }

  // ローカル astro dev 以外では管理画面を使わない
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

  // --- future auth hook (DEV) ---
  // const session = await getAdminSession(context)
  // if (!session) return context.redirect('/admin/login')

  return next()
})
