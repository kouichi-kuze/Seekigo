/**
 * イベント事実フィールドの deterministic 正規化。
 * - area: 日本語/住所から slug を決定（AI より優先）
 * - address: 明確なアクセス情報のみ除去
 * - price_type: price_text から free / partially_paid / paid / varies を判定
 *
 * DB schema は変更しない。published 本体の上書きは呼び出し側で禁止すること。
 */

import type { PriceType } from './event-visit-attrs'

/** 内部 area slug → 日本語表示名（一覧・詳細共通） */
export const AREA_LABELS: Record<string, string> = {
  arakawa: '荒川区',
  asakusa: '浅草',
  chuo: '中央区',
  ginza: '銀座',
  harajuku: '原宿',
  higashiyamato: '東大和市',
  ikebukuro: '池袋',
  koenji: '高円寺',
  machida: '町田市',
  meguro: '目黒区',
  minato: '港区',
  odaiba: 'お台場',
  oji: '王子',
  roppongi: '六本木',
  shibuya: '渋谷区',
  shinjuku: '新宿区',
  sumida: '墨田区',
  taito: '台東区',
  tama: '多摩市',
  ueno: '上野',
  yokohama: '横浜',
}

/** 細エリア（ward より優先） */
const NEIGHBORHOOD_PATTERNS: Array<{ re: RegExp; slug: string }> = [
  { re: /お台場|odaiba/, slug: 'odaiba' },
  { re: /六本木|roppongi/, slug: 'roppongi' },
  { re: /銀座|ginza/, slug: 'ginza' },
  { re: /浅草|asakusa/, slug: 'asakusa' },
  { re: /上野|ueno/, slug: 'ueno' },
  { re: /原宿|harajuku|表参道|omotesando/, slug: 'harajuku' },
  { re: /池袋|ikebukuro/, slug: 'ikebukuro' },
  { re: /高円寺|koenji/, slug: 'koenji' },
  { re: /王子|oji/, slug: 'oji' },
]

/**
 * 市区町村・区名（長い地名を先にマッチ）
 * 細エリア未ヒット時に使用
 */
const WARD_CITY_PATTERNS: Array<{ re: RegExp; slug: string }> = [
  { re: /東大和市|higashiyamato/, slug: 'higashiyamato' },
  { re: /多摩市|(?:^|[^a-z])tama(?:$|[^a-z-])/, slug: 'tama' },
  { re: /町田市|machida/, slug: 'machida' },
  { re: /渋谷区|(?:^|[^a-z])shibuya(?:$|[^a-z-])/, slug: 'shibuya' },
  { re: /新宿区|(?:^|[^a-z])shinjuku(?:$|[^a-z-])/, slug: 'shinjuku' },
  { re: /台東区|(?:^|[^a-z])taito(?:$|[^a-z-])/, slug: 'taito' },
  { re: /墨田区|(?:^|[^a-z])sumida(?:$|[^a-z-])/, slug: 'sumida' },
  { re: /荒川区|(?:^|[^a-z])arakawa(?:$|[^a-z-])/, slug: 'arakawa' },
  { re: /目黒区|(?:^|[^a-z])meguro(?:$|[^a-z-])/, slug: 'meguro' },
  { re: /港区|(?:^|[^a-z])minato(?:$|[^a-z-])/, slug: 'minato' },
  { re: /中央区|(?:^|[^a-z])chuo(?:$|[^a-z-])/, slug: 'chuo' },
  // 区なし短縮（一覧の「渋谷」等）。細エリアより後・市区名の後に置く
  { re: /(?:^|[\s　])渋谷(?:$|[\s　])|^渋谷$/, slug: 'shibuya' },
  { re: /(?:^|[\s　])新宿(?:$|[\s　])|^新宿$/, slug: 'shinjuku' },
  { re: /(?:^|[\s　])目黒(?:$|[\s　])|^目黒$/, slug: 'meguro' },
  { re: /(?:^|[\s　])町田(?:$|[\s　])|^町田$/, slug: 'machida' },
  { re: /(?:^|[\s　])多摩(?:$|[\s　市])|^多摩$/, slug: 'tama' },
]

