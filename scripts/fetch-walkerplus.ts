/**
 * Walkerplus Phase 0.5 — 東京イベント一覧プローブ（調査のみ・DB非接触）
 *
 * 出力: tmp/walkerplus-events.json
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cheerio from 'cheerio'
import type { Cheerio, CheerioAPI } from 'cheerio'
import type { Element } from 'domhandler'
import {
  cleanText,
  extractWalkerplusEventId,
  parseWalkerplusDateText,
  randomGapMs,
  sleep,
  toAbsoluteUrl,
  WALKERPLUS_PHASE_MAX_ITEMS,
  type WalkerplusListEvent,
} from './lib/walkerplus-parse'

export type { WalkerplusListEvent } from './lib/walkerplus-parse'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const DEFAULT_LIST_URL = 'https://www.walkerplus.com/event_list/ar0313/'
const SITE_ORIGIN = 'https://www.walkerplus.com'

const MAX_ITEMS = Math.min(
  Number.parseInt(
    process.env.WALKERPLUS_MAX_ITEMS ?? String(WALKERPLUS_PHASE_MAX_ITEMS),
    10,
  ) || WALKERPLUS_PHASE_MAX_ITEMS,
  WALKERPLUS_PHASE_MAX_ITEMS,
)
const MAX_LIST_PAGES = Math.min(
  Number.parseInt(process.env.WALKERPLUS_MAX_LIST_PAGES ?? '5', 10) || 5,
  10,
)
const GAP_MIN_MS = 2000
const GAP_MAX_MS = 3000

const listUrl = process.env.WALKERPLUS_LIST_URL?.trim() || DEFAULT_LIST_URL

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const tmpDir = path.join(rootDir, 'tmp')
const htmlPath = path.join(tmpDir, 'walkerplus-latest.html')
const outPath = path.join(tmpDir, 'walkerplus-events.json')

function findEventContainer($: CheerioAPI, $link: Cheerio<Element>): Cheerio<Element> {
  const selectors = [
    'article',
    'li',
    '[class*="event"]',
    '[class*="Event"]',
    '.c-card',
    '.card',
  ]
  for (const sel of selectors) {
    const $parent = $link.closest(sel)
    if ($parent.length > 0) return $parent.first()
  }
  return $link.parent()
}

function extractDateTextFromContainer($: CheerioAPI, $root: Cheerio<Element>): string | null {
  const candidates: string[] = []
  $root.find('time, p, span, div').each((_, el) => {
    const t = cleanText($(el).text())
    if (!t) return
    if (/\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/.test(t)) {
      candidates.push(t)
    }
    if (/^(開催中|終了間近|終了間際)/.test(t) && /\d{1,2}\s*月/.test(t)) {
      candidates.push(t)
    }
    if (/開催中\s*[〜～\-－—~]/.test(t)) {
      candidates.push(t)
    }
  })
  if (candidates.length === 0) {
    const block = cleanText($root.text())
    const m = block?.match(
      /(開催中[^。\n]{0,40}?\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日[^。\n]{0,60}|終了間近[^。\n]{0,80}?\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日[^。\n]{0,60}|開催中\s*[〜～\-－—~]\s*\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日[^。\n]{0,40}|\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日[^。\n]{0,80})/,
    )
    return m ? cleanText(m[1]) : null
  }
  return candidates.sort((a, b) => b.length - a.length)[0] ?? null
}

function extractAreaVenue($: CheerioAPI, $root: Cheerio<Element>): {
  area_text: string | null
  venue: string | null
} {
  const lines = cleanText($root.text())?.split(/\s{2,}|\n/) ?? []
  let area_text: string | null = null
  let venue: string | null = null

  for (const line of lines) {
    const t = cleanText(line)
    if (!t) continue
    if (!area_text && /^(東京都|神奈川県|埼玉県|千葉県|大阪府|北海道|.+?[都道府県])\s*.+/.test(t)) {
      area_text = t
      continue
    }
    if (
      !venue &&
      t.length >= 2 &&
      t.length <= 120 &&
      !/^\d{4}\s*年/.test(t) &&
      !/^(開催中|終了間近|駐車場|入場無料)/.test(t) &&
      !/美術展|祭り|アニメ|体験イベント|商業施設/.test(t)
    ) {
      if (area_text && t === area_text) continue
      if (!venue) venue = t
    }
  }

  return { area_text, venue }
}

function extractCategories($: CheerioAPI, $root: Cheerio<Element>): string[] {
  const cats = new Set<string>()
  const known = [
    '祭り',
    'フェスティバル・パレード',
    '美術展・博物展',
    '商業施設のイベント',
    '商業施設イベント',
    'アニメ・ゲーム',
    '体験イベント・アクティビティ',
    'グルメ・フードフェス',
    '物産展・観光フェア',
    'ライブ・音楽イベント',
    '映画イベント',
    'スポーツイベント',
    '展示会',
    '無料イベント',
    '入場無料',
    'ライトアップ',
  ]
  const text = cleanText($root.text()) ?? ''
  for (const k of known) {
    if (text.includes(k)) cats.add(k)
  }
  return [...cats]
}

function extractSummary($: CheerioAPI, $root: Cheerio<Element>, title: string): string | null {
  const paragraphs = $root
    .find('p')
    .map((_, el) => cleanText($(el).text()))
    .get()
    .filter((p): p is string => Boolean(p))

  for (const p of paragraphs) {
    if (p === title) continue
    if (/\d{4}\s*年\s*\d{1,2}\s*月/.test(p)) continue
    if (/^(東京都|大阪府)/.test(p)) continue
    if (p.length >= 8 && p.length <= 200) return p
  }
  return null
}

export function extractWalkerplusListEvents(
  html: string,
  pageUrl: string,
  maxItems: number,
): { events: WalkerplusListEvent[]; diagnostics: string[] } {
  const $ = cheerio.load(html)
  const diagnostics: string[] = []
  const seen = new Set<string>()
  const events: WalkerplusListEvent[] = []
  const fetched_at = new Date().toISOString()

  const linkCount = $('a[href*="/event/ar"]').filter((_, a) =>
    /\/event\/ar\d+e\d+/i.test($(a).attr('href') ?? ''),
  ).length
  diagnostics.push(`selector a[href*="/event/ar..."] count: ${linkCount}`)

  $('a[href*="/event/ar"]').each((_, el) => {
    if (events.length >= maxItems) return false

    const href = $(el).attr('href')
    if (!href || !/\/event\/ar\d+e\d+/i.test(href)) return

    const detail_url = toAbsoluteUrl(href, pageUrl)
    if (!detail_url || seen.has(detail_url)) return
    seen.add(detail_url)

    const $link = $(el)
    const $root = findEventContainer($, $link)

    const title =
      cleanText($link.attr('title')) ||
      cleanText($link.text()) ||
      cleanText($root.find('h2, h3, h4').first().text())

    if (!title || title.length < 2) return

    const dateRaw = extractDateTextFromContainer($, $root)
    const { date_text, start_date, end_date } = parseWalkerplusDateText(dateRaw)
    const { area_text, venue } = extractAreaVenue($, $root)
    const categories = extractCategories($, $root)
    const summary = extractSummary($, $root, title)

    const imgSrc =
      $root.find('img[src]').first().attr('src') ||
      $link.find('img[src]').first().attr('src')
    const image_url = toAbsoluteUrl(imgSrc, pageUrl)

    events.push({
      source_name: 'walkerplus',
      source_event_id: extractWalkerplusEventId(detail_url),
      title,
      detail_url,
      date_text,
      start_date,
      end_date,
      venue,
      area_text,
      summary,
      categories,
      image_url,
      fetched_at,
    })
  })

  if (events.length === 0) {
    diagnostics.push(
      '抽出0件: a[href*="/event/ar..."] から title/detail_url を取得できませんでした。',
    )
  }

  return { events, diagnostics }
}

async function fetchHtml(targetUrl: string): Promise<{ html: string; status: number }> {
  console.log(`[fetch-walkerplus] GET ${targetUrl}`)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.8',
      },
      redirect: 'follow',
      signal: controller.signal,
    })
    const html = await response.text()
    return { html, status: response.status }
  } finally {
    clearTimeout(timeout)
  }
}

function listPageUrl(baseUrl: string, page: number): string {
  if (page <= 1) return baseUrl
  const normalized = baseUrl.replace(/\/$/, '')
  return `${normalized}/${page}.html`
}

async function main() {
  console.log('[fetch-walkerplus] Walkerplus probe — list fetch (Phase 0.5)')
  console.log(`[fetch-walkerplus] max items: ${MAX_ITEMS}, max pages: ${MAX_LIST_PAGES}`)

  await mkdir(tmpDir, { recursive: true })

  const allEvents: WalkerplusListEvent[] = []
  const diagnostics: string[] = []
  let lastHtml = ''

  for (let page = 1; page <= MAX_LIST_PAGES && allEvents.length < MAX_ITEMS; page++) {
    const pageUrl = listPageUrl(listUrl, page)
    if (page > 1) {
      const gap = randomGapMs(GAP_MIN_MS, GAP_MAX_MS)
      console.log(`[fetch-walkerplus] sleep ${gap}ms`)
      await sleep(gap)
    }

    const { html, status } = await fetchHtml(pageUrl)
    console.log(`[fetch-walkerplus] page ${page} status: ${status}`)
    lastHtml = html

    if (status !== 200) {
      diagnostics.push(`page ${page}: HTTP ${status}`)
      break
    }

    const remaining = MAX_ITEMS - allEvents.length
    const { events, diagnostics: pageDiag } = extractWalkerplusListEvents(
      html,
      pageUrl || SITE_ORIGIN,
      remaining,
    )
    diagnostics.push(`page ${page}: extracted ${events.length}`)
    for (const line of pageDiag) diagnostics.push(`page ${page}: ${line}`)

    const seen = new Set(allEvents.map((e) => e.detail_url))
    for (const event of events) {
      if (seen.has(event.detail_url)) continue
      seen.add(event.detail_url)
      allEvents.push(event)
      if (allEvents.length >= MAX_ITEMS) break
    }

    if (events.length === 0) break
  }

  if (lastHtml) {
    await writeFile(htmlPath, lastHtml, 'utf8')
    console.log(
      `[fetch-walkerplus] saved last HTML → ${path.relative(rootDir, htmlPath)}`,
    )
  }

  const events = allEvents.slice(0, MAX_ITEMS)

  for (const line of diagnostics) {
    console.log(`[fetch-walkerplus] ${line}`)
  }

  const payload = {
    fetchedAt: new Date().toISOString(),
    phase: '0.5',
    sourceUrl: listUrl,
    count: events.length,
    events,
    diagnostics,
  }

  await writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8')
  console.log(`[fetch-walkerplus] saved → ${path.relative(rootDir, outPath)}`)
  console.log(`[fetch-walkerplus] extracted: ${events.length} event(s)`)

  events.forEach((e, i) => {
    console.log(`[fetch-walkerplus] ${i + 1}. ${e.title}`)
    console.log(`[fetch-walkerplus]    ${e.detail_url}`)
  })

  console.log('[fetch-walkerplus] done (no DB write)')
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) {
  main().catch((error) => {
    console.error('[fetch-walkerplus] fatal:', error)
    process.exit(1)
  })
}
