/**
 * 港区オープンデータ「港区イベント情報」の CSV 正規化と SEEKIGO 向けフィルタ。
 * 日時は自信がある形だけ埋める。複数日程は単一期間に潰さない。
 */
export const MINATO_OPENDATA_SOURCE = 'minato_opendata' as const

export const MINATO_EVENT_CSV_URL =
  'https://opendata.city.minato.tokyo.jp/dataset/abb98f48-76fb-4013-9d7e-d3028830e7f2/resource/53b60f4a-f39e-41f2-b7a6-41f5c7ab23d3/download/minatokueventjoho.csv'

export const MINATO_LICENSE = {
  name: 'CC BY',
  termsUrl: 'https://portal.data.metro.tokyo.lg.jp/terms/',
  attribution:
    '港区イベント情報、港区、クリエイティブ・コモンズ・ライセンス 表示4.0国際（https://creativecommons.org/licenses/by/4.0/deed.ja）',
} as const

export type MinatoFilterStatus = 'include' | 'exclude' | 'review'
export type MinatoDateStatus = 'single' | 'range' | 'multiple' | 'weekly' | 'unparsed' | 'partial'
export type MinatoLifecycle = 'future' | 'ongoing' | 'ended' | 'unknown'
export type MinatoAreaStatus = 'minato' | 'outside_minato' | 'unknown'

export type MinatoOccurrence = {
  start_date: string
  end_date: string
  start_time: null
  end_time: null
}

export type MinatoNormalizedEvent = {
  source: typeof MINATO_OPENDATA_SOURCE
  source_url: string | null
  dataset_url: string
  title: string | null
  start_date: string | null
  end_date: string | null
  start_time: string | null
  end_time: string | null
  occurrences: MinatoOccurrence[]
  venue_name: string | null
  address: string | null
  latitude: number | null
  longitude: number | null
  price_text: string | null
  category_raw: string | null
  target_raw: string | null
  description_raw: string | null
  official_url: string | null
  contact: string | null
  phone: string | null
  related_urls: string[]
  raw_date: string | null
  raw_date_detail: string | null
  date_status: MinatoDateStatus
  lifecycle: MinatoLifecycle
  area_status: MinatoAreaStatus
  filter_status: MinatoFilterStatus
  filter_reason: string
}

const HARD_EXCLUDE_RE =
  /法律相談|労働相談|行政相談|はり・マッサージ|マッサージサービス|家族会|茶話会|支援者向け|研修|求人|説明会|検診|健診|出演者募集|事業者募集|職員向け|委員会|審議会|支援員|申請案内|手続き|(?<!交流)会議/

const INCLUDE_RE =
  /祭|まつり|華火|花火|フェス|マルシェ|ワークショップ|体験|講座|教室|講演|親子|子ども|こども|キッズ|幼児|展示|展覧会|展|コンサート|演奏|ライブ|スポーツ|大会|公園|文化|ハロウィン|クリスマス|盆踊|見学会|作品|クルーズ|英語であそぼう|料理|昼食会|収穫|自然観察|生き物観察/

const SUPPORT_CAFE_RE = /患者|家族|メンター|がん|介護|相談|支援者|支援/
const CULTURE_CAFE_RE = /文化|交流|江戸|展示|音楽|コンサート|物語|カフェ「/

const OUTSIDE_PLACES = [
  'あきる野',
  '秋川',
  '千代田区',
  '中央区',
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
  '八王子',
  '立川市',
  '武蔵野',
  '三鷹',
  '青梅',
  '府中市',
  '調布',
  '町田',
]

const MINATO_PLACES = [
  '港区',
  '赤坂',
  '青山',
  '六本木',
  '芝浦',
  '白金',
  '麻布',
  '高輪',
  '新橋',
  '虎ノ門',
  '浜松町',
  '田町',
  '愛宕',
  '汐留',
  '竹芝',
  '台場',
  'お台場',
  '芝公園',
  '三田',
]

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let quoted = false
  const source = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cur += '"'
          i++
        } else quoted = false
      } else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cur)
      cur = ''
    } else if (ch === '\n') {
      row.push(cur.replace(/\r$/, ''))
      rows.push(row)
      row = []
      cur = ''
    } else if (ch !== '\r') cur += ch
  }
  if (cur.length || row.length) {
    row.push(cur)
    rows.push(row)
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim()))
}

export function cleanText(value: string | undefined | null): string | null {
  if (!value) return null
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length ? text : null
}

function cell(row: string[], index: number): string | null {
  if (index < 0) return null
  return cleanText(row[index])
}

function headerIndex(headers: string[], name: string): number {
  return headers.findIndex((header) => header.trim() === name)
}

