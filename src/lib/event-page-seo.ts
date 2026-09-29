/**
 * イベント詳細の description / OGP URL / Event JSON-LD。
 * 概要の翻訳や、料金文字列からの金額推定はしない。
 */
import type { DateSpan, OccurrenceDateRow } from './event-schedule'
import { resolveDisplaySpans } from './event-schedule'

const SITE_ORIGIN = 'https://seekigo.com'
const DESCRIPTION_MAX = 160
const DESCRIPTION_BREAK_MIN = 120

export function absoluteSiteUrl(
  pathOrUrl: string,
  site?: URL | string | null,
): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl
  const base = site ? new URL(site) : new URL(SITE_ORIGIN)
  return new URL(pathOrUrl, base).href
}

/** 160字以内。120字以降の文末で切れるときはそこで切る。 */
export function clampMetaDescription(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= DESCRIPTION_MAX) return clean
  const window = clean.slice(0, DESCRIPTION_MAX)
  let cut = -1
  for (const mark of ['。', '．', '.', '！', '!', '？', '?']) {
    cut = Math.max(cut, window.lastIndexOf(mark))
  }
  if (cut >= DESCRIPTION_BREAK_MIN) return window.slice(0, cut + 1).trim()
  return window.trimEnd()
}

export function buildJaEventDescription(input: {
  title?: string | null
  summary?: string | null
  place?: string | null
  dateLabel?: string | null
}): string {
  const summary = input.summary?.replace(/\s+/g, ' ').trim()
  if (summary) return clampMetaDescription(summary)

  const sentences: string[] = []
  const title = input.title?.trim()
  if (title) sentences.push(`${title}の開催情報。`)
  const place = input.place?.trim()
  if (place) sentences.push(`場所は${place}。`)
  const dates = input.dateLabel?.trim()
  if (dates) sentences.push(`開催日は${dates}。`)
  if (sentences.length === 0) return '東京のイベント・お出かけ情報はSeekigo。'
  return clampMetaDescription(sentences.join(''))
}

export function buildEnEventDescription(input: {
  title?: string | null
  summaryEn?: string | null
}): string {
  const summary = input.summaryEn?.replace(/\s+/g, ' ').trim()
  if (summary) return clampMetaDescription(summary)
  const title = input.title?.trim() || 'this event'
  return clampMetaDescription(
    `Event information for ${title} in Tokyo on Seekigo.`,
  )
}

type OfferJson =
  | {
      '@type': 'Offer'
      price: string
      priceCurrency: 'JPY'
      url?: string
    }
  | {
      '@type': 'AggregateOffer'
      lowPrice: string
      highPrice: string
      priceCurrency: 'JPY'
      url?: string
    }

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** price_type と price_min / price_max だけ。price_text は解析しない。 */
export function structuredEventOffers(input: {
  priceType?: string | null
  priceMin?: number | null
  priceMax?: number | null
  url?: string | null
}): OfferJson | null {
  const url = input.url?.trim() || undefined
  if (input.priceType === 'free') {
    return { '@type': 'Offer', price: '0', priceCurrency: 'JPY', url }
  }
  if (input.priceType !== 'paid') return null
  const min = finiteNumber(input.priceMin)
  const max = finiteNumber(input.priceMax)
  if (min != null && max != null && min !== max) {
    return {
      '@type': 'AggregateOffer',
      lowPrice: String(min),
      highPrice: String(max),
      priceCurrency: 'JPY',
      url,
    }
  }
  if (min != null && (max == null || max === min)) {
    return { '@type': 'Offer', price: String(min), priceCurrency: 'JPY', url }
  }
  return null
}

export type EventJsonLdInput = {
  name: string
  description?: string | null
  url: string
  image?: string | null
  venue?: string | null
  address?: string | null
  occurrenceSpans: DateSpan[]
  parent: { start_date?: string | null; end_date?: string | null }
  /** 親の日付だけを使うときだけ時刻を付ける。開催回の時刻が空ならコピーしない。 */
  parentStartTime?: string | null
  parentEndTime?: string | null
  /** 開催回。どれかに時刻があるときだけ、行ごとの Event にする。 */
  occurrences?: OccurrenceDateRow[] | null
  priceType?: string | null
  priceMin?: number | null
  priceMax?: number | null
  officialUrl?: string | null
}

function dateWithTime(ymd: string, time: string | null | undefined): string {
  const match = time?.trim().match(/^(\d{1,2}):(\d{2})/)
  if (!match) return ymd
  const hour = Number(match[1])
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return ymd
  return `${ymd}T${String(hour).padStart(2, '0')}:${match[2]}:00+09:00`
}

function timedOccurrenceNodes(
  rows: OccurrenceDateRow[],
): Array<{ startDate: string; endDate: string }> | null {
  const nodes: Array<{ startDate: string; endDate: string }> = []
  let anyClock = false
  for (const row of rows) {
    const start = row.start_date?.trim() ?? ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) continue
    const endRaw = row.end_date?.trim() || start
    const end = /^\d{4}-\d{2}-\d{2}$/.test(endRaw) && endRaw >= start ? endRaw : start
    const startTime = row.start_time?.trim() || null
    const endTime = row.end_time?.trim() || null
    if (startTime || endTime) anyClock = true
    nodes.push({
      startDate: dateWithTime(start, startTime),
      endDate: dateWithTime(end, endTime),
    })
  }
  if (!anyClock || nodes.length === 0) return null
  return nodes
}

export function buildEventJsonLd(input: EventJsonLdInput): string | null {
  const name = input.name.trim()
  if (!name || !input.url.trim()) return null

  const sessionNodes = timedOccurrenceNodes(input.occurrences ?? [])
  const spans = resolveDisplaySpans(input.occurrenceSpans, input.parent)
  if (!sessionNodes && spans.length === 0) return null

  const usingOccurrences = input.occurrenceSpans.length > 0
  const locationName = input.venue?.trim() || ''
  const address = input.address?.trim() || ''
  const location =
    locationName || address
      ? {
          '@type': 'Place' as const,
          ...(locationName ? { name: locationName } : {}),
          ...(address
            ? {
                address: {
                  '@type': 'PostalAddress' as const,
                  streetAddress: address,
                },
              }
            : {}),
        }
      : undefined

  const offerUrl = input.officialUrl?.trim() || input.url
  const offers = structuredEventOffers({
    priceType: input.priceType,
    priceMin: input.priceMin,
    priceMax: input.priceMax,
    url: offerUrl,
  })
  const description = input.description?.trim() || undefined
  const image = input.image?.trim() || undefined

  const events = (sessionNodes ?? spans.map((span) => ({
    startDate: usingOccurrences
      ? span.start
      : dateWithTime(span.start, input.parentStartTime),
    endDate: usingOccurrences
      ? span.end
      : dateWithTime(span.end, input.parentEndTime),
  }))).map((span) => {
    const node: Record<string, unknown> = {
      '@type': 'Event',
      name,
      url: input.url,
      startDate: span.startDate,
      endDate: span.endDate,
    }
    if (description) node.description = description
    if (image) node.image = image
    if (location) node.location = location
    if (offers) node.offers = offers
    return node
  })

  const payload =
    events.length === 1
      ? { '@context': 'https://schema.org', ...events[0] }
      : { '@context': 'https://schema.org', '@graph': events }

  return JSON.stringify(payload).replace(/</g, '\\u003c')
}
