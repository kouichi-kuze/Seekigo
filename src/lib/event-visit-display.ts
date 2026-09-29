/**
 * Phase 4C-2: public visit-attr display helpers (null-safe, no "unknown").
 * Structured values only — do not invent missing facts.
 */

import type {
  ParkingStatus,
  ReservationStatus,
  VenueType,
} from './event-visit-attrs'

export type VisitDisplayEvent = {
  price_type?: string | null
  price_min?: number | null
  price_max?: number | null
  price_text?: string | null
  reservation_status?: string | null
  reservation_url?: string | null
  nearest_station?: string | null
  access_text?: string | null
  walk_minutes?: number | null
  venue_type?: string | null
  family_friendly?: string | null
  date_friendly?: string | null
  solo_friendly?: string | null
  rain_friendly?: string | null
  age_note?: string | null
  duration_minutes_min?: number | null
  duration_minutes_max?: number | null
  parking_status?: string | null
  parking_text?: string | null
  is_indoor?: boolean | null
  is_kids?: boolean | null
}

function formatYen(amount: number): string {
  return `${amount.toLocaleString('ja-JP')}円`
}

function finitePrice(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 入場無料だけの文は補足にしない。 */
export function admissionSupplement(
  priceText: string | null | undefined,
): string | null {
  const raw = priceText?.normalize('NFKC').trim()
  if (!raw) return null
  const body = raw.replace(/^料金[:：]\s*/, '')
  const parts = body
    .split(/(?<=[。．])/)
    .map((part) => part.trim())
    .filter(Boolean)
  const kept = parts.filter((part) => {
    const compact = part.replace(/\s+/g, '')
    return !/^(?:(?:入場|観覧|参加)(?:料(?:金)?)?(?:は|が)?)?無料[。．]?$/.test(compact)
      && !/^入場料無料[。．]?$/.test(compact)
  })
  const note = kept.join('').trim()
  return note || null
}

function structuredYenLabel(
  min: number | null,
  max: number | null,
): string | null {
  if (min != null && max != null) {
    if (min === max) return formatYen(min)
    return `${formatYen(min)}〜${formatYen(max)}`
  }
  if (min != null) return `${formatYen(min)}〜`
  if (max != null) return `〜${formatYen(max)}`
  return null
}

/** 単一金額の言い換えだけで、条件や別料金が残っていない。 */
function priceTextOnlyRestatesAmount(
  priceText: string | null | undefined,
  amount: number,
): boolean {
  const compact = priceText?.normalize('NFKC').replace(/\s+/g, '') ?? ''
  if (!compact) return true
  const withComma = amount.toLocaleString('ja-JP')
  const stripped = compact
    .replace(/^料金[:：]/, '')
    .replace(/^有料[。．]?/, '')
    .replace(/一般・?当日料金[:：]?/, '')
    .replace(/一般/, '')
    .replaceAll(withComma, '')
    .replaceAll(String(amount), '')
    .replace(/円/g, '')
    .replace(/[。．，、]/g, '')
  return stripped.length === 0
}

/** 単一金額では言い切れない残り。無料だけの文は返さない。 */
function noteBeyondSingleAmount(
  priceText: string | null | undefined,
  amount: number,
): string | null {
  if (priceTextOnlyRestatesAmount(priceText, amount)) return null
  const raw = priceText?.normalize('NFKC').trim() ?? ''
  const withComma = amount.toLocaleString('ja-JP')
  const note = raw
    .replace(/^料金[:：]\s*/, '')
    .replace(/^有料[。．]\s*/, '')
    .replaceAll(`${withComma}円`, '')
    .replaceAll(`${amount}円`, '')
    .replace(/^[。．\s]+/, '')
    .trim()
  return note || null
}

/** 料金区分。NULL は表示しない。 */
export function formatPriceClassLabel(
  priceType: string | null | undefined,
): string | null {
  switch (priceType) {
    case 'free':
      return '無料'
    case 'partially_paid':
      return '一部有料'
    case 'paid':
      return '有料'
    case 'varies':
      return '内容による'
    default:
      return null
  }
}

/** 無料一覧・無料フィルタに入れる区分。 */
export function isListedAsFreePrice(
  priceType: string | null | undefined,
): boolean {
  return priceType === 'free' || priceType === 'partially_paid'
}

/** カードの料金チップ。有料・内容による・未設定は出さない。 */
export function formatCardPriceChip(
  priceType: string | null | undefined,
  locale: 'ja' | 'en' = 'ja',
): string | null {
  if (priceType === 'free') return locale === 'en' ? 'Free' : '無料'
  if (priceType === 'partially_paid') {
    return locale === 'en' ? 'Partially paid' : '一部有料'
  }
  return null
}

/** 詳細の料金区分。具体的な金額は formatAdmissionNote。 */
export function formatAdmissionLabel(event: VisitDisplayEvent): string | null {
  return formatPriceClassLabel(event.price_type)
}

/** 区分と別に出す料金の具体。未設定でも price_text は出す。 */
export function formatAdmissionNote(event: VisitDisplayEvent): string | null {
  const text = event.price_text?.trim() || null
  if (event.price_type === 'free') return admissionSupplement(text)

  if (text) return text

  if (event.price_type !== 'paid') return null
  const min = finitePrice(event.price_min)
  const max = finitePrice(event.price_max)
  return structuredYenLabel(min, max)
}

/**
 * カードの料金1行。無料チップと重複する「無料」は出さない。
 * 単一・範囲の金額はそれを優先し、条件付きの文章は消さない。
 */
export function formatCardPriceLine(event: VisitDisplayEvent): string | null {
  const text = event.price_text?.trim() || null
  if (event.price_type === 'free') return admissionSupplement(text)

  if (event.price_type === 'paid') {
    const min = finitePrice(event.price_min)
    const max = finitePrice(event.price_max)
    const structured = structuredYenLabel(min, max)
    if (structured && min != null && max != null && min === max) {
      const note = noteBeyondSingleAmount(text, min)
      return note ? `${structured} ${note}` : structured
    }
    if (structured && !text) return structured
  }

  return text
}

const RESERVATION_PUBLIC: Partial<Record<ReservationStatus, string>> = {
  required: '予約必須',
  recommended: '事前予約推奨',
  not_required: '予約不要',
}

export function formatReservationLabel(
  status: string | null | undefined,
): string | null {
  if (!status || status === 'unknown') return null
  return RESERVATION_PUBLIC[status as ReservationStatus] ?? null
}

export function formatDurationLabel(
  min: number | null | undefined,
  max: number | null | undefined,
): string | null {
  const hasMin = typeof min === 'number' && Number.isFinite(min)
  const hasMax = typeof max === 'number' && Number.isFinite(max)
  if (!hasMin && !hasMax) return null
  if (hasMin && hasMax) {
    if (min === max) return `約${min}分`
    return `${min}〜${max}分`
  }
  if (hasMin) return `${min}分〜`
  return `〜${max}分`
}

export function formatAgeNote(
  ageNote: string | null | undefined,
): string | null {
  const t = ageNote?.trim()
  return t || null
}

const VENUE_PUBLIC: Partial<Record<VenueType, string>> = {
  indoor: '屋内',
  outdoor: '屋外',
  mixed: '屋内・屋外',
}

/** venue_type 優先。null/unknown かつ is_indoor → 屋内 fallback */
export function resolveVenueLabel(event: VisitDisplayEvent): string | null {
  const vt = event.venue_type?.trim() || null
  if (vt && vt !== 'unknown') {
    return VENUE_PUBLIC[vt as VenueType] ?? null
  }
  if (event.is_indoor === true) return '屋内'
  return null
}

function isFriendlyYes(value: string | null | undefined): boolean {
  return value === 'yes'
}

function isFriendlyNo(value: string | null | undefined): boolean {
  return value === 'no'
}

/** family_friendly=yes、または unknown/null かつ is_kids。no 時は上書きしない */
export function resolveFamilyFriendlyLabel(
  event: VisitDisplayEvent,
): string | null {
  if (isFriendlyYes(event.family_friendly)) return '子ども向け'
  if (isFriendlyNo(event.family_friendly)) return null
  if (event.is_kids === true) return '子ども向け'
  return null
}

const PARKING_PUBLIC: Partial<Record<ParkingStatus, string>> = {
  available: '駐車場あり',
  not_available: '専用駐車場なし',
  nearby: '周辺駐車場あり',
}

export function formatParkingStatusLabel(
  status: string | null | undefined,
): string | null {
  if (!status || status === 'unknown') return null
  return PARKING_PUBLIC[status as ParkingStatus] ?? null
}

export type VisitChecklistTag = {
  id: string
  label: string
}

/** 行く前チェック用タグ。yes / 確定事実のみ。no・unknown・null は出さない */
export function buildVisitChecklistTags(
  event: VisitDisplayEvent,
): VisitChecklistTag[] {
  const tags: VisitChecklistTag[] = []

  const venue = resolveVenueLabel(event)
  if (venue) tags.push({ id: 'venue', label: venue })

  const family = resolveFamilyFriendlyLabel(event)
  if (family) tags.push({ id: 'family', label: family })

  if (isFriendlyYes(event.date_friendly)) {
    tags.push({ id: 'date', label: 'デート向け' })
  }
  if (isFriendlyYes(event.solo_friendly)) {
    tags.push({ id: 'solo', label: '一人でも行きやすい' })
  }
  if (isFriendlyYes(event.rain_friendly)) {
    tags.push({ id: 'rain', label: '雨の日OK' })
  }

  if (event.reservation_status === 'required') {
    tags.push({ id: 'reservation', label: '予約必須' })
  } else if (event.reservation_status === 'not_required') {
    tags.push({ id: 'reservation', label: '予約不要' })
  }

  const priceClass = formatPriceClassLabel(event.price_type)
  if (priceClass) {
    tags.push({ id: 'price', label: priceClass })
  }

  if (
    typeof event.walk_minutes === 'number' &&
    Number.isFinite(event.walk_minutes) &&
    event.walk_minutes >= 0
  ) {
    tags.push({ id: 'walk', label: `駅徒歩${event.walk_minutes}分` })
  }

  if (event.parking_status === 'available') {
    tags.push({ id: 'parking', label: '駐車場あり' })
  }

  return tags
}

function normalizeAccessCompare(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
}

/**
 * nearest_station + walk_minutes があるとき、
 * access_text がそれらを述べているだけなら二重表示しない。
 */
export function shouldShowAccessText(
  nearestStation: string | null | undefined,
  walkMinutes: number | null | undefined,
  accessText: string | null | undefined,
): boolean {
  const text = accessText?.trim()
  if (!text) return false

  const station = nearestStation?.trim() || null
  const hasWalk =
    typeof walkMinutes === 'number' && Number.isFinite(walkMinutes)

  if (!station || !hasWalk) return true

  const t = normalizeAccessCompare(text)
  const st = normalizeAccessCompare(station)
  if (!t.includes(st)) return true
  if (!t.includes(String(walkMinutes))) return true
  if (!t.includes('徒歩')) return true
  return false
}

export type AccessSectionModel = {
  nearestStation: string | null
  walkMinutes: number | null
  walkLabel: string | null
  accessText: string | null
  parkingLabel: string | null
  parkingText: string | null
}

export function buildAccessSection(
  event: VisitDisplayEvent,
): AccessSectionModel | null {
  const nearestStation = event.nearest_station?.trim() || null
  const walkMinutes =
    typeof event.walk_minutes === 'number' &&
    Number.isFinite(event.walk_minutes)
      ? event.walk_minutes
      : null
  const walkLabel =
    walkMinutes != null ? `徒歩約${walkMinutes}分` : null
  const accessText = shouldShowAccessText(
    nearestStation,
    walkMinutes,
    event.access_text,
  )
    ? event.access_text!.trim()
    : null
  const parkingLabel = formatParkingStatusLabel(event.parking_status)
  const parkingText = event.parking_text?.trim() || null

  if (
    !nearestStation &&
    !walkLabel &&
    !accessText &&
    !parkingLabel &&
    !parkingText
  ) {
    return null
  }

  return {
    nearestStation,
    walkMinutes,
    walkLabel,
    accessText,
    parkingLabel,
    parkingText,
  }
}

export function hasBasicVisitFacts(event: VisitDisplayEvent): boolean {
  return Boolean(
    formatAdmissionLabel(event) ||
      formatReservationLabel(event.reservation_status) ||
      formatAgeNote(event.age_note) ||
      formatDurationLabel(
        event.duration_minutes_min,
        event.duration_minutes_max,
      ) ||
      (event.reservation_url && event.reservation_url.trim()),
  )
}