function toYmd(year: string, month: string, day: string): string | null {
  const y = Number(year)
  const m = Number(month)
  const d = Number(day)
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
}

const RANGE_RE = /^(\d{4})年(\d{1,2})月(\d{1,2})日から(\d{4})年(\d{1,2})月(\d{1,2})日$/
const SINGLE_RE = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/

export function parseOccurrencePart(part: string): MinatoOccurrence | null {
  const range = part.match(RANGE_RE)
  if (range) {
    const start = toYmd(range[1], range[2], range[3])
    const end = toYmd(range[4], range[5], range[6])
    if (!start || !end || start > end) return null
    return { start_date: start, end_date: end, start_time: null, end_time: null }
  }
  const single = part.match(SINGLE_RE)
  if (!single) return null
  const day = toYmd(single[1], single[2], single[3])
  if (!day) return null
  return { start_date: day, end_date: day, start_time: null, end_time: null }
}

export function normalizeMinatoDate(rawDate: string | null, rawDetail: string | null): {
  start_date: string | null
  end_date: string | null
  start_time: string | null
  end_time: string | null
  occurrences: MinatoOccurrence[]
  date_status: MinatoDateStatus
} {
  const empty = {
    start_date: null,
    end_date: null,
    start_time: null,
    end_time: null,
    occurrences: [] as MinatoOccurrence[],
    date_status: 'unparsed' as const,
  }
  const raw = rawDate?.trim()
  if (!raw) return empty
  if (/毎週|隔週|毎月/.test(`${raw}\n${rawDetail ?? ''}`)) {
    return { ...empty, date_status: 'weekly' }
  }

  const parts = raw.split(',').map((part) => part.trim()).filter(Boolean)
  const occurrences = parts
    .map((part) => parseOccurrencePart(part))
    .filter((item): item is MinatoOccurrence => item != null)

  if (occurrences.length === 0) return empty
  if (parts.length > 1) {
    return {
      start_date: null,
      end_date: null,
      start_time: null,
      end_time: null,
      occurrences,
      date_status: occurrences.length === parts.length ? 'multiple' : 'partial',
    }
  }

  const only = occurrences[0]
  return {
    start_date: only.start_date,
    end_date: only.end_date,
    start_time: null,
    end_time: null,
    occurrences,
    date_status: only.start_date === only.end_date ? 'single' : 'range',
  }
}

export function lifecycleFromOccurrences(
  occurrences: MinatoOccurrence[],
  asOf: string,
): MinatoLifecycle {
  if (occurrences.length === 0) return 'unknown'
  const coversToday = occurrences.some(
    (item) => item.start_date <= asOf && item.end_date >= asOf,
  )
  if (coversToday) return 'ongoing'
  if (occurrences.some((item) => item.start_date > asOf)) return 'future'
  if (occurrences.every((item) => item.end_date < asOf)) return 'ended'
  return 'unknown'
}

export function nextOccurrenceDate(
  occurrences: MinatoOccurrence[],
  asOf: string,
): string | null {
  const upcoming = occurrences
    .filter((item) => item.end_date >= asOf)
    .sort((a, b) => a.start_date.localeCompare(b.start_date))
  const next = upcoming[0]
  if (!next) return null
  return next.start_date === next.end_date
    ? next.start_date
    : `${next.start_date}..${next.end_date}`
}

export function classifyMinatoArea(input: {
  title: string | null
  venue: string | null
  description: string | null
}): MinatoAreaStatus {
  const venue = `${input.venue ?? ''}\n${input.description ?? ''}`
  const all = `${input.title ?? ''}\n${venue}`
  const outsideInVenue = OUTSIDE_PLACES.some((place) => venue.includes(place))
  if (outsideInVenue) return 'outside_minato'
  const outsideInTitle = OUTSIDE_PLACES.some((place) => (input.title ?? '').includes(place))
  const inMinato = MINATO_PLACES.some((place) => all.includes(place))
  if (outsideInTitle && inMinato) return 'unknown'
  if (outsideInTitle) return 'outside_minato'
  if (inMinato) return 'minato'
  return 'unknown'
}