const KNOWN_SLUGS = new Set(Object.keys(AREA_LABELS))

function normalizeLookupText(value: string | null | undefined): string {
  if (!value) return ''
  return value.normalize('NFKC').trim()
}

function matchPatterns(
  text: string,
  patterns: Array<{ re: RegExp; slug: string }>,
): string | null {
  if (!text) return null
  for (const { re, slug } of patterns) {
    if (re.test(text)) return slug
  }
  return null
}

/** address から「○○区」「○○市」を抽出 */
export function extractMunicipalityFromAddress(
  address: string | null | undefined,
): string | null {
  const text = normalizeLookupText(address)
  if (!text) return null

  // 東京都多摩市… / 東京都渋谷区…
  const m = text.match(
    /(?:東京都|神奈川県|埼玉県|千葉県)?([^\s　0-9０-９]{1,10}?[市区])/,
  )
  if (!m?.[1]) return null
  return m[1]
}

export type ResolveAreaInput = {
  /** ソースの日本語エリアや既存 slug */
  areaHint?: string | null
  address?: string | null
  venue?: string | null
}

/**
 * area slug を deterministic に決定。
 * 優先順: 既知 slug → 細エリア → 市区町村（hint → address抽出 → venue）
 */
export function resolveAreaSlug(input: ResolveAreaInput): string | null {
  const hintRaw = normalizeLookupText(input.areaHint)
  if (hintRaw) {
    const asSlug = hintRaw.toLowerCase()
    if (KNOWN_SLUGS.has(asSlug) && /^[a-z0-9-]+$/.test(asSlug)) {
      return asSlug
    }
  }

  const combinedHintVenue = [hintRaw, normalizeLookupText(input.venue)]
    .filter(Boolean)
    .join(' ')
  const addressText = normalizeLookupText(input.address)
  const allText = [combinedHintVenue, addressText].filter(Boolean).join(' ')

  // 1) 細エリア（お台場・六本木等）を ward より優先
  const neighborhood =
    matchPatterns(combinedHintVenue, NEIGHBORHOOD_PATTERNS) ??
    matchPatterns(addressText, NEIGHBORHOOD_PATTERNS) ??
    matchPatterns(allText, NEIGHBORHOOD_PATTERNS)
  if (neighborhood) return neighborhood

  // 2) area_hint / venue の市区町村
  const fromHint = matchPatterns(combinedHintVenue, WARD_CITY_PATTERNS)
  if (fromHint) return fromHint

  // 3) address から市区町村抽出 → マップ
  const municipality = extractMunicipalityFromAddress(input.address)
  if (municipality) {
    const fromAddrLabel = matchPatterns(municipality, WARD_CITY_PATTERNS)
    if (fromAddrLabel) return fromAddrLabel
  }

  // 4) address 全文
  const fromAddress = matchPatterns(addressText, WARD_CITY_PATTERNS)
  if (fromAddress) return fromAddress

  return null
}

/**
 * 住所から明確なアクセス情報のみ除去。
 * ・JR / ・地下鉄 / ・都営 / ・東京メトロ / ・徒歩 など区切りがある場合のみ。
 * 曖昧なら元文字列を維持。
 */
export function cleanAddressAccess(
  address: string | null | undefined,
): string | null {
  if (address == null) return null
  const trimmed = address.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (!trimmed) return null

  const markers: RegExp[] = [
    /[・･]\s*(?:JR|ｊｒ)/i,
    /[・･]\s*地下鉄/,
    /[・･]\s*都営/,
    /[・･]\s*東京メトロ/,
    /[・･]\s*メトロ/,
    /[・･]\s*徒歩/,
    /[・･]\s*(?:京王|小田急|東急|西武|東武|京成|りんかい|ゆりかもめ|つくばエクスプレス|TX)/,
  ]

  let cutAt = -1
  for (const re of markers) {
    const m = trimmed.match(re)
    if (m?.index != null && m.index > 0) {
      if (cutAt < 0 || m.index < cutAt) cutAt = m.index
    }
  }

  if (cutAt < 0) return trimmed

  const cleaned = trimmed
    .slice(0, cutAt)
    .replace(/[・･、，,\s]+$/u, '')
    .trim()

  // 削りすぎ・住所らしさ喪失なら元を維持
  if (cleaned.length < 8) return trimmed
  if (!/[都道府県市区町村]/.test(cleaned) && !/\d/.test(cleaned)) {
    return trimmed
  }
  // 明らかに短くしすぎ（元の半分未満かつ 15 文字未満）は維持
  if (cleaned.length < Math.min(15, trimmed.length * 0.4)) return trimmed

  return cleaned
}

