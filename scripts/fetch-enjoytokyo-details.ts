/**
 * レッツエンジョイ東京 詳細ページを少数取得し、AI投入前の生データを作る試作。
 * - 一覧 JSON (tmp/enjoytokyo-events.json) を入力
 * - 最大3件・直列・リクエスト間隔約1秒
 * - AI / Supabase 書き込みなし
 *
 * 取得優先順位（事実フィールドは AI 補完しない）:
 *   1. JSON-LD Event
 *   2. 詳細ページの基本情報テーブル
 *   3. meta / og（および詳細ページの見出し・リード等）
 *   4. 一覧ページで取得済みの値
 *
 * AI で補完しない: start_date, end_date, start_time, end_time,
 *   venue, address, price_text, official_url, image_url
 */
import { config } from 'dotenv'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cheerio from 'cheerio'
import type { CheerioAPI } from 'cheerio'
import { cleanAddressAccess } from '../src/lib/event-field-rules'
import {
  collectHtmlImageCandidates,
  extractJsonLdImageUrl,
  logEventImageResolve,
  resolveEventImage,
  type EventImageResolveResult,
} from '../src/lib/event-image-rules'
import {
  extractTimeFromIsoDateTime,
  logEventTimeParse,
  parseEventTimeText,
  type EventTimeParseResult,
} from '../src/lib/event-time-rules'

config()

const USER_AGENT =
  'SeekigoFetch/0.1 (+https://seekigo.com; single-page research fetch; not a crawler)'

/** 環境変数 ENJOYTOKYO_DETAILS_LIMIT（1〜10、デフォルト3） */
function getDetailsLimit(): number {
  const raw = process.env.ENJOYTOKYO_DETAILS_LIMIT?.trim()
  if (!raw) return 3
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return 3
  return Math.min(10, Math.floor(n))
}

const MAX_DETAILS = getDetailsLimit()
const REQUEST_GAP_MS = 1000
const SITE_ORIGIN = 'https://www.enjoytokyo.jp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const tmpDir = path.join(rootDir, 'tmp')
const eventsJsonPath = path.join(tmpDir, 'enjoytokyo-events.json')
const detailsJsonPath = path.join(tmpDir, 'enjoytokyo-event-details.json')

type ListingEvent = {
  title: string
  detail_url: string
  start_date: string | null
  end_date: string | null
  venue: string | null
  area: string | null
}

