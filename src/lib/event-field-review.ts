/**
 * published イベントのフィールド差分レビュー。
 * - sync は差分検知のみ（本体非変更）
 * - summary は通常 sync では送らない。空の published への専用補完だけが提案する
 * - title / image_* / slug / status は対象外
 * - Phase 4C-1: visit attrs を allowlist に追加
 */
import { createHash } from 'node:crypto'
import { cleanAddressAccess } from './event-field-rules'
import { normalizeHmToDb } from './event-time-rules'
import { normalizeUrl, normalizeVenue } from './event-dedupe'
import {
  FRIENDLY_VALUES,
  PARKING_STATUSES,
  RESERVATION_STATUSES,
  PRICE_TYPES,
  VENUE_TYPES,
  type FriendlyValue,
  type ParkingStatus,
  type PriceType,
  type ReservationStatus,
  type VenueType,
} from './event-visit-attrs'

/** sync / admin でレビュー可能なフィールド（明示マップ） */
export const REVIEWABLE_FIELD_NAMES = [
  'start_date',
  'end_date',
  'start_time',
  'end_time',
  'venue',
  'area',
  'address',
  'price_text',
  'summary',
  'price_type',
  'is_kids',
  'is_indoor',
  'price_min',
  'price_max',
  'category',
  'official_url',
  'reservation_status',
  'reservation_url',
  'nearest_station',
  'access_text',
  'walk_minutes',
  'latitude',
  'longitude',
  'venue_type',
  'family_friendly',
  'date_friendly',
  'solo_friendly',
  'rain_friendly',
  'age_note',
  'duration_minutes_min',
  'duration_minutes_max',
  'parking_status',
  'parking_text',
] as const

export type ReviewableFieldName = (typeof REVIEWABLE_FIELD_NAMES)[number]

/**
 * 通常 sync は summary を proposed に含めない。
 * Walkerplus の空 summary 補完だけが、人間確認用に summary を提案する。
 */
export const SUMMARY_EXCLUDED_FROM_FIELD_REVIEW = false

/** field_name → events カラム（任意名を SQL に渡さない） */
export const REVIEWABLE_FIELD_COLUMN: Record<
  ReviewableFieldName,
  ReviewableFieldName
> = Object.fromEntries(
  REVIEWABLE_FIELD_NAMES.map((f) => [f, f]),
) as Record<ReviewableFieldName, ReviewableFieldName>

export type FieldSnapshot = {
  start_date?: string | null
  end_date?: string | null
  start_time?: string | null
  end_time?: string | null
  venue?: string | null
  area?: string | null
  address?: string | null
    price_text?: string | null
    summary?: string | null
    price_type?: PriceType | null
    is_kids?: boolean | null
    is_indoor?: boolean | null
  price_min?: number | null
  price_max?: number | null
  category?: string[] | null
  official_url?: string | null
  reservation_status?: ReservationStatus | null
  reservation_url?: string | null
  nearest_station?: string | null
  access_text?: string | null
  walk_minutes?: number | null
  latitude?: number | null
  longitude?: number | null
  venue_type?: VenueType | null
  family_friendly?: FriendlyValue | null
  date_friendly?: FriendlyValue | null
  solo_friendly?: FriendlyValue | null
  rain_friendly?: FriendlyValue | null
  age_note?: string | null
  duration_minutes_min?: number | null
  duration_minutes_max?: number | null
  parking_status?: ParkingStatus | null
  parking_text?: string | null
}

export type FieldDiff = {
  field_name: ReviewableFieldName
  current_value: unknown
  proposed_value: unknown
  proposal_hash: string
  reason: string
}

export function isReviewableFieldName(
  value: unknown,
): value is ReviewableFieldName {
  return (
    typeof value === 'string' &&
    (REVIEWABLE_FIELD_NAMES as readonly string[]).includes(value)
  )
}

