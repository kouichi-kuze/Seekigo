/**
 * Minimal HTML metadata + short excerpt extraction (no full body storage).
 */
import * as cheerio from 'cheerio'
import { stripTags, truncateExcerpt } from './normalize'
import type { ParsedPage } from './types'

function meta($: cheerio.CheerioAPI, ...names: string[]): string | null {
  for (const name of names) {
    const byName = $(`meta[name="${name}"]`).attr('content')
    if (byName?.trim()) return byName.trim()
    const byProp = $(`meta[property="${name}"]`).attr('content')
    if (byProp?.trim()) return byProp.trim()
  }
  return null
}

export function parseHtmlPage(html: string, finalUrl: string): ParsedPage {
  const $ = cheerio.load(html)

  const title =
    meta($, 'og:title') ||
    $('title').first().text().replace(/\s+/g, ' ').trim() ||
    null

  const description =
    meta($, 'og:description', 'description', 'twitter:description') || null

  const siteName = meta($, 'og:site_name') || null
  const publishedAt =
    meta($, 'article:published_time', 'pubdate', 'publishdate') ||
    $('time[datetime]').first().attr('datetime') ||
    null

  const canonical =
    $('link[rel="canonical"]').attr('href')?.trim() ||
    meta($, 'og:url') ||
    null

  let canonicalUrl: string | null = null
  if (canonical) {
    try {
      canonicalUrl = new URL(canonical, finalUrl).href
    } catch {
      canonicalUrl = null
    }
  }

  const mainText = stripTags(
    $('article').first().text() ||
      $('main').first().text() ||
      $('[role="main"]').first().text() ||
      '',
  )

  const excerpt = truncateExcerpt(
    [description, mainText].filter(Boolean).join(' — ') || title || '',
  )

  return {
    finalUrl,
    contentKind: 'html',
    title,
    description,
    siteName,
    publishedAt,
    canonicalUrl,
    excerpt,
  }
}

export function looksLikeFeed(contentType: string, body: string): 'rss' | 'atom' | null {
  const ct = contentType.toLowerCase()
  if (ct.includes('rss')) return 'rss'
  if (ct.includes('atom')) return 'atom'
  const head = body.slice(0, 400).toLowerCase()
  if (head.includes('<rss') || head.includes('<rdf:rdf')) return 'rss'
  if (head.includes('<feed') && head.includes('atom')) return 'atom'
  return null
}
