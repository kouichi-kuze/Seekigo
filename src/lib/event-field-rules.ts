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
