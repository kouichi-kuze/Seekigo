/**
 * URL / source_type normalization for reaction web collector.
 * Reuses src/lib/event-dedupe.normalizeUrl for dedupe keys.
 */
import { normalizeUrl } from '../../../src/lib/event-dedupe'
import type { CandidateKind, ReactionWebSourceType } from './types'

export { normalizeUrl as normalizeReactionSourceUrl }

const EXCERPT_MAX = 400

export function truncateExcerpt(text: string, max = EXCERPT_MAX): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= max) return cleaned
  return `${cleaned.slice(0, max - 1)}…`
}

export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

export function classifySourceType(opts: {
  url: string
  kind: CandidateKind
  contentKind: 'html' | 'rss' | 'atom'
  hintedType?: ReactionWebSourceType
  isOfficialDomain: boolean
}): ReactionWebSourceType {
  if (opts.hintedType) return opts.hintedType
  if (opts.contentKind === 'rss' || opts.contentKind === 'atom') return 'rss'
  if (opts.kind === 'official_url' || opts.isOfficialDomain) return 'official_web'
  if (opts.kind === 'press') return 'press_release'
  if (opts.kind === 'rss') return 'rss'

  const host = (() => {
    try {
      return new URL(opts.url).hostname.toLowerCase()
    } catch {
      return ''
    }
  })()

  if (
    /news|nikkei|asahi|yomiuri|mainichi|nhk|reuters|kyodo|jiji/.test(host) ||
    opts.kind === 'blog_news'
  ) {
    if (/blog|note\.com|medium\.com/.test(host)) return 'blog'
    return 'news'
  }
  if (/blog|note\.com|medium\.com|hatena/.test(host)) return 'blog'
  if (/press|prtimes|newsrelease/.test(host) || /\/press\//i.test(opts.url)) {
    return 'press_release'
  }
  return 'other_web'
}

export function sameRegistrableHint(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  try {
    const ha = new URL(a).hostname.toLowerCase().replace(/^www\./, '')
    const hb = new URL(b).hostname.toLowerCase().replace(/^www\./, '')
    return ha === hb || ha.endsWith(`.${hb}`) || hb.endsWith(`.${ha}`)
  } catch {
    return false
  }
}
