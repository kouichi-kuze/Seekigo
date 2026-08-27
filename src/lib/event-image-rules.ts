/**
 * イベント image_url の deterministic 抽出・正規化。
 * - 画像ファイルのダウンロード/コピーはしない
 * - AI生成しない
 * - 「取得できる」≠「利用してよい」（利用規約は別フェーズ）
 */

export type ImageSourceKind =
  | 'jsonld'
  | 'og:image'
  | 'twitter:image'
  | 'html'
  | null

export type EventImageResolveResult = {
  image_url: string | null
  source: ImageSourceKind
  source_detail: string | null
  action: 'parsed' | 'keep_null'
  reason: string | null
}

const MIN_DIMENSION = 48

const REJECT_PATH_PATTERNS: RegExp[] = [
  /favicon/i,
  /\/logo(\.|_|\/|-|$)/i,
  /\/icons?\//i,
  /icon\.(png|jpe?g|gif|svg|webp)/i,
  /spacer|pixel|tracking|1x1|blank\./i,
  /\/banner/i,
  /facebook_icon|twitter_icon|youtube_icon|insta_icon|instagram_icon/i,
  /\/sns\//i,
  /\/footer\//i,
  /\/header\//i,
  /\/common\//i,
  /\/shared\/site_gotokyo\/images\/ogp\//i,
  /\/assets\/img\/logo/i,
  /\/assets\/pr\//i,
  /member_register/i,
  /apple-touch-icon/i,
]

/** HTML entity を最低限デコード */
export function decodeBasicHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
}

/**
 * 相対URL / protocol-relative を絶対 https URL へ。
 * query は保持。data/blob/javascript は null。
 */
export function normalizeImageUrl(
  raw: string | null | undefined,
  pageUrl: string,
): string | null {
  if (raw == null) return null
  let value = decodeBasicHtmlEntities(String(raw)).trim()
  if (!value) return null

  const lower = value.toLowerCase()
  if (
    lower.startsWith('data:') ||
    lower.startsWith('blob:') ||
    lower.startsWith('javascript:')
  ) {
    return null
  }

  if (value.startsWith('//')) {
    value = `https:${value}`
  }

  try {
    const abs = new URL(value, pageUrl)
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null
    // http も https へ寄せずそのまま（ソースURL尊重）。ただし // は https 化済み。
    return abs.href
  } catch {
    return null
  }
}

