/**
 * Walkerplus Phase 0.5 — 詳細ページ抽出（調査用のみ）
 */
import * as cheerio from 'cheerio'
import type { CheerioAPI } from 'cheerio'
import {
  extractJsonLdImageUrl,
  normalizeImageUrl,
  pickMetaEventImage,
} from '../../src/lib/event-image-rules'
import {
  extractLabeledTimeRawFromText,
  parseEventTimeText,
} from '../../src/lib/event-time-rules'
import type { WalkerplusListEvent } from './walkerplus-parse'
import {
  cleanText,
  extractWalkerplusEventId,
  parseWalkerplusDateText,
  toAbsoluteUrl,
} from './walkerplus-parse'

export type WalkerplusEventDetail = {
  source_name: 'walkerplus'
  source_event_id: string | null
  title: string | null
  start_date: string | null
  end_date: string | null
  start_time: string | null
  end_time: string | null
  venue: string | null
  address: string | null
  area_locality: string | null
  price_text: string | null
  official_url: string | null
  description: string | null
  image_url: string | null
  image_credit: string | null
  categories: string[]
  source_url: string
  field_sources: Record<string, string>
  list_snapshot?: WalkerplusListEvent
}

const PRICE_LABEL_RE = /^(料金|入場料|入場|チケット|観覧料|参加費|利用料|一般|大人|学生|高校生|中学生|小人|シニア)/
const PRICE_VALUE_RE =
  /(\d{1,3}(?:,\d{3})*\s*円|無料|入場無料|有料|¥\s*\d|各\d|要問合せ|要予約)/

const CATEGORY_BLOCKLIST = new Set([
  '関東',
  '東京都',
  'イベント',
  '関東のイベント',
  '東京都のイベント',
  '全件',
  '今日',
  '明日',
  '今週末',
  'イベント一覧',
  '条件',
  '施設条件',
  'タグ',
  '恋人・夫婦で',
  '食べる',
  '遊ぶ',
  '観る・学ぶ',
  '午前中',
  'お昼',
  '夕方・夜',
  '31',
  '9月',
  '10月',
  '11月',
  '8月すべてのイベント',
  '花イベント',
  'その他',
  'その他のイベント',
  '無料イベント',
  '終了間際',
  'アミューズメント施設',
  'ショッピング施設',
  '千代田区',
  '中央区',
  '港区',
  '新宿区',
  '文京区',
  '台東区',
  '墨田区',
  '江東区',
  '品川区',
  '目黒区',
  '大田区',
  '世田谷区',
  '渋谷区',
  '中野区',
  '杉並区',
  '豊島区',
  '北区',
  '荒川区',
  '板橋区',
  '練馬区',
  '足立区',
  '葛飾区',
  '江戸川区',
  '八王子市',
  '立川市',
  '武蔵野市',
  '町田市',
  '多摩市',
])

const KNOWN_EVENT_CATEGORIES = new Set([
  '祭り',
  'フェスティバル・パレード',
  '美術展・博物展',
  '商業施設のイベント',
  '商業施設イベント',
  'アニメ・ゲーム',
  '体験イベント・アクティビティ',
  '体験イベント',
  'グルメ・フードフェス',
  '物産展・観光フェア',
  'ライブ・音楽イベント',
  '映画イベント',
  'スポーツイベント',
  '展示会',
  'ライトアップ',
  '花見',
  '花火',
  '紅葉',
  'イルミネーション',
  'クリスマスイベント',
  '動物関連イベント',
  '講演会・トークショー',
  '伝統芸能・お笑いライブ',
  '趣味・生活',
  '花・自然',
  '年中行事・歳時記',
  'バーゲンセール',
  'フリーマーケット',
  '福袋・初売り',
  'カウントダウン',
  '味覚狩り・フルーツ狩り',
])

const IMAGE_CREDIT_REJECT_RE =
  /天気|ウェザー|Walkerplus|ウォーカー|無断転載|掲載情報は|自然災害|消費税/

