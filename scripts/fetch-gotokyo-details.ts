/**
 * GO TOKYO イベント詳細ページを少数取得し、AI投入前の生データを作る試作。
 * - 一覧 JSON (tmp/gotokyo-events.json) を入力
 * - 最大3件・直列・リクエスト間隔約1秒
 * - 詳細ページに無い開催期間は、既存一覧 HTML (tmp/gotokyo-latest.html) から spot ID で突合
 * - AI / Supabase 書き込みなし
 */
import { config } from 'dotenv'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cheerio from 'cheerio'
import type { CheerioAPI } from 'cheerio'
import { getGotokyoLimit } from './lib/gotokyo-limit'
import { cleanAddressAccess } from '../src/lib/event-field-rules'
import {
  collectHtmlImageCandidates,
  extractJsonLdImageUrl,
  logEventImageResolve,
  resolveEventImage,
  type EventImageResolveResult,
} from '../src/lib/event-image-rules'
import {
  extractLabeledTimeRawFromText,
  extractTimeFromIsoDateTime,
  logEventTimeParse,
  parseEventTimeText,
  type EventTimeParseResult,
} from '../src/lib/event-time-rules'

config()

const USER_AGENT =
  'SeekigoFetch/0.1 (+https://seekigo.com; single-page research fetch; not a crawler)'

const MAX_DETAILS = getGotokyoLimit()
const REQUEST_GAP_MS = 1000
const SITE_ORIGIN = 'https://www.gotokyo.org'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const tmpDir = path.join(rootDir, 'tmp')
const eventsJsonPath = path.join(tmpDir, 'gotokyo-events.json')
const listingHtmlPath = path.join(tmpDir, 'gotokyo-latest.html')
const detailsJsonPath = path.join(tmpDir, 'gotokyo-event-details.json')

type EventCandidate = {
  title: string
  url: string
}

type EventDetailsFile = {
  fetchedAt?: string
  sourceUrl?: string
  count?: number
  events: EventCandidate[]
}

type FieldSources = Partial<
  Record<
    | 'title'
    | 'description'
    | 'start_date'
    | 'end_date'
    | 'start_time'
    | 'end_time'
    | 'venue'
    | 'address'
    | 'price_text'
    | 'official_url'
    | 'image_url',
    string
  >
>

type GotokyoEventDetail = {
  title: string | null
  description: string | null
  start_date: string | null
  end_date: string | null
  start_time: string | null
  end_time: string | null
  venue: string | null
  address: string | null
  price_text: string | null
  official_url: string | null
  image_url: string | null
  source_url: string
  field_sources: FieldSources
  /** tmp debug: 取得できた時間テキストと判定 */
  time_debug?: {
    raw: string | null
    action: string
    reason: string | null
    source: string | null
  } | null
  /** tmp debug: 画像取得元 */
  image_debug?: {
    source: string | null
    action: string
    reason: string | null
  } | null
  notes: string[]
  error: string | null
}

