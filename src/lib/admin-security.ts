/**
 * 開発用 /admin の簡易 CSRF 対策。
 * - HttpOnly cookie にトークンを保持
 * - フォームの hidden と一致必須
 * - POST 時は Origin / Referer も同一ホストか確認
 *
 * 将来の本認証（session）と併用可能な小さなヘルパー。
 */

const COOKIE_NAME = 'seekigo_admin_csrf'
const COOKIE_PATH = '/admin'

function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
}

export function getOrCreateAdminCsrfToken(cookies: {
  get: (name: string) => { value: string } | undefined
  set: (
    name: string,
    value: string,
    options: {
      httpOnly: boolean
      sameSite: 'lax' | 'strict' | 'none'
      path: string
      secure: boolean
      maxAge: number
    },
  ) => void
}): string {
  const existing = cookies.get(COOKIE_NAME)?.value
  if (existing && existing.length >= 32) {
    return existing
  }

  const token = randomToken()
  cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: COOKIE_PATH,
    secure: import.meta.env.PROD,
    maxAge: 60 * 60 * 8,
  })
  return token
}

export function verifyAdminCsrf(opts: {
  formToken: string | null
  cookieToken: string | null | undefined
  request: Request
  url: URL
}): { ok: true } | { ok: false; reason: string } {
  const { formToken, cookieToken, request, url } = opts

  if (!cookieToken || !formToken) {
    return { ok: false, reason: 'CSRF token missing' }
  }
  if (cookieToken.length < 32 || formToken.length < 32) {
    return { ok: false, reason: 'CSRF token invalid' }
  }
  if (cookieToken !== formToken) {
    return { ok: false, reason: 'CSRF token mismatch' }
  }

  const origin = request.headers.get('origin')
  const referer = request.headers.get('referer')
  const expectedOrigin = url.origin

  if (origin) {
    if (origin !== expectedOrigin) {
      return { ok: false, reason: 'Origin mismatch' }
    }
  } else if (referer) {
    try {
      if (new URL(referer).origin !== expectedOrigin) {
        return { ok: false, reason: 'Referer mismatch' }
      }
    } catch {
      return { ok: false, reason: 'Referer invalid' }
    }
  } else {
    // 一部環境で両方欠ける場合があるが、cookie+token 一致は必須
    // 開発用として Origin/Referer 欠落は許可しつつログ相当の理由は残さない
  }

  return { ok: true }
}

/** POST body を FormData として読む */
export async function readAdminPostForm(request: Request): Promise<FormData> {
  const contentType = request.headers.get('content-type') ?? ''

  if (contentType.includes('multipart/form-data')) {
    return request.formData()
  }

  const text = (await request.text()).trim()
  const form = new FormData()
  for (const [key, value] of new URLSearchParams(text)) {
    form.append(key, value)
  }
  return form
}

/** 正の整数 id のみ許可（draft 更新前の入力検証） */
export function parsePositiveIntIds(raw: FormDataEntryValue[]): number[] {
  const ids: number[] = []
  const seen = new Set<number>()

  for (const value of raw) {
    const text = String(value ?? '').trim()
    if (!/^\d+$/.test(text)) continue
    const n = Number(text)
    if (!Number.isSafeInteger(n) || n <= 0) continue
    if (seen.has(n)) continue
    seen.add(n)
    ids.push(n)
  }

  return ids
}