type ListingFile = {
  events?: ListingEvent[]
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
    | 'area'
    | 'address'
    | 'price_text'
    | 'official_url'
    | 'image_url',
    string
  >
>

type EnjoyTokyoDetail = {
  title: string | null
  description: string | null
  start_date: string | null
  end_date: string | null
  start_time: string | null
  end_time: string | null
  venue: string | null
  area: string | null
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function cleanText(value: string | undefined | null): string | null {
  if (!value) return null
  const text = value
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
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

function parseYmd(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()

  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`

  const slash = trimmed.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/)
  if (slash) {
    return `${slash[1]}-${slash[2].padStart(2, '0')}-${slash[3].padStart(2, '0')}`
  }

  const jp = trimmed.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$/)
  if (jp) {
    return `${jp[1]}-${jp[2].padStart(2, '0')}-${jp[3].padStart(2, '0')}`
  }

  return null
}

function parseDateRangeText(raw: string | null): {
  start_date: string | null
  end_date: string | null
} {
  if (!raw) return { start_date: null, end_date: null }
  const text = raw.split('※')[0].replace(/\s+/g, ' ').trim()

  const range = text.match(
    /(\d{4}[/-]\d{1,2}[/-]\d{1,2})(?:\([^)]*\))?\s*[〜～\-–—]\s*(\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}[/-]\d{1,2})(?:\([^)]*\))?/,
  )
  if (range) {
    return {
      start_date: parseYmd(range[1]),
      end_date: parseYmd(range[2]),
    }
  }

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

/**
 * 単一の時間帯／開始・終了ラベルのみ採用。
 * 平日/土日や部ごとの複数パターンは keep_null。
 */
function parseTableTimeText(raw: string | null): EventTimeParseResult {
  return parseEventTimeText(raw)
}

function stripPostal(address: string): string {
  const stripped = address
    .replace(/^〒?\s*\d{3}-?\d{4}\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleanAddressAccess(stripped) ?? stripped
}

function buildInfoTableMap($: CheerioAPI): Map<string, { text: string; href: string | null }> {
  const map = new Map<string, { text: string; href: string | null }>()

  $('#info .table-row, .wysiwyg-teble .table-row').each((_, row) => {
    const $row = $(row)
    const label = cleanText(
      $row.find('.table-cell._head').first().text().replace(/<br\s*\/?>/gi, ''),
    )
    if (!label) return

    const $cell = $row.find('.table-cell').not('._head').first()
    const text = cleanText($cell.text()) ?? ''
    const href =
      toAbsoluteUrl($cell.find('a[href]').first().attr('href'), SITE_ORIGIN) ?? null
    map.set(label.replace(/\s+/g, ''), { text, href })
  })

  return map
}

function tableValue(
  table: Map<string, { text: string; href: string | null }>,
  labels: string[],
): { text: string; href: string | null; matchedLabel: string } | null {
  for (const label of labels) {
    for (const [key, value] of table) {
      if (key.includes(label) && (value.text || value.href)) {
        return { ...value, matchedLabel: key }
      }
    }
  }
  return null
}

/** 優先順位: 1 JSON-LD > 2 基本情報テーブル > 3 meta/og・詳細ページその他 > 4 一覧 */
type PriorityTier = 1 | 2 | 3 | 4

type FieldCandidate = {
  tier: PriorityTier
  value: string | null
  source: string
}

type PickedField = {
  value: string | null
  source: string | null
  tier: PriorityTier | null
}

function pickByPriority(candidates: FieldCandidate[]): PickedField {
  const ordered = [...candidates].sort((a, b) => a.tier - b.tier)
  for (const c of ordered) {
    if (c.value) {
      return { value: c.value, source: c.source, tier: c.tier }
    }
  }
  return { value: null, source: null, tier: null }
}

function normalizeOffers(offers: unknown): Record<string, unknown> | null {
  if (!offers) return null
  if (Array.isArray(offers)) {
    const first = offers.find((o) => o && typeof o === 'object')
    return first && typeof first === 'object'
      ? (first as Record<string, unknown>)
      : null
  }
  if (typeof offers === 'object') return offers as Record<string, unknown>
  return null
}

function formatOffersPrice(offer: Record<string, unknown>): string | null {
  const price = offer.price
  if (price === undefined || price === null || price === '') return null
  const currency =
    typeof offer.priceCurrency === 'string' ? offer.priceCurrency : null
  const priceStr = String(price).trim()
  if (!priceStr) return null
  if (currency === 'JPY' || currency === '¥') {
    if (/^\d+(\.\d+)?$/.test(priceStr)) {
      return `${Number(priceStr).toLocaleString('ja-JP')}円`
    }
    return `${priceStr}円`
  }
  if (currency) return `${priceStr} ${currency}`
  return priceStr
}

type JsonLdExtract = {
  title: string | null
  description: string | null
  start_date: string | null
  end_date: string | null
  start_time: string | null
  end_time: string | null
  venue: string | null
  address: string | null
  image_url: string | null
  price_text: string | null
  official_url: string | null
  event_url: string | null
  sources: FieldSources
  eventCount: number
}

function extractJsonLdEvent($: CheerioAPI, pageUrl: string): JsonLdExtract {
  const result: JsonLdExtract = {
    title: null,
    description: null,
    start_date: null,
    end_date: null,
    start_time: null,
    end_time: null,
    venue: null,
    address: null,
    image_url: null,
    price_text: null,
    official_url: null,
    event_url: null,
    sources: {},
    eventCount: 0,
  }

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
        if (!types.some((t) => t === 'Event')) continue
        result.eventCount += 1

        const src = (path: string) => `json-ld.Event.${path}`

        if (typeof obj.name === 'string' && !result.title) {
          result.title = cleanText(obj.name)
          if (result.title) result.sources.title = src('name')
        }
        if (typeof obj.description === 'string' && !result.description) {
          result.description = cleanText(obj.description)
          if (result.description) result.sources.description = src('description')
        }
        if (typeof obj.startDate === 'string' && !result.start_date) {
          result.start_date = parseYmd(obj.startDate.slice(0, 10))
          if (result.start_date) result.sources.start_date = src('startDate')
          const t = extractTimeFromIsoDateTime(obj.startDate)
          if (t && !result.start_time) {
            result.start_time = t
            result.sources.start_time = src('startDate')
          }
        }
        if (typeof obj.endDate === 'string' && !result.end_date) {
          result.end_date = parseYmd(obj.endDate.slice(0, 10))
          if (result.end_date) result.sources.end_date = src('endDate')
          const t = extractTimeFromIsoDateTime(obj.endDate)
          if (t && !result.end_time) {
            result.end_time = t
            result.sources.end_time = src('endDate')
          }
        }
        if (!result.image_url) {
          const img = extractJsonLdImageUrl(obj.image, pageUrl)
          if (img) {
            result.image_url = img
            result.sources.image_url = src('image')
          }
        }

        if (typeof obj.url === 'string' && !result.event_url) {
          result.event_url = toAbsoluteUrl(obj.url, pageUrl)
        }

        const offer = normalizeOffers(obj.offers)
        if (offer) {
          if (!result.official_url && typeof offer.url === 'string') {
            const offerUrl = toAbsoluteUrl(offer.url, pageUrl)
            if (offerUrl && !offerUrl.includes('enjoytokyo.jp')) {
              result.official_url = offerUrl
              result.sources.official_url = src('offers.url')
            }
          }
          if (!result.price_text) {
            const priced = formatOffersPrice(offer)
            if (priced) {
              result.price_text = priced
              result.sources.price_text = src('offers.price')
            }
          }
        }

        const loc = obj.location
        if (loc && typeof loc === 'object') {
          const location = loc as Record<string, unknown>
          if (typeof location.name === 'string' && !result.venue) {
            result.venue = cleanText(location.name)
            if (result.venue) result.sources.venue = src('location.name')
          }
          const address = location.address
          if (!result.address) {
            if (typeof address === 'string') {
              result.address = stripPostal(address.split(/■|\r?\n/)[0] || address)
              if (result.address) {
                result.sources.address = src('location.address')
              }
            } else if (address && typeof address === 'object') {
              const addr = address as Record<string, unknown>
              if (typeof addr.streetAddress === 'string') {
                const firstLine = addr.streetAddress
                  .split(/\r?\n|■/)[0]
                  .replace(/\s+/g, ' ')
                  .trim()
                const cleaned = stripPostal(firstLine)
                if (/[都道府県]/.test(cleaned) || /\d/.test(cleaned)) {
                  result.address = cleaned || null
                  if (result.address) {
                    result.sources.address = src('location.address.streetAddress')
                  }
                }
              }
            }
          }
        }
      }
    } catch {
      // ignore broken JSON-LD
    }
  })

  return result
}

function extractAddressFromTable(
  $: CheerioAPI,
  addressCell: { text: string; matchedLabel: string } | null,
): { value: string | null; source: string | null } {
  if (!addressCell?.text) return { value: null, source: null }

  const $addrCell = $('#info .table-row, .wysiwyg-teble .table-row')
    .filter((_, row) => {
      const label = cleanText($(row).find('.table-cell._head').first().text())
      return Boolean(label && /所在地|住所/.test(label.replace(/\s+/g, '')))
    })
    .first()
    .find('.table-cell')
    .not('._head')
    .first()

  $addrCell.find('a').remove()
  const lines = ($addrCell.text() || '')
    .split(/\n/)
    .map((l) => cleanText(l))
    .filter((l): l is string => Boolean(l))
    .filter((l) => !/^MAP$/i.test(l) && !/^〒/.test(l))
  const addrLine =
    lines.find((l) => /[都道府県]/.test(l) || /\d/.test(l)) ?? lines[0] ?? null
  if (!addrLine) return { value: null, source: null }

  const value = stripPostal(addrLine.replace(/\s*MAP\s*$/i, '').trim())
  return {
    value,
    source: value ? `table "${addressCell.matchedLabel}"` : null,
  }
}

function extractOfficialFromTable(
  officialCell: { text: string; href: string | null; matchedLabel: string } | null,
  pageUrl: string,
): { value: string | null; source: string | null } {
  if (!officialCell) return { value: null, source: null }
  if (officialCell.href && !officialCell.href.includes('enjoytokyo.jp')) {
    return {
      value: officialCell.href,
      source: `table "${officialCell.matchedLabel}" a[href]`,
    }
  }
  if (officialCell.text) {
    const maybe = toAbsoluteUrl(officialCell.text.split(/\s+/)[0], pageUrl)
    if (maybe && !maybe.includes('enjoytokyo.jp')) {
      return {
        value: maybe,
        source: `table "${officialCell.matchedLabel}" text`,
      }
    }
  }
  return { value: null, source: null }
}

function logListingDiffs(
  notes: string[],
  listing: ListingEvent,
  picked: {
    title: PickedField
    start_date: PickedField
    end_date: PickedField
    venue: PickedField
    area: PickedField
  },
) {
  const checks: Array<{
    key: string
    listingValue: string | null
    picked: PickedField
  }> = [
    { key: 'title', listingValue: listing.title, picked: picked.title },
    {
      key: 'start_date',
      listingValue: listing.start_date,
      picked: picked.start_date,
    },
    { key: 'end_date', listingValue: listing.end_date, picked: picked.end_date },
    { key: 'venue', listingValue: listing.venue, picked: picked.venue },
    { key: 'area', listingValue: listing.area, picked: picked.area },
  ]

  for (const { key, listingValue, picked: p } of checks) {
    if (!listingValue || !p.value) continue
    if (listingValue === p.value) continue
    // 詳細側（tier 1–3）を採用した場合のみ差分ログ
    if (p.tier === null || p.tier === 4) continue
    notes.push(
      `diff ${key}: listing="${listingValue}" -> detail="${p.value}" (${p.source})`,
    )
  }
}

function extractDetail(
  html: string,
  pageUrl: string,
  listing: ListingEvent,
): EnjoyTokyoDetail {
  const $ = cheerio.load(html)
  const notes: string[] = []
  const table = buildInfoTableMap($)
  const ld = extractJsonLdEvent($, pageUrl)
  const field_sources: FieldSources = {}

  const periodCell = tableValue(table, ['開催期間'])
  const timeCell = tableValue(table, [
    '時間',
    '開催時間',
    '開場時間',
    '開館時間',
    '営業時間',
    '開催時刻',
    '開始時間',
    '開演時間',
  ])
  const venueCell = tableValue(table, ['会場'])
  const placeCell = tableValue(table, ['開催場所'])
  const addressCell = tableValue(table, ['所在地', '住所'])
  const priceCell = tableValue(table, ['料金', '費用'])
  const officialCell = tableValue(table, ['公式サイト', '公式'])

  const headerDate = cleanText($('.event-info-list li._date span').first().text())
  const headerVenue = cleanText($('.event-info-list li._spot span').first().text())
  const headerArea = cleanText($('.event-info-list ._area-name span').last().text())
  const h1Title = cleanText($('h1.event-header-title, h1').first().text())
  const descriptionLead = cleanText($('.event-lead p').first().text())

  const ogTitle = cleanText(
    $('meta[property="og:title"]').attr('content')?.replace(/｜.*$/, ''),
  )
  const ogDescRaw = cleanText($('meta[property="og:description"]').attr('content'))
  const ogDesc =
    ogDescRaw && !/開催日時、所在地、地図/.test(ogDescRaw) ? ogDescRaw : null
  const ogImageRaw = $('meta[property="og:image"]').attr('content') ?? null
  const twitterImageRaw =
    $('meta[name="twitter:image"]').attr('content') ??
    $('meta[property="twitter:image"]').attr('content') ??
    null

  const periodFromTable = parseDateRangeText(periodCell?.text ?? null)
  const periodFromHeader = parseDateRangeText(headerDate)
  const timeFromTable = parseTableTimeText(timeCell?.text ?? null)
  if (timeFromTable.action !== 'parsed' && timeFromTable.raw) {
    notes.push(
      `time ${timeFromTable.action}: ${timeFromTable.reason} raw="${timeFromTable.raw.slice(0, 80)}"`,
    )
  }

  const tableAddress = extractAddressFromTable($, addressCell)
  const tableOfficial = extractOfficialFromTable(officialCell, pageUrl)
  const tablePrice = cleanText(priceCell?.text ?? null)
  const tableVenue =
    cleanText(venueCell?.text ?? null) ??
    cleanText(placeCell?.text?.split(/\n|\//)[0] ?? null)
  const tableVenueSource = venueCell
    ? `table "${venueCell.matchedLabel}"`
    : placeCell
      ? `table "${placeCell.matchedLabel}"`
      : 'table venue'

  // --- 優先順位どおりに選定（事実フィールドは AI 補完しない） ---
  const title = pickByPriority([
    { tier: 1, value: ld.title, source: ld.sources.title ?? 'json-ld.Event.name' },
    { tier: 3, value: h1Title, source: 'h1.event-header-title' },
    { tier: 3, value: ogTitle, source: 'meta[property=og:title]' },
    { tier: 4, value: listing.title, source: 'listing title' },
  ])

  const description = pickByPriority([
    {
      tier: 1,
      value: ld.description,
      source: ld.sources.description ?? 'json-ld.Event.description',
    },
    { tier: 3, value: descriptionLead, source: '.event-lead p' },
    { tier: 3, value: ogDesc, source: 'meta[property=og:description]' },
  ])

  const start_date = pickByPriority([
    {
      tier: 1,
      value: ld.start_date,
      source: ld.sources.start_date ?? 'json-ld.Event.startDate',
    },
    {
      tier: 2,
      value: periodFromTable.start_date,
      source: `table "${periodCell?.matchedLabel ?? '開催期間'}"`,
    },
    {
      tier: 3,
      value: periodFromHeader.start_date,
      source: '.event-info-list li._date',
    },
    { tier: 4, value: listing.start_date, source: 'listing start_date' },
  ])

  const end_date = pickByPriority([
    {
      tier: 1,
      value: ld.end_date,
      source: ld.sources.end_date ?? 'json-ld.Event.endDate',
    },
    {
      tier: 2,
      value: periodFromTable.end_date,
      source: `table "${periodCell?.matchedLabel ?? '開催期間'}"`,
    },
    {
      tier: 3,
      value: periodFromHeader.end_date,
      source: '.event-info-list li._date',
    },
    { tier: 4, value: listing.end_date, source: 'listing end_date' },
  ])

  // 時刻: JSON-LD datetime 優先。無い場合のみテーブル。
  let start_time: PickedField = { value: null, source: null, tier: null }
  let end_time: PickedField = { value: null, source: null, tier: null }
  let time_debug: EnjoyTokyoDetail['time_debug'] = null

  if (ld.start_time || ld.end_time) {
    start_time = {
      value: ld.start_time,
      source: ld.sources.start_time ?? 'json-ld.Event.startDate',
      tier: 1,
    }
    end_time = {
      value: ld.end_time,
      source: ld.sources.end_time ?? 'json-ld.Event.endDate',
      tier: 1,
    }
    time_debug = {
      raw: null,
      action: 'parsed',
      reason: 'json_ld_datetime',
      source: start_time.source ?? end_time.source,
    }
    logEventTimeParse({
      title: title.value,
      source: time_debug.source,
      result: {
        start_time: ld.start_time,
        end_time: ld.end_time,
        action: 'parsed',
        reason: 'json_ld_datetime',
        raw: null,
        ranges_found: ld.start_time && ld.end_time ? 1 : 0,
      },
    })
  } else {
    const tableSource = `table "${timeCell?.matchedLabel ?? '時間'}"`
    time_debug = {
      raw: timeFromTable.raw,
      action: timeFromTable.action,
      reason: timeFromTable.reason,
      source: timeCell ? tableSource : null,
    }
    if (timeFromTable.action === 'parsed') {
      start_time = {
        value: timeFromTable.start_time,
        source: tableSource,
        tier: 2,
      }
      end_time = {
        value: timeFromTable.end_time,
        source: timeFromTable.end_time ? tableSource : null,
        tier: 2,
      }
    }
    logEventTimeParse({
      title: title.value,
      source: timeCell ? tableSource : null,
      result: timeFromTable,
    })
  }

  const venue = pickByPriority([
    {
      tier: 1,
      value: ld.venue,
      source: ld.sources.venue ?? 'json-ld.Event.location.name',
    },
    { tier: 2, value: tableVenue, source: tableVenueSource },
    { tier: 3, value: headerVenue, source: '.event-info-list li._spot' },
    { tier: 4, value: listing.venue, source: 'listing venue' },
  ])

  const area = pickByPriority([
    { tier: 3, value: headerArea, source: '.event-info-list ._area-name span' },
    { tier: 4, value: listing.area, source: 'listing area' },
  ])

  const address = pickByPriority([
    {
      tier: 1,
      value: ld.address,
      source: ld.sources.address ?? 'json-ld.Event.location.address',
    },
    {
      tier: 2,
      value: tableAddress.value,
      source: tableAddress.source ?? 'table address',
    },
  ])

  const price_text = pickByPriority([
    {
      tier: 1,
      value: ld.price_text,
      source: ld.sources.price_text ?? 'json-ld.Event.offers.price',
    },
    {
      tier: 2,
      value: tablePrice,
      source: priceCell ? `table "${priceCell.matchedLabel}"` : 'table price',
    },
  ])

  // JSON-LD: offers.url → Event.url（外部のみ） → テーブル公式
  const ldEventUrlExternal =
    ld.event_url && !ld.event_url.includes('enjoytokyo.jp') ? ld.event_url : null
  const official_url = pickByPriority([
    {
      tier: 1,
      value: ld.official_url,
      source: ld.sources.official_url ?? 'json-ld.Event.offers.url',
    },
    {
      tier: 1,
      value: ldEventUrlExternal,
      source: 'json-ld.Event.url',
    },
    {
      tier: 2,
      value: tableOfficial.value,
      source: tableOfficial.source ?? 'table official',
    },
  ])

  // 画像: JSON-LD → og → twitter → HTML（共通 helper）
  const htmlCandidates = collectHtmlImageCandidates(
    $('img[src]')
      .toArray()
      .map((el) => {
        const $el = $(el)
        return {
          src: $el.attr('src') ?? $el.attr('data-src') ?? null,
          width: $el.attr('width') ?? null,
          height: $el.attr('height') ?? null,
          className: $el.attr('class') ?? null,
          alt: $el.attr('alt') ?? null,
        }
      }),
  )

  const imageResolved: EventImageResolveResult = ld.image_url
    ? {
        image_url: ld.image_url,
        source: 'jsonld',
        source_detail: ld.sources.image_url ?? 'json-ld.Event.image',
        action: 'parsed',
        reason: null,
      }
    : resolveEventImage({
        pageUrl,
        ogImage: ogImageRaw,
        twitterImage: twitterImageRaw,
        htmlCandidates,
      })

  logEventImageResolve({ title: title.value, result: imageResolved })
  const image_debug = {
    source: imageResolved.source,
    action: imageResolved.action,
    reason: imageResolved.reason,
  }
  const image_url: PickedField = {
    value: imageResolved.image_url,
    source: imageResolved.source_detail,
    tier:
      imageResolved.source === 'jsonld'
        ? 1
        : imageResolved.source === 'og:image' ||
            imageResolved.source === 'twitter:image'
          ? 3
          : imageResolved.source === 'html'
            ? 3
            : null,
  }

  const picked = {
    title,
    description,
    start_date,
    end_date,
    start_time,
    end_time,
    venue,
    area,
    address,
    price_text,
    official_url,
    image_url,
  }

  for (const [key, field] of Object.entries(picked) as Array<
    [keyof FieldSources, PickedField]
  >) {
    if (field.source) field_sources[key] = field.source
  }

  logListingDiffs(notes, listing, {
    title,
    start_date,
    end_date,
    venue,
    area,
  })

  notes.push(`priority: 1=json-ld 2=table 3=meta/page 4=listing`)
  notes.push(`detail json-ld Event count: ${ld.eventCount}`)

  return {
    title: title.value,
    description: description.value,
    start_date: start_date.value,
    end_date: end_date.value,
    start_time: start_time.value,
    end_time: end_time.value,
    venue: venue.value,
    area: area.value,
    address: address.value,
    price_text: price_text.value,
    official_url: official_url.value,
    image_url: image_url.value,
    source_url: pageUrl,
    field_sources,
    time_debug,
    image_debug,
    notes,
    error: null,
  }
}

function emptyDetail(sourceUrl: string, error: string): EnjoyTokyoDetail {
  return {
    title: null,
    description: null,
    start_date: null,
    end_date: null,
    start_time: null,
    end_time: null,
    venue: null,
    area: null,
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

function logDetail(index: number, detail: EnjoyTokyoDetail) {
  console.log(`[fetch-enjoytokyo-details] ---- ${index + 1} ----`)
  console.log(`[fetch-enjoytokyo-details] source_url: ${detail.source_url}`)
  if (detail.error) {
    console.log(`[fetch-enjoytokyo-details] error: ${detail.error}`)
    return
  }

  const fields: Array<keyof FieldSources> = [
    'title',
    'description',
    'start_date',
    'end_date',
    'start_time',
    'end_time',
    'venue',
    'area',
    'address',
    'price_text',
    'official_url',
    'image_url',
  ]

  for (const key of fields) {
    const value = detail[key]
    const source = detail.field_sources[key] ?? '(not found)'
    const display =
      typeof value === 'string' && value.length > 100
        ? `${value.slice(0, 100)}…`
        : value
    console.log(
      `[fetch-enjoytokyo-details] ${key}: ${display ?? 'null'}  <= ${source}`,
    )
  }

  for (const note of detail.notes) {
    console.log(`[fetch-enjoytokyo-details] note: ${note}`)
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
  console.log('[fetch-enjoytokyo-details] start')
  console.log(`[fetch-enjoytokyo-details] user-agent: ${USER_AGENT}`)
  console.log(`[fetch-enjoytokyo-details] max: ${MAX_DETAILS}`)

  let file: ListingFile
  try {
    const raw = await readFile(eventsJsonPath, 'utf8')
    file = JSON.parse(raw) as ListingFile
  } catch (error) {
    console.error(
      '[fetch-enjoytokyo-details] failed to read tmp/enjoytokyo-events.json — run `npm run fetch:enjoytokyo` first',
      error,
    )
    process.exit(1)
  }

  const candidates = (file.events ?? []).slice(0, MAX_DETAILS)
  if (candidates.length === 0) {
    console.error('[fetch-enjoytokyo-details] no events in enjoytokyo-events.json')
    process.exit(1)
  }

  console.log(`[fetch-enjoytokyo-details] candidates: ${candidates.length}`)

  const details: EnjoyTokyoDetail[] = []

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]
    console.log(
      `[fetch-enjoytokyo-details] fetching (${i + 1}/${candidates.length}): ${candidate.detail_url}`,
    )

    try {
      const html = await fetchDetailHtml(candidate.detail_url)
      console.log(
        `[fetch-enjoytokyo-details] html received: yes (${html.length} chars)`,
      )
      const detail = extractDetail(html, candidate.detail_url, candidate)
      details.push(detail)
      logDetail(i, detail)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(
        `[fetch-enjoytokyo-details] error for ${candidate.detail_url}: ${message}`,
      )
      const failed = emptyDetail(candidate.detail_url, message)
      failed.title = candidate.title
      failed.field_sources.title = 'listing title'
      details.push(failed)
      logDetail(i, failed)
    }

    if (i < candidates.length - 1) {
      console.log(`[fetch-enjoytokyo-details] waiting ${REQUEST_GAP_MS}ms…`)
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
  const ambiguous = details.filter((d) => d.time_debug?.action === 'keep_null')
    .length
  const notFound = details.filter(
    (d) =>
      !d.start_time &&
      !d.end_time &&
      (d.time_debug?.action === 'not_found' || !d.time_debug),
  ).length
  console.log('[fetch-enjoytokyo-details] ---- time summary ----')
  console.log(`[fetch-enjoytokyo-details] total: ${details.length}`)
  console.log(`[fetch-enjoytokyo-details] start_time: ${startCount}`)
  console.log(`[fetch-enjoytokyo-details] end_time: ${endCount}`)
  console.log(`[fetch-enjoytokyo-details] ambiguous: ${ambiguous}`)
  console.log(`[fetch-enjoytokyo-details] not_found: ${notFound}`)

  const imageCount = details.filter((d) => d.image_url).length
  const bySource = {
    jsonld: details.filter((d) => d.image_debug?.source === 'jsonld').length,
    og: details.filter((d) => d.image_debug?.source === 'og:image').length,
    twitter: details.filter((d) => d.image_debug?.source === 'twitter:image')
      .length,
    html: details.filter((d) => d.image_debug?.source === 'html').length,
    not_found: details.filter((d) => !d.image_url).length,
  }
  console.log('[fetch-enjoytokyo-details] ---- image summary ----')
  console.log(`[fetch-enjoytokyo-details] total: ${details.length}`)
  console.log(`[fetch-enjoytokyo-details] image_url: ${imageCount}`)
  console.log(`[fetch-enjoytokyo-details] jsonld: ${bySource.jsonld}`)
  console.log(`[fetch-enjoytokyo-details] og:image: ${bySource.og}`)
  console.log(`[fetch-enjoytokyo-details] twitter:image: ${bySource.twitter}`)
  console.log(`[fetch-enjoytokyo-details] html fallback: ${bySource.html}`)
  console.log(`[fetch-enjoytokyo-details] not_found: ${bySource.not_found}`)

  console.log(
    `[fetch-enjoytokyo-details] saved ${path.relative(rootDir, detailsJsonPath)} (gitignored)`,
  )
  console.log('[fetch-enjoytokyo-details] done (no AI / no Supabase write)')
}

main().catch((error) => {
  console.error('[fetch-enjoytokyo-details] unexpected error:', error)
  process.exit(1)
})