function normalizeDateYmd(value: unknown): string | null {
  if (value == null) return null
  const s = String(value).trim()
  if (!s) return null
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

function normalizeWhitespaceText(value: unknown): string | null {
  if (value == null) return null
  const s = String(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return s || null
}

function normalizeCategory(value: unknown): string[] | null {
  if (value == null) return null
  if (!Array.isArray(value)) return null
  const items = [
    ...new Set(
      value
        .map((v) => String(v).trim())
        .filter((s) => s.length > 0),
    ),
  ].sort((a, b) => a.localeCompare(b))
  return items.length > 0 ? items : null
}

function normalizeAreaSlug(value: unknown): string | null {
  if (value == null) return null
  const s = String(value).trim().toLowerCase()
  return s || null
}

function normalizeInt(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null
  return n
}

function normalizeNum(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return null
  return n
}

function normalizeEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  if (value == null) return null
  const s = String(value).trim()
  if (!s) return null
  return (allowed as readonly string[]).includes(s) ? (s as T) : null
}

/** 比較キー（正規化後）。表示用とは別に使う */
export function normalizeFieldForCompare(
  field: ReviewableFieldName,
  value: unknown,
): unknown {
  switch (field) {
    case 'start_date':
    case 'end_date':
      return normalizeDateYmd(value)
    case 'start_time':
    case 'end_time':
      return normalizeHmToDb(value == null ? null : String(value))
    case 'venue': {
      const v = normalizeVenue(value == null ? null : String(value))
      return v || null
    }
    case 'area':
      return normalizeAreaSlug(value)
    case 'address': {
      const cleaned = cleanAddressAccess(
        value == null ? null : String(value),
      )
      if (!cleaned) return null
      return (
        cleaned
          .normalize('NFKC')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase() || null
      )
    }
    case 'price_text':
    case 'summary':
    case 'nearest_station':
    case 'access_text':
    case 'age_note':
    case 'parking_text':
      return normalizeWhitespaceText(value)
    case 'is_kids':
    case 'is_indoor':
      if (value === true || value === false) return value
      return null
    case 'price_type':
      return normalizeEnum(value, PRICE_TYPES)
    case 'price_min':
    case 'price_max':
    case 'walk_minutes':
    case 'duration_minutes_min':
    case 'duration_minutes_max':
      return normalizeInt(value)
    case 'latitude':
    case 'longitude':
      return normalizeNum(value)
    case 'category':
      return normalizeCategory(value)
    case 'official_url':
    case 'reservation_url':
      return normalizeUrl(value == null ? null : String(value))
    case 'reservation_status':
      return normalizeEnum(value, RESERVATION_STATUSES)
    case 'venue_type':
      return normalizeEnum(value, VENUE_TYPES)
    case 'family_friendly':
    case 'date_friendly':
    case 'solo_friendly':
    case 'rain_friendly':
      return normalizeEnum(value, FRIENDLY_VALUES)
    case 'parking_status':
      return normalizeEnum(value, PARKING_STATUSES)
    default:
      return null
  }
}

/** DB / UI 向けの保存値（意味を壊さない軽い正規化） */
export function normalizeFieldForStorage(
  field: ReviewableFieldName,
  value: unknown,
): unknown {
  switch (field) {
    case 'start_date':
    case 'end_date':
      return normalizeDateYmd(value)
    case 'start_time':
    case 'end_time':
      return normalizeHmToDb(value == null ? null : String(value))
    case 'venue': {
      if (value == null) return null
      const s = String(value).normalize('NFKC').replace(/\s+/g, ' ').trim()
      return s || null
    }
    case 'area':
      return normalizeAreaSlug(value)
    case 'address':
      return cleanAddressAccess(value == null ? null : String(value))
    case 'price_text':
    case 'summary':
    case 'nearest_station':
    case 'access_text':
    case 'age_note':
    case 'parking_text':
      return normalizeWhitespaceText(value)
    case 'is_kids':
    case 'is_indoor':
      if (value === true || value === false) return value
      return null
    case 'price_type':
      return normalizeEnum(value, PRICE_TYPES)
    case 'price_min':
    case 'price_max':
    case 'walk_minutes':
    case 'duration_minutes_min':
    case 'duration_minutes_max':
      return normalizeInt(value)
    case 'latitude':
    case 'longitude':
      return normalizeNum(value)
    case 'category':
      return normalizeCategory(value)
    case 'official_url':
    case 'reservation_url': {
      if (value == null) return null
      const s = String(value).trim()
      return s || null
    }
    case 'reservation_status':
      return normalizeEnum(value, RESERVATION_STATUSES)
    case 'venue_type':
      return normalizeEnum(value, VENUE_TYPES)
    case 'family_friendly':
    case 'date_friendly':
    case 'solo_friendly':
    case 'rain_friendly':
      return normalizeEnum(value, FRIENDLY_VALUES)
    case 'parking_status':
      return normalizeEnum(value, PARKING_STATUSES)
    default:
      return null
  }
}

export function fieldValuesEqual(
  field: ReviewableFieldName,
  a: unknown,
  b: unknown,
): boolean {
  const na = normalizeFieldForCompare(field, a)
  const nb = normalizeFieldForCompare(field, b)
  if (na === null && nb === null) return true
  if (na === null || nb === null) return false
  if (field === 'category') {
    return JSON.stringify(na) === JSON.stringify(nb)
  }
  if (typeof na === 'number' && typeof nb === 'number') return na === nb
  if (typeof na === 'boolean' && typeof nb === 'boolean') return na === nb
  return na === nb
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as object).sort()
    return `{${keys
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`
  }
  return JSON.stringify(String(value))
}

export function hashProposedValue(
  field: ReviewableFieldName,
  proposedStorage: unknown,
): string {
  const key = normalizeFieldForCompare(field, proposedStorage)
  const payload = `${field}:${canonicalJson(key)}`
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

/**
 * published(current) vs incoming(proposed) の差分。
 * - 値あり → null は ignore（取得失敗で消さない）
 * - null → 値あり は候補
 */
export function computeFieldDiffs(
  current: FieldSnapshot,
  proposed: FieldSnapshot,
): FieldDiff[] {
  const diffs: FieldDiff[] = []

  for (const field of REVIEWABLE_FIELD_NAMES) {
    const curRaw = current[field]
    const propRaw = proposed[field]

    const curStore = normalizeFieldForStorage(field, curRaw)
    const propStore = normalizeFieldForStorage(field, propRaw)

    const propCompare = normalizeFieldForCompare(field, propStore)
    if (propCompare === null || propCompare === undefined) {
      continue
    }
    if (Array.isArray(propCompare) && propCompare.length === 0) {
      continue
    }

    if (fieldValuesEqual(field, curStore, propStore)) {
      continue
    }

    const curCompare = normalizeFieldForCompare(field, curStore)
    const curEmpty =
      curCompare === null ||
      curCompare === undefined ||
      (Array.isArray(curCompare) && curCompare.length === 0)

    const reason = curEmpty
      ? `${field}: null → value`
      : `${field}: value changed`

    diffs.push({
      field_name: field,
      current_value: curStore,
      proposed_value: propStore,
      proposal_hash: hashProposedValue(field, propStore),
      reason,
    })
  }

  return diffs
}

/** admin accept: jsonb → DB 更新値 */
export function coerceProposedToDbValue(
  field: ReviewableFieldName,
  proposed: unknown,
): unknown {
  return normalizeFieldForStorage(field, proposed)
}

/** 表示用（admin） */
export function formatFieldValueForDisplay(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : value.join(', ')
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  const s = String(value)
  return s.length === 0 ? '""' : s
}
