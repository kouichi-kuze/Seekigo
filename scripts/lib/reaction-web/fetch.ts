/**
 * Safe HTTP fetch for reaction web collector (SSRF / size / type / redirects).
 */
import { assertSafeFetchUrl } from './url-safety'
import { isUrlAllowedByRobots, REACTION_WEB_USER_AGENT } from './robots'

export const MAX_RESPONSE_BYTES = 1_000_000
export const FETCH_TIMEOUT_MS = 12_000
export const MAX_REDIRECTS = 3

const ALLOWED_CONTENT_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'application/rss+xml',
  'application/atom+xml',
  'application/xml',
  'text/xml',
  'application/rdf+xml',
]

export type SafeFetchResult =
  | {
      ok: true
      finalUrl: string
      contentType: string
      bodyText: string
      robotsReason: string
    }
  | { ok: false; reason: string; status?: number }

function contentTypeAllowed(ct: string | null): boolean {
  if (!ct) return false
  const base = ct.split(';')[0]?.trim().toLowerCase() ?? ''
  return ALLOWED_CONTENT_TYPES.some((a) => base === a || base.endsWith('+xml'))
}

async function readBodyLimited(res: Response, maxBytes: number): Promise<string | null> {
  const cl = res.headers.get('content-length')
  if (cl && Number(cl) > maxBytes) return null

  const reader = res.body?.getReader()
  if (!reader) {
    const text = await res.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) return null
    return text
  }

  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      try {
        await reader.cancel()
      } catch {
        /* ignore */
      }
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
}

export async function safeFetchText(rawUrl: string): Promise<SafeFetchResult> {
  let current = rawUrl.trim()

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const safe = await assertSafeFetchUrl(current)
    if (!safe.ok) return { ok: false, reason: `unsafe_url:${safe.reason}` }

    const robots = await isUrlAllowedByRobots(safe.url.href)
    if (!robots.allowed) {
      return { ok: false, reason: `robots:${robots.reason}` }
    }

    let res: Response
    try {
      res = await fetch(safe.url.href, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'user-agent': REACTION_WEB_USER_AGENT,
          accept:
            'text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.1',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.name : 'fetch_error'
      return { ok: false, reason: `network:${msg}` }
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) return { ok: false, reason: 'redirect_without_location', status: res.status }
      try {
        current = new URL(loc, safe.url).href
      } catch {
        return { ok: false, reason: 'redirect_invalid', status: res.status }
      }
      continue
    }

    if (!res.ok) {
      return { ok: false, reason: `http_${res.status}`, status: res.status }
    }

    const ct = res.headers.get('content-type')
    if (!contentTypeAllowed(ct)) {
      return {
        ok: false,
        reason: `content_type_rejected:${ct ?? 'missing'}`,
        status: res.status,
      }
    }

    const bodyText = await readBodyLimited(res, MAX_RESPONSE_BYTES)
    if (bodyText == null) {
      return { ok: false, reason: 'response_too_large', status: res.status }
    }

    return {
      ok: true,
      finalUrl: safe.url.href,
      contentType: (ct ?? '').split(';')[0]?.trim().toLowerCase() ?? '',
      bodyText,
      robotsReason: robots.reason,
    }
  }

  return { ok: false, reason: 'too_many_redirects' }
}
