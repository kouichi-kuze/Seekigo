/**
 * Minimal RSS / Atom parse. Stores short item excerpts only.
 */
import * as cheerio from 'cheerio'
import { stripTags, truncateExcerpt } from './normalize'
import type { ParsedPage } from './types'

function textOf($el: { html: () => string | null; text: () => string }): string {
  const cdata = $el.html() ?? ''
  if (cdata.includes('<')) return stripTags(cdata)
  return $el.text().replace(/\s+/g, ' ').trim()
}

export function parseFeedXml(
  xml: string,
  finalUrl: string,
  kind: 'rss' | 'atom',
): ParsedPage {
  const $ = cheerio.load(xml, { xml: true })

  if (kind === 'atom') {
    const feedTitle = $('feed > title').first().text().trim() || null
    const items: NonNullable<ParsedPage['items']> = []
    $('entry').each((_, el) => {
      if (items.length >= 20) return false
      const $el = $(el)
      const title = $el.find('title').first().text().replace(/\s+/g, ' ').trim() || null
      const link =
        $el.find('link[rel="alternate"]').attr('href') ||
        $el.find('link').attr('href') ||
        null
      const publishedAt =
        $el.find('published').first().text().trim() ||
        $el.find('updated').first().text().trim() ||
        null
      const summary =
        textOf($el.find('summary').first()) ||
        textOf($el.find('content').first()) ||
        ''
      items.push({
        title,
        link: link
          ? (() => {
              try {
                return new URL(link, finalUrl).href
              } catch {
                return link
              }
            })()
          : null,
        publishedAt,
        excerpt: truncateExcerpt([title, summary].filter(Boolean).join(' — ')),
      })
    })

    return {
      finalUrl,
      contentKind: 'atom',
      title: feedTitle,
      description: null,
      siteName: feedTitle,
      publishedAt: null,
      canonicalUrl: null,
      excerpt: truncateExcerpt(feedTitle ?? ''),
      items,
    }
  }

  const channelTitle = $('channel > title').first().text().trim() || null
  const items: NonNullable<ParsedPage['items']> = []
  $('channel > item, item').each((_, el) => {
    if (items.length >= 20) return false
    const $el = $(el)
    const title = $el.find('title').first().text().replace(/\s+/g, ' ').trim() || null
    const link = $el.find('link').first().text().trim() || $el.find('link').attr('href') || null
    const publishedAt =
      $el.find('pubDate').first().text().trim() ||
      $el.find('dc\\:date, date').first().text().trim() ||
      null
    const summary =
      textOf($el.find('description').first()) ||
      textOf($el.find('content\\:encoded').first()) ||
      ''
    items.push({
      title,
      link: link
        ? (() => {
            try {
              return new URL(link, finalUrl).href
            } catch {
              return link
            }
          })()
        : null,
      publishedAt,
      excerpt: truncateExcerpt([title, summary].filter(Boolean).join(' — ')),
    })
  })

  return {
    finalUrl,
    contentKind: 'rss',
    title: channelTitle,
    description: null,
    siteName: channelTitle,
    publishedAt: null,
    canonicalUrl: null,
    excerpt: truncateExcerpt(channelTitle ?? ''),
    items,
  }
}
