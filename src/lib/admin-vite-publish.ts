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

/** Vite dev server から POST body で管理画面の更新を処理 */
export async function handleViteAdminPublish(opts: {
  body: string | Uint8Array
  contentType?: string
  cookieHeader: string
  origin: string
  originHeader?: string
  refererHeader?: string
}): Promise<ViteAdminPublishResponse> {
  const { body, cookieHeader, origin, originHeader, refererHeader } = opts
  const url = new URL('/admin/events/', origin)
  const contentType =
    opts.contentType?.trim() || 'application/x-www-form-urlencoded;charset=UTF-8'

  const headers: Record<string, string> = {
    'Content-Type': contentType,
    cookie: cookieHeader,
  }
  if (originHeader) headers.origin = originHeader
  if (refererHeader) headers.referer = refererHeader

  const request = new Request(url, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : body.slice(),
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
  const params = formFieldsFromBody(body, contentType)
  if (params.get('ajax') === '1') {
    return {
      json: { ok: false, message: result.message },
      status: 400,
    }
  }
  return {
    redirectTo: adminFailureRedirect(params, result.message),
  }
}

/** 画像生成の失敗は公開エラーページへ混ぜない。 */
export function adminFailureRedirect(
  params: URLSearchParams,
  message: string,
): string {
  const intent = params.get('intent') ?? ''
  if (intent.startsWith('generated_image_')) {
    const eventId = params.get('event_id') ?? ''
    const back = params.get('return_to') ?? ''
    const path = back.startsWith('/admin/events/')
      ? back.split('?')[0]
      : eventId
        ? `/admin/events/${eventId}/`
        : '/admin/events/reviews/image/'
    return `${path}?error=${encodeURIComponent(message)}`
  }
  return `/admin/events/draft/?error=${encodeURIComponent(message)}`
}

export function formFieldsFromBody(
  body: string | Uint8Array,
  contentType: string,
): URLSearchParams {
  if (typeof body === 'string' && !contentType.includes('multipart/form-data')) {
    return new URLSearchParams(body)
  }
  const params = new URLSearchParams()
  const text = Buffer.from(body).toString('latin1')
  for (const name of ['intent', 'event_id', 'return_to', 'ajax']) {
    const value = multipartTextField(text, name)
    if (value) params.set(name, value)
  }
  return params
}

function multipartTextField(body: string, name: string): string {
  const marker = `name="${name}"`
  const idx = body.indexOf(marker)
  if (idx < 0) return ''
  const after = body.indexOf('\r\n\r\n', idx)
  if (after < 0) return ''
  const end = body.indexOf('\r\n', after + 4)
  if (end < 0) return ''
  return body.slice(after + 4, end)
}