type ListingDateInfo = {
  start_date: string
  end_date: string
  source: string
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function cleanText(value: string | undefined | null): string | null {
  if (!value) return null
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > 0 ? text : null
}

function stripPostal(address: string): string {
  const stripped = address
    .replace(/^〒?\s*\d{3}-?\d{4}\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleanAddressAccess(stripped) ?? stripped
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

/** YYYY-MM-DD として明確なときだけ返す（年省略は null） */
function parseYmd(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()

  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`

  const jp = trimmed.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$/)
  if (jp) {
    return `${jp[1]}-${jp[2].padStart(2, '0')}-${jp[3].padStart(2, '0')}`
  }

  return null
}

function parseJpDateRange(
  text: string,
): { start_date: string; end_date: string } | null {
  const range = text.match(
    /(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)\s*[〜～\-~－—]\s*(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)/,
  )
  if (!range) return null
  const start_date = parseYmd(range[1].replace(/\s+/g, ''))
  const end_date = parseYmd(range[2].replace(/\s+/g, ''))
  if (!start_date || !end_date) return null
  return { start_date, end_date }
}

function spotIdFromUrl(pageUrl: string): string | null {
  const m = pageUrl.match(/\/spot\/((?:ex|ev)\d+)\//i)
  return m ? m[1].toLowerCase() : null
}

function buildTableMap($: CheerioAPI): Map<string, { text: string; href: string | null }> {
  const map = new Map<string, { text: string; href: string | null }>()
  $('table.datatable tr, table tr').each((_, tr) => {
    const $tr = $(tr)
    const label = cleanText($tr.find('th').first().text())
    if (!label) return
    const $td = $tr.find('td').first()
    const text = cleanText($td.text()) ?? ''
    const href =
      toAbsoluteUrl($td.find('a[href]').first().attr('href'), SITE_ORIGIN) ?? null
    map.set(label, { text, href })
  })
  return map
}

function cellByLabels(
  table: Map<string, { text: string; href: string | null }>,
  labels: string[],
): { text: string; href: string | null; matchedLabel: string } | null {
  for (const label of labels) {
    const hit = table.get(label)
    if (hit && (hit.text || hit.href)) {
      return { ...hit, matchedLabel: label }
    }
  }
  for (const [key, value] of table) {
    if (labels.some((label) => key.includes(label)) && (value.text || value.href)) {
      return { ...value, matchedLabel: key }
    }
  }
  return null
}

function firstWithSource(
  candidates: Array<{ value: string | null | undefined; source: string }>,
): { value: string | null; source: string | null } {
  for (const c of candidates) {
    const value = cleanText(c.value ?? null)
    if (value) return { value, source: c.source }
  }
  return { value: null, source: null }
}

/**
 * 詳細ページ本文から「ラベル + 値」を探す。
 * 更新日は開催日ではないため除外。
 */
function extractLabeledValues($: CheerioAPI): {
  start_date: string | null
  end_date: string | null
  time_raw: string | null
  time_parse: EventTimeParseResult | null
  time_source: string | null
  address: string | null
  sources: FieldSources
  notes: string[]
} {
  const sources: FieldSources = {}
  const notes: string[] = []
  let start_date: string | null = null
  let end_date: string | null = null
  let time_raw: string | null = null
  let time_parse: EventTimeParseResult | null = null
  let time_source: string | null = null
  let address: string | null = null

  const pairs: Array<{ label: string; value: string; where: string }> = []

  $('dt').each((_, dt) => {
    const label = cleanText($(dt).text())
    const value = cleanText($(dt).next('dd').text())
    if (label && value) pairs.push({ label, value, where: 'dt/dd' })
  })

  $('th').each((_, th) => {
    const label = cleanText($(th).text())
    const value = cleanText($(th).closest('tr').find('td').first().text())
    if (label && value) pairs.push({ label, value, where: `table th="${label}"` })
  })

  // 「更新日：YYYY年M月D日」は開催日ではない
  const updateText = cleanText($('.rnavi .day, #tmp_custom_update').text())
  if (updateText && /更新日/.test(updateText)) {
    notes.push(
      `detail page has update date only (${updateText}) — not used as start_date/end_date`,
    )
  }

  const TIME_LABEL =
    /開催時間|開館時間|営業時間|開催時刻|開始時間|開演時間|開場時間|^時間$/

  for (const pair of pairs) {
    const { label, value, where } = pair
    if (/更新日/.test(label)) continue

    if (/開催期間|開催日|期間/.test(label) && !start_date && !end_date) {
      const range = parseJpDateRange(value)
      if (range) {
        start_date = range.start_date
        end_date = range.end_date
        sources.start_date = where
        sources.end_date = where
      } else {
        const single = parseYmd(value)
        if (single) {
          start_date = single
          end_date = single
          sources.start_date = where
          sources.end_date = where
        } else {
          notes.push(`ambiguous date label "${label}": ${value.slice(0, 80)}`)
        }
      }
    }

    if (TIME_LABEL.test(label) && !/料金|金額/.test(label) && !time_raw) {
      time_raw = value
      time_parse = parseEventTimeText(value)
      time_source = where
      if (time_parse.action === 'parsed') {
        if (time_parse.start_time) sources.start_time = where
        if (time_parse.end_time) sources.end_time = where
      } else {
        notes.push(
          `time ${time_parse.action}: ${time_parse.reason} raw="${value.slice(0, 80)}"`,
        )
      }
    }

    if (/住所|所在地/.test(label) && !address) {
      address = stripPostal(value) || null
      if (address) sources.address = where
    }
  }

  // テーブルに無い場合、本文のラベル付き時間を試す
  if (!time_raw) {
    const bodyRaw = extractLabeledTimeRawFromText($.root().text())
    if (bodyRaw) {
      time_raw = bodyRaw
      time_parse = parseEventTimeText(bodyRaw)
      time_source = 'body labeled time'
      if (time_parse.action === 'parsed') {
        if (time_parse.start_time) sources.start_time = time_source
        if (time_parse.end_time) sources.end_time = time_source
      } else {
        notes.push(
          `body time ${time_parse.action}: ${time_parse.reason} raw="${bodyRaw.slice(0, 80)}"`,
        )
      }
    }
  }

  return {
    start_date,
    end_date,
    time_raw,
    time_parse,
    time_source,
    address,
    sources,
    notes,
  }
}

function extractJsonLdFields(
  $: CheerioAPI,
  pageUrl: string,
): { values: Partial<GotokyoEventDetail>; sources: FieldSources } {
  const values: Partial<GotokyoEventDetail> = {}
  const sources: FieldSources = {}

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).html()
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as unknown
      const nodes = Array.isArray(parsed) ? parsed : [parsed]
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue
        const obj = node as Record<string, unknown>
        const type = obj['@type']
        const types = Array.isArray(type) ? type : [type]
        const isEventLike = types.some(
          (t) => typeof t === 'string' && /Event|Exhibition/i.test(t),
        )
        if (!isEventLike && !obj.name && !obj.startDate) continue

        if (typeof obj.name === 'string' && !values.title) {
          values.title = cleanText(obj.name)
          sources.title = 'script[type=application/ld+json].name'
        }
        if (typeof obj.description === 'string' && !values.description) {
          values.description = cleanText(obj.description)
          sources.description = 'script[type=application/ld+json].description'
        }
        if (typeof obj.startDate === 'string' && !values.start_date) {
          const d = obj.startDate.slice(0, 10)
          values.start_date = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null
          values.start_time ??= extractTimeFromIsoDateTime(obj.startDate)
          if (values.start_date) {
            sources.start_date = 'script[type=application/ld+json].startDate'
          }
          if (values.start_time) {
            sources.start_time = 'script[type=application/ld+json].startDate'
          }
        }
        if (typeof obj.endDate === 'string' && !values.end_date) {
          const d = obj.endDate.slice(0, 10)
          values.end_date = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null
          values.end_time ??= extractTimeFromIsoDateTime(obj.endDate)
          if (values.end_date) {
            sources.end_date = 'script[type=application/ld+json].endDate'
          }
          if (values.end_time) {
            sources.end_time = 'script[type=application/ld+json].endDate'
          }
        }
        if (typeof obj.url === 'string' && !values.official_url) {
          values.official_url = toAbsoluteUrl(obj.url, pageUrl)
          sources.official_url = 'script[type=application/ld+json].url'
        }
        if (!values.image_url) {
          const img = extractJsonLdImageUrl(obj.image, pageUrl)
          if (img) {
            values.image_url = img
            sources.image_url = 'script[type=application/ld+json].image'
          }
        }

        const loc = obj.location
        if (loc && typeof loc === 'object') {
          const location = loc as Record<string, unknown>
          if (typeof location.name === 'string' && !values.venue) {
            values.venue = cleanText(location.name)
            sources.venue = 'script[type=application/ld+json].location.name'
          }
          const address = location.address
          if (!values.address) {
            if (typeof address === 'string') {
              values.address = stripPostal(address)
              sources.address = 'script[type=application/ld+json].location.address'
            } else if (address && typeof address === 'object') {
              const addr = address as Record<string, unknown>
              const joined = [addr.streetAddress, addr.addressLocality, addr.addressRegion]
                .filter((v) => typeof v === 'string')
                .join(' ')
              const cleaned = cleanText(joined)
              if (cleaned) {
                values.address = stripPostal(cleaned)
                sources.address =
                  'script[type=application/ld+json].location.address.*'
              }
            }
          }
        }
      }
    } catch {
      // ignore broken JSON-LD
    }
  })

  return { values, sources }
}

/** 一覧 HTML から spot ID → 開催期間を構築 */
function loadListingDateIndex(listingHtml: string): Map<string, ListingDateInfo> {
  const $ = cheerio.load(listingHtml)
  const map = new Map<string, ListingDateInfo>()

  $('.wrap_exhibition').each((_, el) => {
    const $el = $(el)
    const imgSrc = $el.find('.exhibition_img img[src]').first().attr('src') ?? ''
    const idMatch = imgSrc.match(/\/spot\/((?:ex|ev)\d+)\//i)
    if (!idMatch) return
    const spotId = idMatch[1].toLowerCase()

    const paras = $el
      .find('.exhibition_cnt > p')
      .map((__, p) => cleanText($(p).text()))
      .get()
      .filter((v): v is string => Boolean(v))

    // 日付レンジを含む p を探す（施設名や料金と混同しない）
    const dateParas = paras.filter((p) => parseJpDateRange(p))
    if (dateParas.length !== 1) return
    const range = parseJpDateRange(dateParas[0])
    if (!range) return

    map.set(spotId, {
      ...range,
      source: `tmp/gotokyo-latest.html .wrap_exhibition[.exhibition_img img src*="/spot/${spotId}/"] .exhibition_cnt p (date range text)`,
    })
  })

  return map
}

function extractDetailFromHtml(
  html: string,
  pageUrl: string,
  listingDates: Map<string, ListingDateInfo>,
): GotokyoEventDetail {
  const $ = cheerio.load(html)
  const table = buildTableMap($)
  const ld = extractJsonLdFields($, pageUrl)
  const labeled = extractLabeledValues($)
  const notes = [...labeled.notes]
  const field_sources: FieldSources = { ...ld.sources, ...labeled.sources }

  const titleCell = cellByLabels(table, [
    '展覧会名（必須）',
    '展覧会名',
    'イベント名',
    '名称',
  ])
  const officialCell = cellByLabels(table, ['展覧会 リンク先', '公式サイト', 'リンク先'])
  const venueCell = cellByLabels(table, ['施設名', '会場', '開催場所'])
  const priceCell = cellByLabels(table, ['金額', '料金'])
  const descCell = cellByLabels(table, ['一言', '概要', '説明'])

  const title = firstWithSource([
    { value: ld.values.title, source: 'script[type=application/ld+json].name' },
    { value: $('h1').first().text(), source: 'h1' },
    { value: $('.page_ttl').first().text(), source: '.page_ttl' },
    {
      value: titleCell?.text,
      source: titleCell ? `table th="${titleCell.matchedLabel}"` : '',
    },
    {
      value: $('meta[property="og:title"]').attr('content'),
      source: 'meta[property=og:title]',
    },
  ])

  const description = firstWithSource([
    {
      value: ld.values.description,
      source: 'script[type=application/ld+json].description',
    },
    {
      value: descCell?.text,
      source: descCell ? `table th="${descCell.matchedLabel}"` : '',
    },
    {
      value: $('meta[property="og:description"]').attr('content'),
      source: 'meta[property=og:description]',
    },
    {
      value: $('meta[name="description"]').attr('content'),
      source: 'meta[name=description]',
    },
  ])

  const venue = firstWithSource([
    { value: ld.values.venue, source: 'script[type=application/ld+json].location.name' },
    {
      value: venueCell?.text,
      source: venueCell ? `table th="${venueCell.matchedLabel}"` : '',
    },
  ])

  const price = firstWithSource([
    {
      value: priceCell?.text,
      source: priceCell ? `table th="${priceCell.matchedLabel}"` : '',
    },
  ])

  const officialFromAnchor = officialCell?.href ?? null
  const officialFromText = officialCell?.text
    ? toAbsoluteUrl(officialCell.text.split(/\s+/)[0], pageUrl)
    : null
  const official = firstWithSource([
    {
      value: ld.values.official_url,
      source: 'script[type=application/ld+json].url',
    },
    {
      value: officialFromAnchor,
      source: officialCell
        ? `table th="${officialCell.matchedLabel}" a[href]`
        : '',
    },
    {
      value: officialFromText,
      source: officialCell ? `table th="${officialCell.matchedLabel}" text` : '',
    },
  ])

  const ogImage = $('meta[property="og:image"]').attr('content') ?? null
  const twitterImage =
    $('meta[name="twitter:image"]').attr('content') ??
    $('meta[property="twitter:image"]').attr('content') ??
    null

  const htmlCandidates = collectHtmlImageCandidates(
    $('img[src]')
      .toArray()
      .map((el) => {
        const $el = $(el)
        return {
          src: $el.attr('src') ?? null,
          width: $el.attr('width') ?? null,
          height: $el.attr('height') ?? null,
          className: $el.attr('class') ?? null,
          alt: $el.attr('alt') ?? null,
        }
      }),
  )

  // JSON-LD で既に取れていれば優先。サイト共通 ogp は helper 側で除外。
  const imageResolved: EventImageResolveResult = ld.values.image_url
    ? {
        image_url: ld.values.image_url,
        source: 'jsonld',
        source_detail: 'script[type=application/ld+json].image',
        action: 'parsed',
        reason: null,
      }
    : resolveEventImage({
        pageUrl,
        ogImage,
        twitterImage,
        htmlCandidates,
      })

  logEventImageResolve({ title: title.value, result: imageResolved })
  const image_debug = {
    source: imageResolved.source,
    action: imageResolved.action,
    reason: imageResolved.reason,
  }
  if (imageResolved.image_url && imageResolved.source_detail) {
    field_sources.image_url = imageResolved.source_detail
  }

  let start_date = ld.values.start_date ?? labeled.start_date
  let end_date = ld.values.end_date ?? labeled.end_date
  let address = ld.values.address ?? labeled.address

  // 時刻: JSON-LD datetime 優先。無い場合のみテーブル/本文。
  let start_time = ld.values.start_time ?? null
  let end_time = ld.values.end_time ?? null
  let time_debug: GotokyoEventDetail['time_debug'] = null

  if (start_time || end_time) {
    time_debug = {
      raw: null,
      action: 'parsed',
      reason: 'json_ld_datetime',
      source: field_sources.start_time ?? field_sources.end_time ?? null,
    }
    logEventTimeParse({
      title: title.value,
      source: time_debug.source,
      result: {
        start_time,
        end_time,
        action: 'parsed',
        reason: 'json_ld_datetime',
        raw: null,
        ranges_found: start_time && end_time ? 1 : 0,
      },
    })
  } else if (labeled.time_parse) {
    const tp = labeled.time_parse
    time_debug = {
      raw: labeled.time_raw,
      action: tp.action,
      reason: tp.reason,
      source: labeled.time_source,
    }
    if (tp.action === 'parsed') {
      start_time = tp.start_time
      end_time = tp.end_time
      if (tp.start_time && labeled.time_source) {
        field_sources.start_time = labeled.time_source
      }
      if (tp.end_time && labeled.time_source) {
        field_sources.end_time = labeled.time_source
      }
    }
    logEventTimeParse({
      title: title.value,
      source: labeled.time_source,
      result: tp,
    })
  } else {
    time_debug = {
      raw: null,
      action: 'not_found',
      reason: 'no_time_source',
      source: null,
    }
    logEventTimeParse({
      title: title.value,
      result: {
        start_time: null,
        end_time: null,
        action: 'not_found',
        reason: 'no_time_source',
        raw: null,
        ranges_found: 0,
      },
    })
  }

  if (title.source) field_sources.title = title.source
  if (description.source) field_sources.description = description.source
  if (venue.source) field_sources.venue = venue.source
  if (price.source) field_sources.price_text = price.source
  if (official.source) field_sources.official_url = official.source

  // 詳細ページに開催期間が無い場合、一覧 HTML を spot ID で突合
  const spotId = spotIdFromUrl(pageUrl)
  if ((!start_date || !end_date) && spotId) {
    const fromList = listingDates.get(spotId)
    if (fromList) {
      if (!start_date) {
        start_date = fromList.start_date
        field_sources.start_date = fromList.source
      }
      if (!end_date) {
        end_date = fromList.end_date
        field_sources.end_date = fromList.source
      }
      notes.push(
        `start_date/end_date filled from listing HTML via spot id ${spotId}`,
      )
    } else {
      notes.push(
        `no listing date match for spot id ${spotId} (detail page also lacks period fields)`,
      )
    }
  }

  if (!start_date && !end_date) {
    notes.push(
      'start_date/end_date unavailable: no JSON-LD Event, no 開催期間 label, no listing match',
    )
  }
  if (!start_time && !end_time) {
    notes.push('start_time/end_time unavailable on detail/listing HTML')
  }
  if (!address) {
    notes.push('address unavailable on detail/listing HTML')
  }

  // JSON-LD 件数ログ用
  const ldCount = $('script[type="application/ld+json"]').length
  notes.push(`detail json-ld count: ${ldCount}`)

  return {
    title: title.value,
    description: description.value,
    start_date,
    end_date,
    start_time,
    end_time,
    venue: venue.value,
    address,
    price_text: price.value,
    official_url: official.value,
    image_url: imageResolved.image_url,
    source_url: pageUrl,
    field_sources,
    time_debug,
    image_debug,
    notes,
    error: null,
  }
}

function emptyDetail(sourceUrl: string, error: string): GotokyoEventDetail {
  return {
    title: null,
    description: null,
    start_date: null,
    end_date: null,
    start_time: null,
    end_time: null,
    venue: null,
    address: null,
    price_text: null,
    official_url: null,
    image_url: null,
    source_url: sourceUrl,
    field_sources: {},
    time_debug: null,
    image_debug: null,
    notes: [],
    error,
  }
}

function logDetail(index: number, detail: GotokyoEventDetail) {
  console.log(`[fetch-gotokyo-details] ---- ${index + 1} ----`)
  console.log(`[fetch-gotokyo-details] source_url: ${detail.source_url}`)
  if (detail.error) {
    console.log(`[fetch-gotokyo-details] error: ${detail.error}`)
    return
  }
  const fields: Array<keyof FieldSources> = [
    'title',
    'description',
    'venue',
    'price_text',
    'official_url',
    'image_url',
    'start_date',
    'end_date',
    'start_time',
    'end_time',
    'address',
  ]
  for (const key of fields) {
    const value = detail[key]
    const source = detail.field_sources[key] ?? '(not found)'
    const display =
      typeof value === 'string' && value.length > 90
        ? `${value.slice(0, 90)}…`
        : value
    console.log(`[fetch-gotokyo-details] ${key}: ${display ?? 'null'}  <= ${source}`)
  }
  for (const note of detail.notes) {
    console.log(`[fetch-gotokyo-details] note: ${note}`)
  }
}

async function fetchDetailHtml(targetUrl: string): Promise<string> {
  const response = await fetch(targetUrl, {
    method: 'GET',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en;q=0.8',
    },
    redirect: 'follow',
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`)
  }

  return response.text()
}

async function main() {
  console.log('[fetch-gotokyo-details] start')
  console.log(`[fetch-gotokyo-details] user-agent: ${USER_AGENT}`)
  console.log(`[fetch-gotokyo-details] max: ${MAX_DETAILS}`)

  let file: EventDetailsFile
  try {
    const raw = await readFile(eventsJsonPath, 'utf8')
    file = JSON.parse(raw) as EventDetailsFile
  } catch (error) {
    console.error(
      '[fetch-gotokyo-details] failed to read tmp/gotokyo-events.json — run `npm run fetch:gotokyo` first',
      error,
    )
    process.exit(1)
  }

  let listingDates = new Map<string, ListingDateInfo>()
  try {
    const listingHtml = await readFile(listingHtmlPath, 'utf8')
    listingDates = loadListingDateIndex(listingHtml)
    console.log(
      `[fetch-gotokyo-details] listing date index: ${listingDates.size} spot(s) from tmp/gotokyo-latest.html`,
    )
  } catch {
    console.log(
      '[fetch-gotokyo-details] listing HTML not found — date enrichment skipped (run fetch:gotokyo first)',
    )
  }

  const candidates = (file.events ?? []).slice(0, MAX_DETAILS)
  if (candidates.length === 0) {
    console.error('[fetch-gotokyo-details] no events in gotokyo-events.json')
    process.exit(1)
  }

  console.log(`[fetch-gotokyo-details] candidates: ${candidates.length}`)

  const details: GotokyoEventDetail[] = []

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]
    console.log(
      `[fetch-gotokyo-details] fetching (${i + 1}/${candidates.length}): ${candidate.url}`,
    )

    try {
      const html = await fetchDetailHtml(candidate.url)
      console.log(
        `[fetch-gotokyo-details] html received: yes (${html.length} chars)`,
      )
      const detail = extractDetailFromHtml(html, candidate.url, listingDates)
      details.push(detail)
      logDetail(i, detail)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(
        `[fetch-gotokyo-details] error for ${candidate.url}: ${message}`,
      )
      const failed = emptyDetail(candidate.url, message)
      failed.title = candidate.title || null
      if (failed.title) failed.field_sources.title = 'gotokyo-events.json title'
      details.push(failed)
      logDetail(i, failed)
    }

    if (i < candidates.length - 1) {
      console.log(`[fetch-gotokyo-details] waiting ${REQUEST_GAP_MS}ms…`)
      await sleep(REQUEST_GAP_MS)
    }
  }

  await mkdir(tmpDir, { recursive: true })
  const payload = {
    fetchedAt: new Date().toISOString(),
    sourceList: path.relative(rootDir, eventsJsonPath).replace(/\\/g, '/'),
    count: details.length,
    events: details,
  }
  await writeFile(detailsJsonPath, JSON.stringify(payload, null, 2), 'utf8')

  const startCount = details.filter((d) => d.start_time).length
  const endCount = details.filter((d) => d.end_time).length
  const ambiguous = details.filter(
    (d) =>
      d.time_debug?.action === 'keep_null' ||
      (d.notes ?? []).some((n) => /multiple_time|exception_day|ambiguous/.test(n)),
  ).length
  const notFound = details.filter(
    (d) =>
      !d.start_time &&
      !d.end_time &&
      (d.time_debug?.action === 'not_found' || !d.time_debug?.raw),
  ).length
  console.log('[fetch-gotokyo-details] ---- time summary ----')
  console.log(`[fetch-gotokyo-details] total: ${details.length}`)
  console.log(`[fetch-gotokyo-details] start_time: ${startCount}`)
  console.log(`[fetch-gotokyo-details] end_time: ${endCount}`)
  console.log(`[fetch-gotokyo-details] ambiguous: ${ambiguous}`)
  console.log(`[fetch-gotokyo-details] not_found: ${notFound}`)

  const imageCount = details.filter((d) => d.image_url).length
  const bySource = {
    jsonld: details.filter((d) => d.image_debug?.source === 'jsonld').length,
    og: details.filter((d) => d.image_debug?.source === 'og:image').length,
    twitter: details.filter((d) => d.image_debug?.source === 'twitter:image')
      .length,
    html: details.filter((d) => d.image_debug?.source === 'html').length,
    not_found: details.filter((d) => !d.image_url).length,
  }
  console.log('[fetch-gotokyo-details] ---- image summary ----')
  console.log(`[fetch-gotokyo-details] total: ${details.length}`)
  console.log(`[fetch-gotokyo-details] image_url: ${imageCount}`)
  console.log(`[fetch-gotokyo-details] jsonld: ${bySource.jsonld}`)
  console.log(`[fetch-gotokyo-details] og:image: ${bySource.og}`)
  console.log(`[fetch-gotokyo-details] twitter:image: ${bySource.twitter}`)
  console.log(`[fetch-gotokyo-details] html fallback: ${bySource.html}`)
  console.log(`[fetch-gotokyo-details] not_found: ${bySource.not_found}`)

  console.log(
    `[fetch-gotokyo-details] saved ${path.relative(rootDir, detailsJsonPath)} (gitignored)`,
  )
  console.log('[fetch-gotokyo-details] done (no AI / no Supabase write)')
}

main().catch((error) => {
  console.error('[fetch-gotokyo-details] unexpected error:', error)
  process.exit(1)
})
