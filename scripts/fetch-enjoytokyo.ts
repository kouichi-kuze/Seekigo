/**
 * レッツエンジョイ東京 一覧ページを1件取得し、祭りイベント候補を抽出する試作。
 * - AI なし / Supabase 書き込みなし
 * - HTML・抽出JSON は git 管理外の tmp/ に保存
 */
import { config } from 'dotenv'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cheerio from 'cheerio'
import type { Cheerio } from 'cheerio'
import type { Element } from 'domhandler'

config()

const USER_AGENT =
  'SeekigoFetch/0.1 (+https://seekigo.com; single-page research fetch; not a crawler)'

/** 1ページのみ。環境変数 ENJOYTOKYO_URL で上書き可 */
const DEFAULT_URL = 'https://www.enjoytokyo.jp/event/list/cat0901/'
const SITE_ORIGIN = 'https://www.enjoytokyo.jp'
const MAX_EVENTS = 10

const url = process.env.ENJOYTOKYO_URL?.trim() || DEFAULT_URL

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const tmpDir = path.join(rootDir, 'tmp')
const htmlPath = path.join(tmpDir, 'enjoytokyo-latest.html')
const eventsJsonPath = path.join(tmpDir, 'enjoytokyo-events.json')

type EnjoyTokyoEvent = {
  title: string
  detail_url: string
  start_date: string | null
  end_date: string | null
  venue: string | null
  area: string | null
}

function cleanText(value: string | undefined | null): string | null {
  if (!value) return null
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > 0 ? text : null
}

function toAbsoluteUrl(href: string | undefined | null, baseUrl: string): string | null {
  const trimmed = href?.trim()
  if (!trimmed || trimmed.startsWith('javascript:') || trimmed === '#') {
    return null
  }
  try {
    return new URL(trimmed, baseUrl).href
  } catch {
    return null
  }
}

/** YYYY/MM/DD or YYYY-MM-DD → YYYY-MM-DD。年がない場合は null */
function parseYmd(token: string | undefined | null): string | null {
  if (!token) return null
  const cleaned = token.trim()

  const withYear = cleaned.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/)
  if (withYear) {
    return `${withYear[1]}-${withYear[2].padStart(2, '0')}-${withYear[3].padStart(2, '0')}`
  }

  // 年省略（例: 09/23）は推測しない
  return null
}

/**
 * 一覧の日付文言を解析。
 * - 「2026/09/19(土) ～ 09/23(水・祝)」→ end に年なしのため end_date=null
 * - 「 ～ 2026/08/31(月)」→ start_date=null
 * - 「2026/08/29(土)」→ start/end 同日
 */
function parseEventDateText(raw: string | null): {
  start_date: string | null
  end_date: string | null
} {
  if (!raw) return { start_date: null, end_date: null }

  // 注記（※以降）は除外
  const text = raw.split('※')[0].replace(/\s+/g, ' ').trim()

  const range = text.match(
    /(\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}[/-]\d{1,2})(?:\([^)]*\))?\s*[〜～\-–—]\s*(\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}[/-]\d{1,2})/,
  )
  if (range) {
    return {
      start_date: parseYmd(range[1]),
      end_date: parseYmd(range[2]),
    }
  }

  // 「 ～ 2026/08/31(月)」形式（開始欠落）
  const endOnly = text.match(
    /^[〜～\-–—]\s*(\d{4}[/-]\d{1,2}[/-]\d{1,2})(?:\([^)]*\))?/,
  )
  if (endOnly) {
    return { start_date: null, end_date: parseYmd(endOnly[1]) }
  }

  const single = text.match(/(\d{4}[/-]\d{1,2}[/-]\d{1,2})(?:\([^)]*\))?/)
  if (single) {
    const day = parseYmd(single[1])
    return { start_date: day, end_date: day }
  }

  return { start_date: null, end_date: null }
}

function extractArea($item: Cheerio<Element>): string | null {
  const raw = cleanText($item.find('.event-area p').first().text())
  if (!raw) return null
  // 「東京都　港区」→ ページ上の市区町村部分をそのまま使う（slug 推測はしない）
  const withoutPref = raw.replace(/^東京都\s*/, '').trim()
  return withoutPref || raw
}

function extractVenue($item: Cheerio<Element>): string | null {
  const fromLink = cleanText(
    $item.find('li._spot ._event-info-detail a').first().text(),
  )
  if (fromLink) return fromLink
  return cleanText($item.find('li._spot ._event-info-detail').first().text())
}

