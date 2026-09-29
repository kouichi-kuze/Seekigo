/**
 * Phase 4C-1: visit / decision attributes on events.
 * Structured values for JA/EN UI later. Do not invent via AI alone.
 */

export const RESERVATION_STATUSES = [
  'required',
  'recommended',
  'not_required',
  'unknown',
] as const
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number]

export const VENUE_TYPES = ['indoor', 'outdoor', 'mixed', 'unknown'] as const
export type VenueType = (typeof VENUE_TYPES)[number]

export const FRIENDLY_VALUES = ['yes', 'no', 'unknown'] as const
export type FriendlyValue = (typeof FRIENDLY_VALUES)[number]

export const PARKING_STATUSES = [
  'available',
  'not_available',
  'nearby',
  'unknown',
] as const
export type ParkingStatus = (typeof PARKING_STATUSES)[number]

/** 料金区分。未設定は NULL。unknown は持たない。 */
export const PRICE_TYPES = ['free', 'partially_paid', 'paid', 'varies'] as const
export type PriceType = (typeof PRICE_TYPES)[number]

/** New + related columns for admin select / mappers */
export const EVENT_VISIT_ATTR_COLUMNS = [
  'price_min',
  'price_max',
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
  'price_type',
] as const

export type EventVisitAttrs = {
  price_min?: number | null
  price_max?: number | null
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
  price_type?: PriceType | null
}

export function parseTriBool(raw: string): boolean | null {
  const s = raw.trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes') return true
  if (s === 'false' || s === '0' || s === 'no') return false
  return null
}

export function parseEnumValue<T extends string>(
  raw: string,
  allowed: readonly T[],
): T | null {
  const s = raw.trim()
  if (!s) return null
  return (allowed as readonly string[]).includes(s) ? (s as T) : null
}

export function parseOptionalInt(raw: string): number | null {
  const s = raw.trim()
  if (!s) return null
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null
  return n
}

export function parseOptionalNumber(raw: string): number | null {
  const s = raw.trim()
  if (!s) return null
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return n
}

export function friendlySelectValue(
  value: FriendlyValue | null | undefined,
): string {
  return value ?? ''
}
