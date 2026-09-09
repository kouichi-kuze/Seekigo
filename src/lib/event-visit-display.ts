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
  is_free?: boolean | null
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

/** 入場料。不明は null（公開側は行ごと非表示） */
export function formatAdmissionLabel(event: VisitDisplayEvent): string | null {
  if (event.is_free === true) return '無料'

  if (event.is_free === false) {
    const min =
      typeof event.price_min === 'number' && Number.isFinite(event.price_min)
        ? event.price_min
        : null
    const max =
      typeof event.price_max === 'number' && Number.isFinite(event.price_max)
        ? event.price_max
        : null

    if (min != null && max != null) {
      if (min === max) return formatYen(min)
      return `${formatYen(min)}〜${formatYen(max)}`
    }
    if (min != null) return `${formatYen(min)}〜`
    if (max != null) return `〜${formatYen(max)}`
  }

  const text = event.price_text?.trim()
  return text || null
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

  if (event.is_free === true) {
    tags.push({ id: 'free', label: '無料' })
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