export function classifyMinatoEvent(input: {
  title: string | null
  category: string | null
  target: string | null
  description: string | null
}): { filter_status: MinatoFilterStatus; filter_reason: string } {
  const title = input.title ?? ''
  const category = input.category ?? ''
  const target = input.target ?? ''
  const head = `${title}\n${category}\n${target}`
  const blob = `${head}\n${input.description ?? ''}`

  if (/カフェ/.test(head) && SUPPORT_CAFE_RE.test(blob)) {
    return {
      filter_status: 'exclude',
      filter_reason: '患者・家族・支援が主のカフェで、お出かけ先ではない',
    }
  }
  if (HARD_EXCLUDE_RE.test(head) || /はり・マッサージ|家族会|茶話会|支援者向け/.test(blob)) {
    return {
      filter_status: 'exclude',
      filter_reason: '相談・説明会・研修・募集・検診・施術サービスなど、お出かけ先ではない',
    }
  }
  if (/相談/.test(title) && !INCLUDE_RE.test(title)) {
    return {
      filter_status: 'exclude',
      filter_reason: '相談を主目的にしている',
    }
  }
  if (/カフェ/.test(head) && !CULTURE_CAFE_RE.test(head)) {
    return {
      filter_status: 'review',
      filter_reason: 'カフェだけでは一般向けの文化イベントか決められない',
    }
  }
  if (/見学/.test(head) && !/収穫|観察|体験|展示|文化/.test(head)) {
    return {
      filter_status: 'review',
      filter_reason: '見学だけでは行き先イベントか決められない',
    }
  }
  if (/カフェ/.test(head) && CULTURE_CAFE_RE.test(head)) {
    return {
      filter_status: 'include',
      filter_reason: '文化交流などのカフェで、行き先になり得る',
    }
  }
  if (HARD_EXCLUDE_RE.test(blob) && INCLUDE_RE.test(head)) {
    return {
      filter_status: 'review',
      filter_reason: '行き先らしい語と、相談・募集・行政手続きの語が両方ある',
    }
  }
  if (INCLUDE_RE.test(head)) {
    return {
      filter_status: 'include',
      filter_reason: '祭り・体験・講座・展示・クルーズなど、行き先になり得る',
    }
  }
  return {
    filter_status: 'review',
    filter_reason: '行き先かどうか、タイトルと分類だけでは判定できない',
  }
}

function finiteCoord(value: string | null): number | null {
  if (!value) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function rowToMinatoEvent(
  headers: string[],
  row: string[],
): MinatoNormalizedEvent | null {
  const at = (name: string) => cell(row, headerIndex(headers, name))
  const title = at('ページタイトル')
  const official = at('ページURL')
  if (!title && !official) return null

  const rawDate = at('開催日時')
  const rawDetail = at('開催日詳細')
  const dates = normalizeMinatoDate(rawDate, rawDetail)
  const category = [at('分類'), at('第1分類'), at('第2分類')].filter(Boolean).join(' / ') || null
  const contactName = at('問い合わせ先1')
  const phone = at('問い合わせ先電話番号1')
  const contact = [contactName, phone].filter(Boolean).join(' ') || at('問い合わせ先フリー入力')
  const related = [1, 2, 3, 4, 5]
    .map((n) => at(`関連リンクURL${n}`))
    .filter((url): url is string => Boolean(url))
  const venue = at('ところ')
  const description = at('内容')
  const filter = classifyMinatoEvent({
    title,
    category,
    target: at('対象'),
    description,
  })

  return {
    source: MINATO_OPENDATA_SOURCE,
    source_url: official,
    dataset_url: MINATO_EVENT_CSV_URL,
    title,
    start_date: dates.start_date,
    end_date: dates.end_date,
    start_time: dates.start_time,
    end_time: dates.end_time,
    occurrences: dates.occurrences,
    venue_name: venue,
    address: null,
    latitude: finiteCoord(at('緯度')),
    longitude: finiteCoord(at('経度')),
    price_text: at('費用'),
    category_raw: category,
    target_raw: at('対象'),
    description_raw: description,
    official_url: official,
    contact,
    phone,
    related_urls: related,
    raw_date: rawDate,
    raw_date_detail: rawDetail,
    date_status: dates.date_status,
    lifecycle: 'unknown',
    area_status: classifyMinatoArea({ title, venue, description }),
    filter_status: filter.filter_status,
    filter_reason: filter.filter_reason,
  }
}

export function normalizeMinatoCsv(text: string, asOf: string): MinatoNormalizedEvent[] {
  const rows = parseCsv(text)
  if (rows.length === 0) return []
  const headers = rows[0].map((header) => header.trim())
  const events: MinatoNormalizedEvent[] = []
  for (const row of rows.slice(1)) {
    const event = rowToMinatoEvent(headers, row)
    if (!event) continue
    event.lifecycle = lifecycleFromOccurrences(event.occurrences, asOf)
    events.push(event)
  }
  return events
}

export function isActive(event: MinatoNormalizedEvent): boolean {
  return event.lifecycle === 'future' || event.lifecycle === 'ongoing'
}
