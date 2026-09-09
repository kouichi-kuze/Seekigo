/**
 * Prefer official English event titles from official_url
 * (og:title, title, JSON-LD, hreflang=en alternate).
 */
import * as cheerio from 'cheerio'
import { safeFetchText } from '../reaction-web/fetch'
import { isWalkerplusUrl } from '../visit-enrich/sources'

export type OfficialTitleCandidate = {
  value: string
  source: string
}

export type OfficialEnglishTitleResult = {
  title: string | null
  source: string | null
  candidates: OfficialTitleCandidate[]
  fetch_note: string | null
}

const JP_CHAR_RE = /[\u3040-\u30ff\u3400-\u9fff]/g
const LATIN_RE = /[A-Za-z]/g

/** Heuristic: enough Latin, little Japanese → likely English title. */
export function looksLikeEnglishTitle(raw: string): boolean {
  const t = raw.replace(/\s+/g, ' ').trim()
  if (t.length < 3 || t.length > 200) return false
  const latin = (t.match(LATIN_RE) || []).length
  const jp = (t.match(JP_CHAR_RE) || []).length
  if (latin < 4) return false
  if (jp > Math.max(2, Math.floor(latin * 0.35))) return false
  if (/^(home|official|top|news|blog)$/i.test(t)) return false
  return true
}

function cleanTitle(raw: string | null | undefined): string | null {
  if (!raw) return null
  let t = raw.replace(/\s+/g, ' ').trim()
  t = t.split(/\s*[|｜–—]\s*/)[0]?.trim() || t
  t = t.replace(/\s*[-–—]\s*(公式|Official).*$/i, '').trim()
  return t || null
}

function pushCandidate(
  out: OfficialTitleCandidate[],
  seen: Set<string>,
  value: string | null | undefined,
  source: string,
): void {
  const cleaned = cleanTitle(value)
  if (!cleaned) return
  if (!looksLikeEnglishTitle(cleaned)) return
  const key = cleaned.toLowerCase()
  if (seen.has(key)) return
  seen.add(key)
  out.push({ value: cleaned, source })
}

function walkJsonLd(
  node: unknown,
  onName: (name: string) => void,
  depth = 0,
): void {
  if (!node || depth > 6) return
  if (Array.isArray(node)) {
    for (const item of node) walkJsonLd(item, onName, depth + 1)
    return
  }
  if (typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  if (typeof obj.name === 'string') onName(obj.name)
  if (typeof obj.headline === 'string') onName(obj.headline)
  if (obj['@graph']) walkJsonLd(obj['@graph'], onName, depth + 1)
}

function extractFromHtml(
  html: string,
  pageUrl: string,
): { candidates: OfficialTitleCandidate[]; enAlternate: string | null } {
  const $ = cheerio.load(html)
  const candidates: OfficialTitleCandidate[] = []
  const seen = new Set<string>()

  pushCandidate(
    candidates,
    seen,
    $('meta[property="og:title"]').attr('content'),
    'og:title',
  )
  pushCandidate(candidates, seen, $('title').first().text(), 'title')
  pushCandidate(
    candidates,
    seen,
    $('meta[name="twitter:title"]').attr('content'),
    'twitter:title',
  )

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).html()
    if (!raw) return
    try {
      const data = JSON.parse(raw) as unknown
      const nodes = Array.isArray(data) ? data : [data]
      for (const node of nodes) {
        walkJsonLd(node, (name) => {
          pushCandidate(candidates, seen, name, 'json-ld name')
        })
      }
    } catch {
      /* ignore */
    }
  })

  let enAlternate: string | null = null
  $('link[rel="alternate"][hreflang]').each((_, el) => {
    const lang = ($(el).attr('hreflang') || '').toLowerCase()
    const href = $(el).attr('href')
    if (!href) return
    if (lang === 'en' || lang.startsWith('en-')) {
      try {
        enAlternate = new URL(href, pageUrl).href
      } catch {
        /* ignore */
      }
    }
  })

  $('h1').each((_, el) => {
    pushCandidate(candidates, seen, $(el).text(), 'h1')
  })

  return { candidates, enAlternate }
}

export async function discoverOfficialEnglishTitle(
  officialUrl: string | null | undefined,
): Promise<OfficialEnglishTitleResult> {
  const url = officialUrl?.trim() || null
  if (!url) {
    return {
      title: null,
      source: null,
      candidates: [],
      fetch_note: 'no_official_url',
    }
  }
  if (isWalkerplusUrl(url)) {
    return {
      title: null,
      source: null,
      candidates: [],
      fetch_note: 'walkerplus_skipped',
    }
  }

  const fetched = await safeFetchText(url)
  if (!fetched.ok) {
    return {
      title: null,
      source: null,
      candidates: [],
      fetch_note: fetched.reason,
    }
  }

  const first = extractFromHtml(fetched.bodyText, fetched.finalUrl)
  const all = [...first.candidates]
  const seen = new Set(all.map((c) => c.value.toLowerCase()))

  if (first.enAlternate && first.enAlternate !== fetched.finalUrl) {
    const enPage = await safeFetchText(first.enAlternate)
    if (enPage.ok) {
      const second = extractFromHtml(enPage.bodyText, enPage.finalUrl)
      for (const c of second.candidates) {
        const key = c.value.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        all.push({
          value: c.value,
          source: `en_alternate:${c.source}`,
        })
      }
    }
  }

  const rank = (source: string): number => {
    if (source.startsWith('en_alternate')) return 0
    if (source === 'og:title') return 1
    if (source.startsWith('json-ld')) return 2
    if (source === 'twitter:title') return 3
    if (source === 'h1') return 4
    return 5
  }
  all.sort((a, b) => rank(a.source) - rank(b.source))

  const best = all[0] ?? null
  return {
    title: best?.value ?? null,
    source: best?.source ?? null,
    candidates: all.slice(0, 8),
    fetch_note: best ? null : 'no_english_title_found',
  }
}