export function isRejectedImageUrl(url: string): boolean {
  const lower = url.toLowerCase()
  if (
    lower.startsWith('data:') ||
    lower.startsWith('blob:') ||
    lower.startsWith('javascript:')
  ) {
    return true
  }

  try {
    const u = new URL(url)
    const pathAndQuery = `${u.pathname}${u.search}`
    if (REJECT_PATH_PATTERNS.some((re) => re.test(pathAndQuery))) return true
    // 拡張子がある場合のみ制限（CDNは拡張子なし可）
    const path = u.pathname.toLowerCase()
    const extMatch = path.match(/\.([a-z0-9]+)$/)
    if (extMatch) {
      const ext = extMatch[1]
      // svg はロゴに多い。許可は jpg/jpeg/png/webp/gif。拡張子なしCDNは上で許可。
      if (!['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return true
    }
  } catch {
    return true
  }

  return false
}

function looksLikeImageUrl(url: string): boolean {
  if (isRejectedImageUrl(url)) return false
  // 拡張子なし CDN も許可
  return true
}

function pickFirstValidUrl(
  candidates: Array<string | null | undefined>,
  pageUrl: string,
): string | null {
  for (const c of candidates) {
    const normalized = normalizeImageUrl(c, pageUrl)
    if (!normalized) continue
    if (!looksLikeImageUrl(normalized)) continue
    return normalized
  }
  return null
}

/**
 * JSON-LD Event.image の各種形式から代表1枚を取得。
 * string / string[] / ImageObject / ImageObject[] / contentUrl
 */
export function extractJsonLdImageUrl(
  imageField: unknown,
  pageUrl: string,
): string | null {
  if (imageField == null) return null

  if (typeof imageField === 'string') {
    return pickFirstValidUrl([imageField], pageUrl)
  }

  if (Array.isArray(imageField)) {
    for (const item of imageField) {
      const hit = extractJsonLdImageUrl(item, pageUrl)
      if (hit) return hit
    }
    return null
  }

  if (typeof imageField === 'object') {
    const obj = imageField as Record<string, unknown>
    // contentUrl 優先、次に url
    const fromContent = pickFirstValidUrl(
      [typeof obj.contentUrl === 'string' ? obj.contentUrl : null],
      pageUrl,
    )
    if (fromContent) return fromContent
    const fromUrl = pickFirstValidUrl(
      [typeof obj.url === 'string' ? obj.url : null],
      pageUrl,
    )
    if (fromUrl) return fromUrl
    // 稀に image ネスト
    if ('image' in obj) {
      return extractJsonLdImageUrl(obj.image, pageUrl)
    }
  }

  return null
}

export type HtmlImageCandidate = {
  src: string
  width?: number | null
  height?: number | null
  className?: string | null
  alt?: string | null
}

function parseDimension(value: string | null | undefined): number | null {
  if (!value) return null
  const n = Number(String(value).replace(/px$/i, '').trim())
  return Number.isFinite(n) && n > 0 ? n : null
}

export function isTooSmallImage(candidate: HtmlImageCandidate): boolean {
  const w = candidate.width ?? null
  const h = candidate.height ?? null
  if (w != null && w > 0 && w < MIN_DIMENSION) return true
  if (h != null && h > 0 && h < MIN_DIMENSION) return true
  return false
}

function scoreHtmlCandidate(
  candidate: HtmlImageCandidate,
  pageUrl: string,
): number {
  const url = normalizeImageUrl(candidate.src, pageUrl)
  if (!url || !looksLikeImageUrl(url)) return -1
  if (isTooSmallImage(candidate)) return -1

  let score = 10
  const lower = url.toLowerCase()
  const cls = (candidate.className ?? '').toLowerCase()
  const alt = (candidate.alt ?? '').toLowerCase()

  // サイト別のイベント画像らしさ
  if (/\/spot\/(ex|ev)\d+\//i.test(lower)) score += 50
  if (/\/assets\/images\/event(\/|_draft\/)/i.test(lower)) score += 50
  if (/js-image-view-image/.test(cls)) score += 40
  if (/event|exhibition|spot/.test(cls)) score += 10
  if (alt && !/facebook|twitter|youtube|instagram|logo/.test(alt)) score += 5

  // 共通・広告は減点（reject 済みでも念のため）
  if (/\/shared\//i.test(lower)) score -= 20
  if (/\/assets\/pr\//i.test(lower)) score -= 100
  if (/ogp\.png/i.test(lower)) score -= 100

  const w = candidate.width ?? 0
  const h = candidate.height ?? 0
  if (w >= 200 || h >= 200) score += 15
  else if (w >= 100 || h >= 100) score += 5

  return score
}

/**
 * 詳細ページ内 img からイベントメイン画像候補を1枚選ぶ。
 */
export function pickHtmlEventImage(
  candidates: HtmlImageCandidate[],
  pageUrl: string,
): string | null {
  let best: { url: string; score: number } | null = null
  for (const c of candidates) {
    const score = scoreHtmlCandidate(c, pageUrl)
    if (score < 20) continue // イベントらしさの最低ライン
    const url = normalizeImageUrl(c.src, pageUrl)
    if (!url) continue
    if (!best || score > best.score) best = { url, score }
  }
  return best?.url ?? null
}

/**
 * meta og/twitter はサイト共通 OGP を除外してから採用。
 */
export function pickMetaEventImage(
  raw: string | null | undefined,
  pageUrl: string,
): string | null {
  const url = normalizeImageUrl(raw, pageUrl)
  if (!url) return null
  if (!looksLikeImageUrl(url)) return null
  // サイト共通 OGP / ロゴはイベント画像ではない
  if (/\/ogp\/ogp\.(png|jpe?g|webp)/i.test(url)) return null
  if (/\/shared\/site_gotokyo\//i.test(url)) return null
  return url
}

/**
 * 優先順位: JSON-LD → og:image → twitter:image → HTML fallback
 */
export function resolveEventImage(opts: {
  pageUrl: string
  jsonLdImageField?: unknown
  ogImage?: string | null
  twitterImage?: string | null
  htmlCandidates?: HtmlImageCandidate[]
}): EventImageResolveResult {
  const { pageUrl } = opts

  const fromLd = extractJsonLdImageUrl(opts.jsonLdImageField, pageUrl)
  if (fromLd) {
    return {
      image_url: fromLd,
      source: 'jsonld',
      source_detail: 'json-ld.Event.image',
      action: 'parsed',
      reason: null,
    }
  }

  const fromOg = pickMetaEventImage(opts.ogImage, pageUrl)
  if (fromOg) {
    return {
      image_url: fromOg,
      source: 'og:image',
      source_detail: 'meta[property=og:image]',
      action: 'parsed',
      reason: null,
    }
  }

  const fromTw = pickMetaEventImage(opts.twitterImage, pageUrl)
  if (fromTw) {
    return {
      image_url: fromTw,
      source: 'twitter:image',
      source_detail: 'meta[name=twitter:image]',
      action: 'parsed',
      reason: null,
    }
  }

  const fromHtml = pickHtmlEventImage(opts.htmlCandidates ?? [], pageUrl)
  if (fromHtml) {
    return {
      image_url: fromHtml,
      source: 'html',
      source_detail: 'img fallback',
      action: 'parsed',
      reason: null,
    }
  }

  return {
    image_url: null,
    source: null,
    source_detail: null,
    action: 'keep_null',
    reason: 'no_valid_event_image',
  }
}

export function collectHtmlImageCandidates(
  imgs: Array<{
    src?: string | null
    width?: string | null
    height?: string | null
    className?: string | null
    alt?: string | null
  }>,
): HtmlImageCandidate[] {
  return imgs
    .map((img) => ({
      src: img.src ?? '',
      width: parseDimension(img.width),
      height: parseDimension(img.height),
      className: img.className ?? null,
      alt: img.alt ?? null,
    }))
    .filter((c) => Boolean(c.src))
}

export function logEventImageResolve(opts: {
  title?: string | null
  result: EventImageResolveResult
}): void {
  const { title, result } = opts
  console.log('[image]')
  if (title) console.log(`title: ${title}`)
  if (result.action === 'parsed' && result.image_url) {
    console.log(`source: ${result.source ?? 'unknown'}`)
    console.log(`image_url: ${result.image_url}`)
  } else {
    console.log(`action: ${result.action}`)
    console.log(`reason: ${result.reason ?? 'null'}`)
  }
}