function extractEventsFromHtml(
  html: string,
  pageUrl: string,
): { events: EnjoyTokyoEvent[]; diagnostics: string[] } {
  const $ = cheerio.load(html)
  const diagnostics: string[] = []

  const listCount = $('#ul-event-list').length
  const itemCount = $('#ul-event-list > li.article-list_vertical-item').length
  const fallbackItemCount = $('li.article-list_vertical-item').length
  const detailLinkCount = $(
    'a.article-link[href*="/event/"]',
  ).filter((_, a) => /\/event\/\d+\/?/.test($(a).attr('href') || '')).length

  diagnostics.push(`selector #ul-event-list count: ${listCount}`)
  diagnostics.push(
    `selector #ul-event-list > li.article-list_vertical-item count: ${itemCount}`,
  )
  diagnostics.push(
    `selector li.article-list_vertical-item count: ${fallbackItemCount}`,
  )
  diagnostics.push(
    `selector a.article-link[href*="/event/\\d+"] count: ${detailLinkCount}`,
  )

  const items =
    itemCount > 0
      ? $('#ul-event-list > li.article-list_vertical-item')
      : $('li.article-list_vertical-item')

  const seen = new Set<string>()
  const events: EnjoyTokyoEvent[] = []

  items.each((_, el) => {
    if (events.length >= MAX_EVENTS) {
      return false
    }

    const $item = $(el)
    const detailHref =
      $item
        .find('a.article-link[href*="/event/"]')
        .filter((__, a) => /\/event\/\d+\/?/.test($(a).attr('href') || ''))
        .first()
        .attr('href') ?? null

    const detail_url = toAbsoluteUrl(detailHref, pageUrl || SITE_ORIGIN)
    if (!detail_url) return
    if (seen.has(detail_url)) return
    seen.add(detail_url)

    const title =
      cleanText(
        $item.find('.pc-fixed-heigh_title p, .article-link-text p').first().text(),
      ) ||
      cleanText(
        $item.find('a.article-link[href*="/event/"] img').first().attr('alt'),
      )

    if (!title) return

    const dateText = cleanText($item.find('p.event-date span, p.event-date').first().text())
    const { start_date, end_date } = parseEventDateText(dateText)

    events.push({
      title,
      detail_url,
      start_date,
      end_date,
      venue: extractVenue($item),
      area: extractArea($item),
    })
  })

  if (events.length === 0) {
    diagnostics.push(
      '抽出0件: #ul-event-list > li.article-list_vertical-item から title /detail_url を取得できませんでした。',
    )
  }

  return { events, diagnostics }
}

async function fetchHtml(targetUrl: string): Promise<string> {
  console.log('[fetch-enjoytokyo] start')
  console.log(`[fetch-enjoytokyo] url: ${targetUrl}`)
  console.log(`[fetch-enjoytokyo] user-agent: ${USER_AGENT}`)

  let response: Response
  try {
    response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.8',
      },
      redirect: 'follow',
    })
  } catch (error) {
    console.error('[fetch-enjoytokyo] network error:', error)
    process.exit(1)
  }

  console.log(
    `[fetch-enjoytokyo] status: ${response.status} ${response.statusText}`,
  )
  console.log(
    `[fetch-enjoytokyo] content-type: ${response.headers.get('content-type') ?? '(none)'}`,
  )

  if (!response.ok) {
    console.error(
      `[fetch-enjoytokyo] HTTP error: expected 2xx, got ${response.status}`,
    )
    process.exit(1)
  }

  const html = await response.text()
  const byteLength = Buffer.byteLength(html, 'utf8')

  console.log('[fetch-enjoytokyo] html received: yes')
  console.log(
    `[fetch-enjoytokyo] html length: ${html.length} chars / ${byteLength} bytes`,
  )
  console.log(
    `[fetch-enjoytokyo] html preview: ${html.slice(0, 120).replace(/\s+/g, ' ')}…`,
  )

  return html
}

async function main() {
  const html = await fetchHtml(url)

  await mkdir(tmpDir, { recursive: true })
  await writeFile(htmlPath, html, 'utf8')
  console.log(
    `[fetch-enjoytokyo] saved snapshot to ${path.relative(rootDir, htmlPath)} (gitignored)`,
  )

  const savedHtml = await readFile(htmlPath, 'utf8')
  console.log('[fetch-enjoytokyo] parsing tmp/enjoytokyo-latest.html …')

  const { events, diagnostics } = extractEventsFromHtml(savedHtml, url)

  for (const line of diagnostics) {
    console.log(`[fetch-enjoytokyo] ${line}`)
  }

  console.log(
    `[fetch-enjoytokyo] extracted: ${events.length} event(s) (max ${MAX_EVENTS})`,
  )
  console.log('[fetch-enjoytokyo] ---- event candidates ----')

  if (events.length === 0) {
    console.log('[fetch-enjoytokyo] (none)')
  } else {
    events.forEach((event, index) => {
      console.log(`[fetch-enjoytokyo] ${index + 1}. ${event.title}`)
      console.log(`[fetch-enjoytokyo]    ${event.detail_url}`)
      console.log(
        `[fetch-enjoytokyo]    date: ${event.start_date ?? 'null'} ~ ${event.end_date ?? 'null'}`,
      )
      console.log(
        `[fetch-enjoytokyo]    venue: ${event.venue ?? 'null'} / area: ${event.area ?? 'null'}`,
      )
    })
  }

  console.log('[fetch-enjoytokyo] ----------------------------')

  const payload = {
    fetchedAt: new Date().toISOString(),
    sourceUrl: url,
    count: events.length,
    events,
  }
  await writeFile(eventsJsonPath, JSON.stringify(payload, null, 2), 'utf8')
  console.log(
    `[fetch-enjoytokyo] saved ${path.relative(rootDir, eventsJsonPath)} (gitignored)`,
  )
  console.log('[fetch-enjoytokyo] done (no AI / no Supabase write)')
}

main().catch((error) => {
  console.error('[fetch-enjoytokyo] unexpected error:', error)
  process.exit(1)
})
