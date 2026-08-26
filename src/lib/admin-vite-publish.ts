import { processAdminPublishPost } from './admin-publish'

function readCookie(cookieHeader: string, name: string): string | undefined {
  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return undefined
}

/** Vite dev server から POST body 文字列で Publish を処理 */
export async function handleViteAdminPublish(opts: {
  body: string
  cookieHeader: string
  origin: string
}): Promise<{ redirectTo: string }> {
  const { body, cookieHeader, origin } = opts
  const url = new URL('/admin/events/', origin)

  const request = new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader,
    },
    body,
  })

  const cookies = {
    get: (name: string) => {
      const value = readCookie(cookieHeader, name)
      return value ? { value } : undefined
    },
  }

  const result = await processAdminPublishPost({ request, url, cookies })
  if (result.ok) {
    return { redirectTo: result.redirectTo }
  }
  return {
    redirectTo: `/admin/events/?error=${encodeURIComponent(result.message)}`,
  }
}
