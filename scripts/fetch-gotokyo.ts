/**
 * GO TOKYO からイベント関連ページを1件取得し、イベント候補一覧を抽出する試作。
 * - Supabase 登録なし / AI 呼び出しなし
 * - HTML・抽出JSON は git 管理外の tmp/ に保存
 */
import { config } from 'dotenv'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cheerio from 'cheerio'
import { getGotokyoLimit } from './lib/gotokyo-limit'

config()

const USER_AGENT =
  'SeekigoFetch/0.1 (+https://seekigo.com; single-page research fetch; not a crawler)'

/** 1ページのみ。環境変数 GOTOKYO_URL で上書き可 */
const DEFAULT_URL = 'https://www.gotokyo.org/jp/event/index.html'
const MAX_EVENTS = getGotokyoLimit()
const SITE_ORIGIN = 'https://www.gotokyo.org'

const url = process.env.GOTOKYO_URL?.trim() || DEFAULT_URL

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const tmpDir = path.join(rootDir, 'tmp')
const htmlPath = path.join(tmpDir, 'gotokyo-latest.html')
const eventsJsonPath = path.join(tmpDir, 'gotokyo-events.json')

type EventCandidate = {
  title: string
  url: string
}

function toAbsoluteUrl(href: string, baseUrl: string): string | null {
  const trimmed = href.trim()
  if (!trimmed || trimmed.startsWith('javascript:') || trimmed === '#') {
    return null
  }

  try {
    return new URL(trimmed, baseUrl).href
  } catch {
    return null
  }
}

function extractEventsFromHtml(
  html: string,
  pageUrl: string,
): { events: EventCandidate[]; diagnostics: string[] } {
  const $ = cheerio.load(html)
  const diagnostics: string[] = []
  const wrapCount = $('.wrap_exhibition').length
  const resultNum = $('.search_result .result_num').first().text().trim()

  diagnostics.push(`selector .wrap_exhibition count: ${wrapCount}`)
  if (resultNum) {
    diagnostics.push(`search_result.result_num: ${resultNum}`)
  }

  const seen = new Set<string>()
  const events: EventCandidate[] = []

  $('.wrap_exhibition').each((_, el) => {
    if (events.length >= MAX_EVENTS) {
      return false
    }

    const $el = $(el)
    const $title = $el.find('.exhibition_ttl .ttl').first()
    const title = $title.text().replace(/\s+/g, ' ').trim()
    if (!title) {
      return
    }

    const imgSrc = $el.find('.exhibition_img img[src]').first().attr('src') ?? ''
    const spotMatch = imgSrc.match(/\/(?:jp|en|tc|kr|th)\/spot\/(ex\d+|ev\d+)\//i)

    let detailUrl: string | null = null
    if (spotMatch) {
      // GO TOKYO 上の詳細ページ（画像パスから復元）
      detailUrl = toAbsoluteUrl(
        `/jp/spot/${spotMatch[1].toLowerCase()}/index.html`,
        SITE_ORIGIN,
      )
    }

    // フォールバック: 公式ページへの data-link
    if (!detailUrl) {
      const dataLink = $title.attr('data-link')
      if (dataLink) {
        detailUrl = toAbsoluteUrl(dataLink, pageUrl)
      }
    }

    if (!detailUrl) {
      return
    }

    if (seen.has(detailUrl)) {
      return
    }
    seen.add(detailUrl)

    events.push({ title, url: detailUrl })
  })

  if (events.length === 0) {
    diagnostics.push(
      '抽出0件: .wrap_exhibition 内の .exhibition_ttl .ttl と /jp/spot/ex|ev 画像パス（または data-link）から候補を作れませんでした。',
    )
    diagnostics.push(
      'このページは検索結果が JS で埋まる構成の可能性があります（初期 HTML の検索結果が 0 件の場合あり）。',
    )

    const spotLinks = $('a[href*="/spot/ev"], a[href*="/spot/ex"]')
    const sampleLinks = spotLinks
      .slice(0, 5)
      .map((_, a) => $(a).attr('href'))
      .get()
    diagnostics.push(
      `参考: a[href*="/spot/ev|ex"] count=${spotLinks.length}, examples=${JSON.stringify(sampleLinks)}`,
    )
  }

  return { events, diagnostics }
}

async function fetchHtml(targetUrl: string): Promise<string> {
  console.log('[fetch-gotokyo] start')
  console.log(`[fetch-gotokyo] url: ${targetUrl}`)
  console.log(`[fetch-gotokyo] user-agent: ${USER_AGENT}`)

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
    console.error('[fetch-gotokyo] network error:', error)
    process.exit(1)
  }

  console.log(`[fetch-gotokyo] status: ${response.status} ${response.statusText}`)
  console.log(
    `[fetch-gotokyo] content-type: ${response.headers.get('content-type') ?? '(none)'}`,
  )

  if (!response.ok) {
    console.error(
      `[fetch-gotokyo] HTTP error: expected 2xx, got ${response.status}`,
    )
    process.exit(1)
  }

  const html = await response.text()
  const byteLength = Buffer.byteLength(html, 'utf8')

  console.log('[fetch-gotokyo] html received: yes')
  console.log(
    `[fetch-gotokyo] html length: ${html.length} chars / ${byteLength} bytes`,
  )
  console.log(
    `[fetch-gotokyo] html preview: ${html.slice(0, 120).replace(/\s+/g, ' ')}…`,
  )

  return html
}

async function main() {
  const html = await fetchHtml(url)

  await mkdir(tmpDir, { recursive: true })
  await writeFile(htmlPath, html, 'utf8')
  console.log(
    `[fetch-gotokyo] saved snapshot to ${path.relative(rootDir, htmlPath)} (gitignored)`,
  )

  // 要件どおり保存済み HTML を読み直して解析
  const savedHtml = await readFile(htmlPath, 'utf8')
  console.log('[fetch-gotokyo] parsing tmp/gotokyo-latest.html …')

  const { events, diagnostics } = extractEventsFromHtml(savedHtml, url)

  for (const line of diagnostics) {
    console.log(`[fetch-gotokyo] ${line}`)
  }

  console.log(`[fetch-gotokyo] extracted: ${events.length} event(s) (max ${MAX_EVENTS})`)
  console.log('[fetch-gotokyo] ---- event candidates ----')

  if (events.length === 0) {
    console.log('[fetch-gotokyo] (none)')
  } else {
    events.forEach((event, index) => {
      console.log(`[fetch-gotokyo] ${index + 1}. ${event.title}`)
      console.log(`[fetch-gotokyo]    ${event.url}`)
    })
  }

  console.log('[fetch-gotokyo] ----------------------------')

  const payload = {
    fetchedAt: new Date().toISOString(),
    sourceUrl: url,
    count: events.length,
    events,
  }
  await writeFile(eventsJsonPath, JSON.stringify(payload, null, 2), 'utf8')
  console.log(
    `[fetch-gotokyo] saved ${path.relative(rootDir, eventsJsonPath)} (gitignored)`,
  )
  console.log('[fetch-gotokyo] done (no AI / no Supabase write)')
}

main().catch((error) => {
  console.error('[fetch-gotokyo] unexpected error:', error)
  process.exit(1)
})
