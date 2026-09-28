/**
 * イベント事実フィールドの deterministic 正規化。
 * - area: 日本語/住所から slug を決定（AI より優先）
 * - address: 明確なアクセス情報のみ除去
 * - is_free: price_text から判定（AI より優先）
 *
 * DB schema は変更しない。published 本体の上書きは呼び出し側で禁止すること。
 */

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

/**
 * price_text から is_free を deterministic 判定。
 * Seekigo: 入場・参加自体が無料なら一部有料でも true。
 * 判定不能は null（AI fallback 可）。
 */
export function inferIsFreeFromPriceText(
  priceText: string | null | undefined,
): boolean | null {
  if (priceText == null) return null
  const raw = priceText.normalize('NFKC').trim()
  if (!raw) return null

  const compact = raw.replace(/\s+/g, '')

  // 明確な無料入場・参加（一部有料注記があっても true）
  if (
    /入場無料/.test(compact) ||
    /参加無料/.test(compact) ||
    /観覧無料/.test(compact) ||
    /入場料[金]?(?:は)?無料/.test(compact) ||
    /入場料[金]?[：:＝=]無料/.test(compact)
  ) {
    return true
  }

  // 単独の「無料」または注記付き「無料※…」「無料（…）」
  if (
    /^無料$/.test(compact) ||
    /^無料[※*（(・]/.test(compact) ||
    /^無料[。．.]/.test(compact)
  ) {
    return true
  }

  // 文中の無料だが「無料ではない」等を除外
  if (/無料/.test(compact)) {
    if (/無料ではな|無料じゃな|有料のみ|すべて有料|全て有料/.test(compact)) {
      return false
    }
    // 「〜は無料」など入場無料相当
    if (/(?:は|が|で)無料|無料です|無料となります|無料で/.test(compact)) {
      return true
    }
    // その他「無料」を含むが曖昧な場合も、Seekigo 方針では入場無料寄り
    // 「有料・無料」混在で入場が不明なら null に近づける
    if (/有料/.test(compact) && !/(?:入場|参加|観覧).*無料|無料.*(?:入場|参加|観覧)/.test(compact)) {
      // 「一部有料」のみ併記の無料は上で true。ここは「有料と無料が並ぶ曖昧」
      if (/一部有料|一部.*?有料|有料コンテンツ|有料エリア/.test(compact)) {
        return true
      }
      return null
    }
    return true
  }

  // 明確な有料
  if (/^有料$/.test(compact) || /(?:^|[。．])有料(?:[。．]|対応|$)/.test(compact)) {
    return false
  }
  if (
    /(?:一般|入場料|前売|前売り|当日|大人|高校生|大学生|中学生)[^無料]{0,12}\d{2,6}\s*円/.test(
      raw,
    )
  ) {
    return false
  }
  if (/\d{2,6}\s*円/.test(raw) && !/無料/.test(compact)) {
    return false
  }
  if (/有料/.test(compact) && !/無料/.test(compact)) {
    return false
  }

  return null
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
  'chuo',
  'higashiyamato',
  'machida',
  'meguro',
  'minato',
  'shibuya',
  'shinjuku',
  'sumida',
  'taito',
  'tama',
  'yokohama',
  'koto',
  'setagaya',
  'ota',
  'suginami',
  'shinagawa',
  'nerima',
] as const

/** 今回の自動バックフィルから外す area。 */
export const MUNICIPALITY_REVIEW_AREA_SLUGS = [
  'odaiba',
  'ikebukuro',
  'oji',
  'kichijoji',
] as const

const MUNICIPALITY_SLUG_SET = new Set<string>(MUNICIPALITY_SLUGS)
const REVIEW_AREA_SET = new Set<string>(MUNICIPALITY_REVIEW_AREA_SLUGS)

/** 住所に明示された区市町村だけ。タイトルや会場名では判定しない。 */
const ADDRESS_MUNICIPALITY_PATTERNS: Array<{ re: RegExp; slug: string }> = [
  { re: /東大和市/, slug: 'higashiyamato' },
  { re: /横浜市/, slug: 'yokohama' },
  { re: /町田市/, slug: 'machida' },
  { re: /多摩市/, slug: 'tama' },
  { re: /江東区/, slug: 'koto' },
  { re: /世田谷区/, slug: 'setagaya' },
  { re: /杉並区/, slug: 'suginami' },
  { re: /品川区/, slug: 'shinagawa' },
  { re: /練馬区/, slug: 'nerima' },
  { re: /大田区/, slug: 'ota' },
  { re: /渋谷区/, slug: 'shibuya' },
  { re: /新宿区/, slug: 'shinjuku' },
  { re: /中央区/, slug: 'chuo' },
  { re: /台東区/, slug: 'taito' },
  { re: /墨田区/, slug: 'sumida' },
  { re: /目黒区/, slug: 'meguro' },
  { re: /荒川区/, slug: 'arakawa' },
  { re: /港区/, slug: 'minato' },
]

function municipalityFromAddress(address: string | null | undefined): string | null {
  const text = normalizeLookupText(address)
  if (!text) return null
  const found = new Set<string>()
  for (const { re, slug } of ADDRESS_MUNICIPALITY_PATTERNS) {
    if (re.test(text)) found.add(slug)
  }
  if (found.size !== 1) return null
  return [...found][0]
}

/**
 * municipality だけ返す。area 列は変更しない。
 * 要確認の街、未知スラッグ、住所から自治体が一つに決まらない場合は null。
 */
export function inferMunicipalitySlug(input: {
  area?: string | null
  address?: string | null
}): string | null {
  const area = input.area?.trim().toLowerCase() || null
  if (area) {
    const fromNeighborhood = NEIGHBORHOOD_TO_MUNICIPALITY[area]
    if (fromNeighborhood) return fromNeighborhood
    if (REVIEW_AREA_SET.has(area)) return null
    if (MUNICIPALITY_SLUG_SET.has(area)) return area
    return null
  }
  return municipalityFromAddress(input.address)
}

export type EventPlace = {
  municipality: string | null
  /** 街スラッグ。区市町村だけ分かるときは null。自治体スラッグは入れない。 */
  area: string | null
  /** resolveAreaSlug の従来結果。dedupe と比較用。新規 area には使わない。 */
  legacyArea: string | null
}

/**
 * 新規イベント用。municipality と街 area を分ける。
 * 会場・住所で街が分かるときはそれを優先し、区だけのときは area を空にする。
 */
export function resolveEventPlace(input: ResolveAreaInput): EventPlace {
  const legacyArea = resolveAreaSlug(input)
  const fromVenue = resolveAreaSlug({
    address: input.address,
    venue: input.venue,
  })
  const neighborhood =
    (fromVenue && NEIGHBORHOOD_TO_MUNICIPALITY[fromVenue] ? fromVenue : null) ??
    (legacyArea && NEIGHBORHOOD_TO_MUNICIPALITY[legacyArea] ? legacyArea : null)

  if (neighborhood) {
    return {
      municipality: NEIGHBORHOOD_TO_MUNICIPALITY[neighborhood],
      area: neighborhood,
      legacyArea,
    }
  }

  if (legacyArea && MUNICIPALITY_SLUG_SET.has(legacyArea)) {
    return { municipality: legacyArea, area: null, legacyArea }
  }
  if (fromVenue && MUNICIPALITY_SLUG_SET.has(fromVenue)) {
    return { municipality: fromVenue, area: null, legacyArea }
  }
  if (legacyArea && REVIEW_AREA_SET.has(legacyArea)) {
    return { municipality: null, area: legacyArea, legacyArea }
  }
  if (fromVenue && REVIEW_AREA_SET.has(fromVenue)) {
    return { municipality: null, area: fromVenue, legacyArea }
  }

  return {
    municipality: inferMunicipalitySlug({ area: null, address: input.address }),
    area: null,
    legacyArea,
  }
}
