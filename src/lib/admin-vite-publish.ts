import { processAdminPublishPost } from './admin-publish'

function readCookie(cookieHeader: string, name: string): string | undefined {
  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return undefined
}

export type ViteAdminPublishResponse =
  | { redirectTo: string }
  | { json: unknown; status?: number }

/** Vite dev server から POST body 文字列で Publish を処理 */
export async function handleViteAdminPublish(opts: {
  body: string
  cookieHeader: string
  origin: string
  originHeader?: string
  refererHeader?: string
}): Promise<ViteAdminPublishResponse> {
  const { body, cookieHeader, origin, originHeader, refererHeader } = opts
  const url = new URL('/admin/events/', origin)

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    cookie: cookieHeader,
  }
  if (originHeader) headers.origin = originHeader
  if (refererHeader) headers.referer = refererHeader

  const request = new Request(url, {
    method: 'POST',
    headers,
    body,
  })

  const cookies = {
    get: (name: string) => {
      const value = readCookie(cookieHeader, name)
      return value ? { value } : undefined
    },
  }

  const result = await processAdminPublishPost({ request, url, cookies })
  if (result.ok && 'ajax' in result && result.ajax) {
    return {
      json: { ok: true, updates: result.updates },
      status: 200,
    }
  }
  if (result.ok) {
    return { redirectTo: result.redirectTo }
  }
  const params = new URLSearchParams(body)
  if (params.get('ajax') === '1') {
    return {
      json: { ok: false, message: result.message },
      status: 400,
    }
  }
  return {
    redirectTo: `/admin/events/?error=${encodeURIComponent(result.message)}`,
  }
}