export function parseJsonLdBlocks(html: string): unknown[] {
  const $ = cheerio.load(html)
  const blocks: unknown[] = []
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).html()
    if (!raw) return
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) blocks.push(...parsed)
      else blocks.push(parsed)
    } catch {
      // ignore
    }
  })
  return blocks
}

export function flattenJsonLd(nodes: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue
    const obj = node as Record<string, unknown>
    if (Array.isArray(obj['@graph'])) {
      for (const g of obj['@graph'] as unknown[]) {
        if (g && typeof g === 'object') out.push(g as Record<string, unknown>)
      }
    } else {
      out.push(obj)
    }
  }
  return out
}

export function pickEventJsonLd(
  nodes: Record<string, unknown>[],
): Record<string, unknown> | null {
  for (const node of nodes) {
    const type = node['@type']
    if (type === 'Event' || (Array.isArray(type) && type.includes('Event'))) {
      return node
    }
  }
  return null
}

function isoDatePart(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const m = value.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

function isoTimePart(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const m = value.match(/T(\d{2}:\d{2})/)
  return m ? m[1] : null
}

function isPlausiblePriceText(value: string | null): value is string {
  if (!value) return false
  const text = value.trim()
  if (text.length < 2 || text.length > 180) return false
  if (!PRICE_VALUE_RE.test(text)) return false
  if (/巨大LED|体験型|開催中|東京都|提供元|情報提供/.test(text)) return false
  return true
}

function formatJsonLdOfferPrice(offers: unknown): string | null {
  if (!offers) return null
  const list = Array.isArray(offers) ? offers : [offers]
  const parts: string[] = []

  for (const offer of list) {
    if (!offer || typeof offer !== 'object') continue
    const o = offer as Record<string, unknown>
    const rawPrice = o.price ?? o.lowPrice ?? o.highPrice
    const currency = typeof o.priceCurrency === 'string' ? o.priceCurrency : 'JPY'
    const name = typeof o.name === 'string' ? cleanText(o.name) : null

    if (typeof rawPrice === 'number' && rawPrice > 0) {
      const label = name ? `${name}: ` : ''
      parts.push(`${label}${rawPrice}${currency === 'JPY' ? '円' : ` ${currency}`}`)
      continue
    }

    if (typeof rawPrice === 'string') {
      const p = rawPrice.trim()
      if (!p || /^none$/i.test(p) || p === '0') continue
      if (/^\d+(\.\d+)?$/.test(p)) {
        parts.push(`${name ? `${name}: ` : ''}${p}円`)
      } else if (isPlausiblePriceText(p)) {
        parts.push(name ? `${name}: ${p}` : p)
      }
    }

    const spec = o.priceSpecification
    if (spec && typeof spec === 'object') {
      const s = spec as Record<string, unknown>
      const price = s.price ?? s.minPrice ?? s.maxPrice
      const specName = typeof s.name === 'string' ? cleanText(s.name) : name
      if (typeof price === 'number' && price > 0) {
        parts.push(`${specName ? `${specName}: ` : ''}${price}円`)
      } else if (typeof price === 'string' && isPlausiblePriceText(price)) {
        parts.push(specName ? `${specName}: ${price}` : price)
      }
    }
  }

  const joined = cleanText(parts.join(' / '))
  return isPlausiblePriceText(joined) ? joined : null
}

function extractPriceFromInfotable($: CheerioAPI): string | null {
  const parts: string[] = []

  $('.m-infotable').each((_, table) => {
    const $table = $(table)
    const caption = cleanText($table.find('.m-infotable__caption').first().text())
    const captionIsPrice = caption ? /料金|入場|チケット/.test(caption) : false

    $table.find('tr').each((__, row) => {
      const th = cleanText($(row).find('th').first().text())
      const td = cleanText($(row).find('td').first().text())
      if (!td) return
      if (th && PRICE_LABEL_RE.test(th) && isPlausiblePriceText(td)) {
        parts.push(`${th}: ${td}`)
        return
      }
      if (captionIsPrice && isPlausiblePriceText(td)) {
        parts.push(th ? `${th}: ${td}` : td)
      }
    })
  })

  const joined = cleanText(parts.join(' / '))
  return isPlausiblePriceText(joined) ? joined : null
}

function extractPriceFromLabeledDom($: CheerioAPI): string | null {
  const parts: string[] = []
  const scope = $('main.l-main').length ? $('main.l-main') : $('main, article')

  scope.find('dl, table, .m-detailmain-box').each((_, el) => {
    const $el = $(el)
    if ($el.closest('footer, .m-refine, .m-weather, .l-footer').length) return

    $el.find('dt, th').each((__, labelEl) => {
      const label = cleanText($(labelEl).text())
      if (!label || !PRICE_LABEL_RE.test(label)) return
      const value = cleanText(
        $(labelEl).next('dd, td').text() ||
          $(labelEl).parent().find('td').first().text(),
      )
      if (value && isPlausiblePriceText(value)) {
        parts.push(`${label.replace(/[:：]\s*$/, '')}: ${value}`)
      }
    })
  })

  const joined = cleanText(parts.join(' / '))
  return isPlausiblePriceText(joined) ? joined : null
}

export function extractWalkerplusPriceText(
  html: string,
  eventLd: Record<string, unknown> | null,
): { price_text: string | null; source: string | null } {
  const $ = cheerio.load(html)

  const fromLd = eventLd ? formatJsonLdOfferPrice(eventLd.offers) : null
  if (fromLd) return { price_text: fromLd, source: 'jsonld:offers' }

  const fromTable = extractPriceFromInfotable($)
  if (fromTable) return { price_text: fromTable, source: 'html:infotable' }

  const fromLabel = extractPriceFromLabeledDom($)
  if (fromLabel) return { price_text: fromLabel, source: 'html:label' }

  return { price_text: null, source: null }
}

export function buildPricePageUrl(detailUrl: string, html: string): string | null {
  const $ = cheerio.load(html)
  const href =
    $('a.m-detailheader-menu__link[href*="price.html"]').first().attr('href') ||
    $('a[href*="price.html"]').first().attr('href')
  if (href) return toAbsoluteUrl(href, detailUrl)
  if (/\/event\/ar\d+e\d+\/?$/i.test(detailUrl)) {
    return toAbsoluteUrl('price.html', detailUrl)
  }
  return null
}

function isEventGenreHref(href: string | undefined): boolean {
  if (!href) return false
  return /\/event_list\/eg\d+\//.test(href) || /\/event_list\/tag\d+\//.test(href)
}

function normalizeCategoryLabel(label: string | null): string | null {
  if (!label) return null
  const text = label.trim()
  if (!text || text.length > 40) return null
  if (CATEGORY_BLOCKLIST.has(text)) return null
  if (/^\d+月$/.test(text)) return null
  if (/^令和|^平成/.test(text)) return null
  return text
}

export function extractWalkerplusCategories(
  listCategories: string[],
  eventLd: Record<string, unknown> | null,
  html: string,
): { categories: string[]; sources: string[] } {
  const ordered: string[] = []
  const seen = new Set<string>()
  const sources: string[] = []

  const add = (label: string | null, source: string) => {
    const normalized = normalizeCategoryLabel(label)
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    ordered.push(normalized)
    if (!sources.includes(source)) sources.push(source)
  }

  for (const cat of listCategories) {
    add(cat, 'list')
  }

  if (eventLd) {
    const ldCats = eventLd.eventAttendanceMode
    void ldCats
    const keywords = eventLd.keywords
    if (typeof keywords === 'string') {
      for (const part of keywords.split(/[,、/]/)) add(cleanText(part), 'jsonld:keywords')
    }
    if (Array.isArray(eventLd.about)) {
      for (const item of eventLd.about) {
        if (typeof item === 'string') add(cleanText(item), 'jsonld:about')
        else if (item && typeof item === 'object' && typeof (item as { name?: string }).name === 'string') {
          add(cleanText((item as { name: string }).name), 'jsonld:about')
        }
      }
    }
  }

  const $ = cheerio.load(html)
  $('.m-detailtag__tags .m-detailtag__taglink').each((_, el) => {
    const href = $(el).attr('href')
    if (!isEventGenreHref(href)) return
    add(cleanText($(el).text()), 'html:detailtag')
  })

  return { categories: ordered, sources }
}

function extractLocationFromJsonLd(eventLd: Record<string, unknown> | null): {
  venue: string | null
  address: string | null
  area_locality: string | null
} {
  if (!eventLd?.location || typeof eventLd.location !== 'object') {
    return { venue: null, address: null, area_locality: null }
  }

  const loc = eventLd.location as {
    name?: string
    address?: string | {
      streetAddress?: string
      addressLocality?: string
      addressRegion?: string
    }
  }

  const venue = cleanText(loc.name)
  let address: string | null = null
  let area_locality: string | null = null

  if (typeof loc.address === 'string') {
    address = cleanText(loc.address)
  } else if (loc.address && typeof loc.address === 'object') {
    address = cleanText(loc.address.streetAddress ?? null)
    area_locality = cleanText(loc.address.addressLocality ?? null)
    if (!address && loc.address.addressRegion) {
      const region = cleanText(loc.address.addressRegion)
      const locality = cleanText(loc.address.addressLocality)
      address = cleanText([region, locality].filter(Boolean).join(' '))
    }
  }

  return { venue, address, area_locality }
}

function extractLocationFromDom($: CheerioAPI): {
  venue: string | null
  address: string | null
} {
  let venue: string | null = null
  let address: string | null = null

  const venueBox = $('.m-detailmain-box').filter((_, el) =>
    /開催場所/.test($(el).find('.m-detailmain-box__title').text()),
  )
  if (venueBox.length) {
    const linkbox = cleanText(venueBox.find('.m-detailmain-box__linkbox').first().text())
    if (linkbox) {
      venue = cleanText(linkbox.replace(/\[地図\]/g, ''))
    }
  }

  if (!venue) {
    const headerVenue = cleanText(
      $('.m-detailheader-heading__nolink').first().text(),
    )
    if (headerVenue) venue = headerVenue
  }

  const addressRow = $('th, dt').filter((_, el) => /住所|所在地/.test($(el).text()))
  if (addressRow.length) {
    address = cleanText(addressRow.first().next('td, dd').text())
  }

  return { venue, address }
}

function extractImageCredit($: CheerioAPI): string | null {
  const caption = cleanText($('.m-detailpicture__caption').first().text())
  if (caption && /\(c\)|©|Copyright|著作|撮影|写真提供|画像提供|提供[:：]/i.test(caption)) {
    if (!IMAGE_CREDIT_REJECT_RE.test(caption)) return caption
  }

  const figureCaption = cleanText($('.m-detailpicture figcaption').first().text())
  if (
    figureCaption &&
    /\(c\)|©|Copyright|著作|撮影|写真提供|画像提供|提供[:：]/i.test(figureCaption)
  ) {
    if (!IMAGE_CREDIT_REJECT_RE.test(figureCaption)) return figureCaption
  }

  return null
}

export function extractWalkerplusDetail(
  html: string,
  pageUrl: string,
  listItem: WalkerplusListEvent,
  priceHtml?: string | null,
): WalkerplusEventDetail {
  const $ = cheerio.load(html)
  const field_sources: Record<string, string> = {}

  const jsonNodes = flattenJsonLd(parseJsonLdBlocks(html))
  const eventLd = pickEventJsonLd(jsonNodes)

  let title =
    (eventLd && typeof eventLd.name === 'string' ? cleanText(eventLd.name) : null) ||
    cleanText($('meta[property="og:title"]').attr('content')) ||
    cleanText($('h1').first().text()) ||
    listItem.title

  if (eventLd?.name) field_sources.title = 'jsonld'
  else if ($('meta[property="og:title"]').attr('content')) field_sources.title = 'og:title'
  else if ($('h1').first().text()) field_sources.title = 'html:h1'
  else field_sources.title = 'list'

  let start_date = eventLd ? isoDatePart(eventLd.startDate) : null
  let end_date = eventLd ? isoDatePart(eventLd.endDate) : null
  if (start_date) field_sources.start_date = 'jsonld'
  if (end_date) field_sources.end_date = 'jsonld'

  let start_time = eventLd ? isoTimePart(eventLd.startDate) : null
  let end_time = eventLd ? isoTimePart(eventLd.endDate) : null
  if (start_time) field_sources.start_time = 'jsonld'
  if (end_time) field_sources.end_time = 'jsonld'

  const ogDesc = cleanText($('meta[property="og:description"]').attr('content'))
  const metaDesc = cleanText($('meta[name="description"]').attr('content'))
  let description = ogDesc || metaDesc || listItem.summary
  if (ogDesc) field_sources.description = 'og:description'
  else if (metaDesc) field_sources.description = 'meta:description'
  else if (listItem.summary) field_sources.description = 'list'

  const mainText =
    cleanText($('main.l-main').first().text()) ||
    cleanText($('main, article, .contents, #contents').first().text()) ||
    ''

  const periodMatch = mainText.match(
    /(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日[^。\n]{0,120})/,
  )
  if ((!start_date || !end_date) && periodMatch) {
    const parsed = parseWalkerplusDateText(periodMatch[1])
    if (!start_date && parsed.start_date) {
      start_date = parsed.start_date
      field_sources.start_date = 'html:period'
    }
    if (!end_date && parsed.end_date) {
      end_date = parsed.end_date
      field_sources.end_date = 'html:period'
    }
  }

  if (!start_date && listItem.start_date) {
    start_date = listItem.start_date
    field_sources.start_date = 'list'
  }
  if (!end_date && listItem.end_date) {
    end_date = listItem.end_date
    field_sources.end_date = 'list'
  }

  const headerTime = cleanText($('.m-detailheader__period .m-detailheader__open')
    .filter((_, el) => /開催時間/.test($(el).text()))
    .first()
    .closest('.m-detailheader__period')
    .find('.m-detailheader__text')
    .text())
  const timeRaw = headerTime || extractLabeledTimeRawFromText(mainText)
  if (timeRaw && (!start_time || !end_time)) {
    const parsed = parseEventTimeText(timeRaw)
    if (!start_time && parsed.start_time) {
      start_time = parsed.start_time
      field_sources.start_time = headerTime ? 'html:header-time' : 'html:label-time'
    }
    if (!end_time && parsed.end_time) {
      end_time = parsed.end_time
      field_sources.end_time = headerTime ? 'html:header-time' : 'html:label-time'
    }
  }

  const ldLocation = extractLocationFromJsonLd(eventLd)
  let venue = ldLocation.venue
  let address = ldLocation.address
  let area_locality = ldLocation.area_locality
  if (venue) field_sources.venue = 'jsonld'
  if (address) field_sources.address = 'jsonld'
  if (area_locality) field_sources.area_locality = 'jsonld'

  if (!venue || !address) {
    const domLocation = extractLocationFromDom($)
    if (!venue && domLocation.venue) {
      venue = domLocation.venue
      field_sources.venue = 'html:venue-box'
    }
    if (!address && domLocation.address) {
      address = domLocation.address
      field_sources.address = 'html:address-label'
    }
  }

  let official_url =
    (eventLd && typeof eventLd.url === 'string'
      ? toAbsoluteUrl(eventLd.url, pageUrl)
      : null) ||
    toAbsoluteUrl($('a:contains("公式サイト")').first().attr('href'), pageUrl) ||
    toAbsoluteUrl($('a:contains("公式")').first().attr('href'), pageUrl)

  if (eventLd?.url) field_sources.official_url = 'jsonld'
  else if (official_url) field_sources.official_url = 'html:link'

  let { price_text, source: priceSource } = extractWalkerplusPriceText(html, eventLd)
  if (!price_text && priceHtml) {
    const fromPricePage = extractWalkerplusPriceText(priceHtml, null)
    if (fromPricePage.price_text) {
      price_text = fromPricePage.price_text
      priceSource = fromPricePage.source ?? 'html:price-page'
    }
  }
  if (price_text && priceSource) field_sources.price_text = priceSource

  const ogImage = pickMetaEventImage(
    $('meta[property="og:image"]').attr('content'),
    pageUrl,
  )
  const ldImage = eventLd ? extractJsonLdImageUrl(eventLd.image, pageUrl) : null
  let image_url = ldImage || ogImage || listItem.image_url
  if (ldImage) field_sources.image_url = 'jsonld'
  else if (ogImage) field_sources.image_url = 'og:image'
  else if (listItem.image_url) field_sources.image_url = 'list'
  if (image_url) image_url = normalizeImageUrl(image_url, pageUrl)

  const image_credit = extractImageCredit($)
  if (image_credit) field_sources.image_credit = 'html:image-caption'

  const { categories, sources: categorySources } = extractWalkerplusCategories(
    listItem.categories,
    eventLd,
    html,
  )
  if (categorySources.length > 0) {
    field_sources.categories = categorySources.join('+')
  }

  return {
    source_name: 'walkerplus',
    source_event_id: extractWalkerplusEventId(pageUrl) ?? listItem.source_event_id,
    title,
    start_date,
    end_date,
    start_time,
    end_time,
    venue,
    address,
    area_locality,
    price_text,
    official_url,
    description,
    image_url,
    image_credit,
    categories,
    source_url: pageUrl,
    field_sources,
    list_snapshot: listItem,
  }
}

export type CategoryBucket =
  | 'commercial'
  | 'anime_game'
  | 'character'
  | 'exhibition'
  | 'experience'
  | 'food'
  | 'kids'
  | 'seasonal'
  | 'other'

export function classifyCategoryBuckets(
  categories: string[],
  title: string | null = null,
): CategoryBucket[] {
  const joined = `${categories.join(' ')} ${title ?? ''}`
  const buckets = new Set<CategoryBucket>()

  const add = (bucket: CategoryBucket, re: RegExp) => {
    if (re.test(joined)) buckets.add(bucket)
  }

  add('commercial', /商業施設|ショッピング|百貨店|デパート/)
  add('anime_game', /アニメ・ゲーム|アニメ|ゲーム|ピクサー|ドラえもん|ポケモン/)
  add('character', /キャラクター|サンリオ|ディズニー|ホグワーツ|ハローキティ|くまのプーさん|リラックマ/)
  add('exhibition', /美術展|博物|展覧会|ミュージアム|特別展/)
  add('experience', /体験イベント|アクティビティ|体験型|ワークショップ/)
  add('food', /グルメ|フード|物産|味覚/)
  add('kids', /子供|子ども|キッズ|ファミリー|親子/)
  add('seasonal', /祭り|花火|紅葉|イルミ|クリスマス|花見|季節|夏祭|ハロウィン/)

  if (buckets.size === 0) {
    const primary = categories.find((c) => KNOWN_EVENT_CATEGORIES.has(c))
    if (primary) {
      if (/祭り|花火|紅葉|イルミ|クリスマス|花見/.test(primary)) buckets.add('seasonal')
      else if (/商業施設/.test(primary)) buckets.add('commercial')
      else if (/アニメ・ゲーム/.test(primary)) buckets.add('anime_game')
      else if (/美術展|博物/.test(primary)) buckets.add('exhibition')
      else if (/体験/.test(primary)) buckets.add('experience')
      else if (/グルメ|フード|物産/.test(primary)) buckets.add('food')
      else buckets.add('other')
    } else {
      buckets.add('other')
    }
  }

  return [...buckets]
}

export function fieldCompleteness(
  events: WalkerplusEventDetail[],
): Record<string, string> {
  const fields = [
    'start_date',
    'end_date',
    'start_time',
    'end_time',
    'venue',
    'address',
    'price_text',
    'official_url',
    'image_url',
    'categories',
  ] as const

  const total = events.length || 1
  const result: Record<string, string> = {}
  for (const field of fields) {
    let ok = 0
    for (const event of events) {
      const value = event[field]
      if (Array.isArray(value) ? value.length > 0 : value != null && value !== '') {
        ok++
      }
    }
    result[field] = `${ok}/${events.length} (${Math.round((ok / total) * 100)}%)`
  }
  return result
}