const WHOLE_EVENT_FREE_PART =
  /^(?:(?:入場|観覧|参加)(?:料(?:金)?)?(?:は|が)?)?無料[。．]?$/

function priceCompact(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '')
}

/** 文全体が入場・観覧・参加の無料だけで、金額も条件もない。 */
function isWholeEventFreeText(compact: string): boolean {
  const body = compact.replace(/^料金[:：]/, '')
  const parts = body
    .split(/[。．]/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return false
  return parts.every((part) => WHOLE_EVENT_FREE_PART.test(part))
}

const VARIES_PRICE_RE =
  /(?:各種イベント|提供店|プログラム|イベント|店舗|お店|内容)によって(?:料金が)?(?:異なります|異なる)/

const FREE_BASE_RE =
  /(?:入場料金?(?:は|が|:)?無料|入場無料|観覧料(?:は|が)?無料|観覧無料|観覧は無料|参加費は不要|参加費不要|無料で鑑賞|無料で観覧)/

function hasPriceYen(compact: string): boolean {
  return /\d[\d,]*円/.test(compact)
}

/**
 * price_text から料金区分を決める。判断できなければ null。
 * 年齢などの一部無料は、主要な一般料金が有料なら paid。
 */
export function inferPriceTypeFromPriceText(
  priceText: string | null | undefined,
): PriceType | null {
  if (priceText == null) return null
  const raw = priceText.normalize('NFKC').trim()
  if (!raw) return null
  const compact = priceCompact(raw)

  if (VARIES_PRICE_RE.test(compact)) return 'varies'
  if (/一部有料/.test(compact)) return 'partially_paid'

  const freeBase = FREE_BASE_RE.test(compact)
  const paidPart = /有料/.test(compact) || hasPriceYen(compact) || /別途/.test(compact)
  if (freeBase && paidPart) return 'partially_paid'
  if (freeBase || isWholeEventFreeText(compact)) return 'free'

  if (/無料ではな|無料じゃな/.test(compact)) return 'paid'
  if (hasPriceYen(compact) && /内容により異/.test(compact)) return null
  if (isAncillaryFeeOnly(compact)) return null
  if (hasPriceYen(compact) || /有料/.test(compact)) return 'paid'
  return null
}

/** 主体験の入場・参加ではなく、飲食ブースや任意の特別席だけが有料。 */
function isAncillaryFeeOnly(compact: string): boolean {
  if (/(?:一般|入場料|入場券|チケット|参加費)\d/.test(compact)) return false
  if (/サポーターズシート/.test(compact)) return true
  return /(?:屋台|飲食|キッチンカー|テント).{0,16}有料/.test(compact)
}

export function normalizePriceType(value: unknown): PriceType | null {
  if (value === 'free' || value === 'partially_paid' || value === 'paid' || value === 'varies') {
    return value
  }
  return null
}

function clockMinutes(value: string | null | undefined): number | null {
  const match = value?.trim().match(/^(\d{1,2}):(\d{2})/)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null
  return hour * 60 + minute
}

/**
 * 「夜どこ行く？」の候補か。遅くまで開いているだけでは true にしない。
 * 判断できないときは null。
 */
export function inferIsNight(input: {
  title?: string | null
  summary?: string | null
  venue?: string | null
  description?: string | null
  startTime?: string | null
  endTime?: string | null
}): boolean | null {
  const raw = [input.title, input.summary, input.venue, input.description]
    .filter((part) => part?.trim())
    .join('\n')
    .normalize('NFKC')
  const text = raw.replace(/グッドナイト/g, '').replace(/暗闇/g, '')
  if (/夜市|宵|夜間|夜祭|ナイト|ビアガーデン|盆踊|オクトーバーフェスト/.test(text)) {
    return true
  }
  const start = clockMinutes(input.startTime)
  if (start != null && start >= 17 * 60) return true
  return null
}

/** 規則で夜向けなら true。AI が遅くまで開いているだけで true にしたときは null。 */
export function resolveIsNight(
  inferred: boolean | null,
  aiValue: boolean | null | undefined,
): boolean | null {
  if (inferred === true) return true
  if (aiValue === true) return null
  return aiValue ?? null
}

/**
 * 街スラッグ → 自治体スラッグ。
 * お台場・池袋・王子・吉祥寺は自治体が一つに決まらないため含めない。
 */
export const NEIGHBORHOOD_TO_MUNICIPALITY: Record<string, string> = {
  roppongi: 'minato',
  ginza: 'chuo',
  asakusa: 'taito',
  ueno: 'taito',
  harajuku: 'shibuya',
  koenji: 'suginami',
}

/** 区・市として municipality に入れてよいスラッグ。街スラッグは含めない。 */
export const MUNICIPALITY_SLUGS = [
  'arakawa',
  'bunkyo',
  'chiyoda',
  'chuo',
  'higashiyamato',
  'kita',
  'koganei',
  'koto',
  'machida',
  'meguro',
  'minato',
  'nerima',
  'ota',
  'setagaya',
  'shibuya',
  'shinagawa',
  'shinjuku',
  'suginami',
  'sumida',
  'tachikawa',
  'taito',
  'tama',
  'yokohama',
] as const

/** 今回の自動バックフィルから外す area。 */
export const MUNICIPALITY_REVIEW_AREA_SLUGS = [
  'odaiba',
  'ikebukuro',
  'oji',
  'kichijoji',
] as const

const MUNICIPALITY_SLUG_SET = new Set<string>(MUNICIPALITY_SLUGS)

/** 区・市スラッグ。area の修正候補にはしない。 */
export function isMunicipalitySlug(slug: string | null | undefined): boolean {
  const key = slug?.trim().toLowerCase()
  return Boolean(key && MUNICIPALITY_SLUG_SET.has(key))
}

/** 街の area 候補。自治体スラッグは null。 */
export function neighborhoodAreaCandidate(
  slug: string | null | undefined,
): string | null {
  const key = slug?.trim().toLowerCase() || null
  if (!key || isMunicipalitySlug(key)) return null
  return key
}
const REVIEW_AREA_SET = new Set<string>(MUNICIPALITY_REVIEW_AREA_SLUGS)

/**
 * 文中に明示された区市町村だけ。
 * 「多摩」だけでは多摩市にしない。「港北区」は北区にしない。
 */
const ADDRESS_MUNICIPALITY_PATTERNS: Array<{ re: RegExp; slug: string }> = [
  { re: /東大和市/, slug: 'higashiyamato' },
  { re: /横浜市/, slug: 'yokohama' },
  { re: /小金井市/, slug: 'koganei' },
  { re: /立川市/, slug: 'tachikawa' },
  { re: /町田市/, slug: 'machida' },
  { re: /多摩市/, slug: 'tama' },
  { re: /千代田区/, slug: 'chiyoda' },
  { re: /世田谷区/, slug: 'setagaya' },
  { re: /杉並区/, slug: 'suginami' },
  { re: /品川区/, slug: 'shinagawa' },
  { re: /練馬区/, slug: 'nerima' },
  { re: /大田区/, slug: 'ota' },
  { re: /渋谷区/, slug: 'shibuya' },
  { re: /新宿区/, slug: 'shinjuku' },
  { re: /中央区/, slug: 'chuo' },
  { re: /文京区/, slug: 'bunkyo' },
  { re: /台東区/, slug: 'taito' },
  { re: /墨田区/, slug: 'sumida' },
  { re: /目黒区/, slug: 'meguro' },
  { re: /荒川区/, slug: 'arakawa' },
  { re: /(?<!港)北区/, slug: 'kita' },
  { re: /港区/, slug: 'minato' },
]

function explicitMunicipalitySlugs(
  value: string | null | undefined,
): Set<string> {
  const text = normalizeLookupText(value)
  const found = new Set<string>()
  if (!text) return found
  for (const { re, slug } of ADDRESS_MUNICIPALITY_PATTERNS) {
    if (re.test(text)) found.add(slug)
  }
  return found
}

/** 明示が一つならその自治体。複数あるときは null。明示がなければ undefined。 */
function uniqueExplicitMunicipality(
  value: string | null | undefined,
): string | null | undefined {
  const found = explicitMunicipalitySlugs(value)
  if (found.size === 0) return undefined
  if (found.size > 1) return null
  return [...found][0]
}

/**
 * area スラッグから自治体を返す。
 * 住所・会場に別の自治体が書いてあるときは呼ばない。
 * tama は「多摩市」の明記がないと自治体にしない。
 */
function municipalityFromAreaSlug(area: string | null | undefined): string | null {
  const key = area?.trim().toLowerCase() || null
  if (!key) return null
  if (key === 'tama') return null
  const fromNeighborhood = NEIGHBORHOOD_TO_MUNICIPALITY[key]
  if (fromNeighborhood) return fromNeighborhood
  if (REVIEW_AREA_SET.has(key)) return null
  if (MUNICIPALITY_SLUG_SET.has(key)) return key
  return null
}

/**
 * municipality だけ返す。area 列は変更しない。
 * 優先順: 住所の自治体 → 会場文に書かれた自治体 → area 対応。
 * 要確認の街、未知スラッグ、自治体が一つに決まらない場合は null。
 */
export function inferMunicipalitySlug(input: {
  area?: string | null
  address?: string | null
  venue?: string | null
}): string | null {
  const fromAddress = uniqueExplicitMunicipality(input.address)
  if (fromAddress !== undefined) return fromAddress

  const fromVenue = uniqueExplicitMunicipality(input.venue)
  if (fromVenue !== undefined) return fromVenue

  return municipalityFromAreaSlug(input.area)
}

export type EventPlace = {
  municipality: string | null
  /** 街スラッグ。区市町村だけ分かるときは null。自治体スラッグは入れない。 */
  area: string | null
  /** resolveAreaSlug の従来結果。dedupe と比較用。新規 area には使わない。 */
  legacyArea: string | null
}

function neighborhoodSlug(
  slug: string | null | undefined,
): string | null {
  const key = slug?.trim().toLowerCase() || null
  if (!key || !NEIGHBORHOOD_TO_MUNICIPALITY[key]) return null
  return key
}

function reviewAreaSlug(slug: string | null | undefined): string | null {
  const key = slug?.trim().toLowerCase() || null
  if (!key || !REVIEW_AREA_SET.has(key)) return null
  return key
}

/**
 * 新規イベント用。municipality と街 area を分ける。
 * 優先順は住所の自治体、会場文の自治体、area 対応。
 * 住所の自治体と area 対応が食い違うときは area を空にする。
 * 区だけのときは area を空にする。
 */
export function resolveEventPlace(input: ResolveAreaInput): EventPlace {
  const legacyArea = resolveAreaSlug(input)
  const fromVenue = resolveAreaSlug({
    address: input.address,
    venue: input.venue,
  })
  const neighborhood =
    neighborhoodSlug(fromVenue) ?? neighborhoodSlug(legacyArea)
  const reviewArea = reviewAreaSlug(fromVenue) ?? reviewAreaSlug(legacyArea)
  const municipality = inferMunicipalitySlug({
    area: neighborhood ?? legacyArea ?? fromVenue,
    address: input.address,
    venue: input.venue,
  })

  if (neighborhood) {
    const parent = NEIGHBORHOOD_TO_MUNICIPALITY[neighborhood]
    if (municipality === parent) {
      return { municipality, area: neighborhood, legacyArea }
    }
    return { municipality, area: null, legacyArea }
  }

  return {
    municipality,
    area: reviewArea,
    legacyArea,
  }
}
