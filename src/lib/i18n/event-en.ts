/**
 * Phase 4C-5: English formatters for structured event visit attrs.
 * Free-text JA fields are not translated here.
 */
import type {
  ParkingStatus,
  ReservationStatus,
  VenueType,
} from '../event-visit-attrs'
import type {
  AccessSectionModel,
  VisitChecklistTag,
  VisitDisplayEvent,
} from '../event-visit-display'
import {
  shouldShowAccessText,
} from '../event-visit-display'

function formatYenEn(amount: number): string {
  return `¥${amount.toLocaleString('en-US')}`
}

export function formatReservationStatusEn(
  status: string | null | undefined,
): string | null {
  if (!status || status === 'unknown') return null
  const map: Partial<Record<ReservationStatus, string>> = {
    required: 'Reservation required',
    recommended: 'Advance booking recommended',
    not_required: 'No reservation required',
  }
  return map[status as ReservationStatus] ?? null
}

export function formatVenueTypeEn(
  venueType: string | null | undefined,
): string | null {
  if (!venueType || venueType === 'unknown') return null
  const map: Partial<Record<VenueType, string>> = {
    indoor: 'Indoor',
    outdoor: 'Outdoor',
    mixed: 'Indoor & outdoor',
  }
  return map[venueType as VenueType] ?? null
}

export function formatFriendlyEn(
  kind: 'family' | 'date' | 'solo' | 'rain',
  value: string | null | undefined,
): string | null {
  if (value !== 'yes') return null
  switch (kind) {
    case 'family':
      return 'Family-friendly'
    case 'date':
      return 'Good for dates'
    case 'solo':
      return 'Good for solo visitors'
    case 'rain':
      return 'Good for rainy days'
    default:
      return null
  }
}

export function formatParkingStatusEn(
  status: string | null | undefined,
): string | null {
  if (!status || status === 'unknown') return null
  const map: Partial<Record<ParkingStatus, string>> = {
    available: 'Parking available',
    not_available: 'No dedicated parking',
    nearby: 'Nearby parking available',
  }
  return map[status as ParkingStatus] ?? null
}

export function formatPriceClassEn(
  priceType: string | null | undefined,
): string | null {
  switch (priceType) {
    case 'free':
      return 'Free'
    case 'partially_paid':
      return 'Partially paid'
    case 'paid':
      return 'Paid'
    case 'varies':
      return 'Varies'
    default:
      return null
  }
}

/** 有料かつ数値があるときだけ金額。区分そのものや price_text は返さない。 */
export function formatPriceEn(event: VisitDisplayEvent): string | null {
  if (event.price_type !== 'paid') return null

  const min =
    typeof event.price_min === 'number' && Number.isFinite(event.price_min)
      ? event.price_min
      : null
  const max =
    typeof event.price_max === 'number' && Number.isFinite(event.price_max)
      ? event.price_max
      : null

  if (min != null && max != null) {
    if (min === max) return formatYenEn(min)
    return `${formatYenEn(min)}–${formatYenEn(max)}`
  }
  if (min != null) return `From ${formatYenEn(min)}`
  if (max != null) return `Up to ${formatYenEn(max)}`
  return null
}

export function formatDurationEn(
  min: number | null | undefined,
  max: number | null | undefined,
): string | null {
  const hasMin = typeof min === 'number' && Number.isFinite(min)
  const hasMax = typeof max === 'number' && Number.isFinite(max)
  if (!hasMin && !hasMax) return null
  if (hasMin && hasMax) {
    if (min === max) return `About ${min} min`
    return `${min}–${max} min`
  }
  if (hasMin) return `From ${min} min`
  return `Up to ${max} min`
}

export function formatWalkMinutesEn(
  minutes: number | null | undefined,
): string | null {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) {
    return null
  }
  return `About ${minutes} min walk`
}

export function formatWalkTagEn(
  minutes: number | null | undefined,
): string | null {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) {
    return null
  }
  return `${minutes} min walk from station`
}

function parseYmdParts(ymd: string): { y: number; m: number; d: number } | null {
  const m = ymd.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
}

function formatEnDay(parts: { y: number; m: number; d: number }): string {
  const date = new Date(Date.UTC(parts.y, parts.m - 1, parts.d, 12, 0, 0))
  return new Intl.DateTimeFormat('en', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

function formatEnDayShort(parts: { y: number; m: number; d: number }): string {
  const date = new Date(Date.UTC(parts.y, parts.m - 1, parts.d, 12, 0, 0))
  return new Intl.DateTimeFormat('en', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

/** e.g. September 8, 2026 or September 8–30, 2026 */
export function formatEventDateRangeEn(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): string | null {
  if (!startDate) return null
  const start = parseYmdParts(startDate)
  if (!start) return startDate

  if (!endDate || endDate === startDate) {
    return formatEnDay(start)
  }
  const end = parseYmdParts(endDate)
  if (!end) return `${formatEnDay(start)} – ${endDate}`

  if (start.y === end.y && start.m === end.m) {
    const month = new Intl.DateTimeFormat('en', {
      month: 'long',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(start.y, start.m - 1, 1)))
    return `${month} ${start.d}–${end.d}, ${start.y}`
  }
  if (start.y === end.y) {
    return `${formatEnDayShort(start)} – ${formatEnDay(end)}`
  }
  return `${formatEnDay(start)} – ${formatEnDay(end)}`
}

function formatClockEn(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})/)
  if (!m) return null
  let h = Number(m[1])
  const min = m[2]
  if (!Number.isFinite(h) || h < 0 || h > 23) return null
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${min} ${ampm}`
}

/** Japan local wall-clock as 10:00 AM–6:00 PM */
export function formatEventTimeRangeEn(
  startTime: string | null | undefined,
  endTime: string | null | undefined,
): string | null {
  const start = startTime?.trim() ? formatClockEn(startTime) : null
  const end = endTime?.trim() ? formatClockEn(endTime) : null
  if (!start && !end) return null
  if (start && end) return `${start}–${end}`
  return start ?? end
}

/** 開催回の1枠。開始だけなら末尾にダッシュを残す。 */
export function formatOccurrenceTimeEn(
  startTime: string | null | undefined,
  endTime: string | null | undefined,
): string | null {
  const start = startTime?.trim() ? formatClockEn(startTime) : null
  const end = endTime?.trim() ? formatClockEn(endTime) : null
  if (start && end) return `${start}–${end}`
  if (start) return `${start}–`
  if (end) return `–${end}`
  return null
}

function resolveVenueLabelEn(event: VisitDisplayEvent): string | null {
  const fromType = formatVenueTypeEn(event.venue_type)
  if (fromType) return fromType
  if (event.is_indoor === true) return 'Indoor'
  return null
}

function resolveFamilyLabelEn(event: VisitDisplayEvent): string | null {
  if (event.family_friendly === 'yes') return 'Family-friendly'
  if (event.family_friendly === 'no') return null
  if (event.is_kids === true) return 'Family-friendly'
  return null
}

export function buildVisitChecklistTagsEn(
  event: VisitDisplayEvent,
): VisitChecklistTag[] {
  const tags: VisitChecklistTag[] = []

  const venue = resolveVenueLabelEn(event)
  if (venue) tags.push({ id: 'venue', label: venue })

  const family = resolveFamilyLabelEn(event)
  if (family) tags.push({ id: 'family', label: family })

  const date = formatFriendlyEn('date', event.date_friendly)
  if (date) tags.push({ id: 'date', label: date })

  const solo = formatFriendlyEn('solo', event.solo_friendly)
  if (solo) tags.push({ id: 'solo', label: solo })

  const rain = formatFriendlyEn('rain', event.rain_friendly)
  if (rain) tags.push({ id: 'rain', label: rain })

  if (event.reservation_status === 'required') {
    tags.push({ id: 'reservation', label: 'Reservation required' })
  } else if (event.reservation_status === 'not_required') {
    tags.push({ id: 'reservation', label: 'No reservation required' })
  }

  const priceClass = formatPriceClassEn(event.price_type)
  if (priceClass) {
    tags.push({ id: 'price', label: priceClass })
  }

  const walk = formatWalkTagEn(event.walk_minutes)
  if (walk) tags.push({ id: 'walk', label: walk })

  if (event.parking_status === 'available') {
    tags.push({ id: 'parking', label: 'Parking available' })
  }

  return tags
}

/** EN: hide access_text when it only restates station + walk minutes. */
export function shouldShowAccessTextEn(
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

  const t = text.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
  const st = station.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
  if (!t.includes(st)) return true
  if (!t.includes(String(walkMinutes))) return true
  if (!/(walk|minute|min\.?)/i.test(text)) return true
  return false
}

/**
 * EN access model: structured values + optional published EN free-text.
 * Does not show Japanese free text.
 */
export function buildAccessSectionEn(
  event: VisitDisplayEvent,
  opts?: {
    accessTextEn?: string | null
    parkingTextEn?: string | null
  },
): AccessSectionModel | null {
  const nearestStation = event.nearest_station?.trim() || null
  const walkMinutes =
    typeof event.walk_minutes === 'number' &&
    Number.isFinite(event.walk_minutes)
      ? event.walk_minutes
      : null
  const walkLabel = formatWalkMinutesEn(walkMinutes)
  const parkingLabel = formatParkingStatusEn(event.parking_status)
  const accessText = shouldShowAccessTextEn(
    nearestStation,
    walkMinutes,
    opts?.accessTextEn,
  )
    ? opts!.accessTextEn!.trim()
    : null
  const parkingText = opts?.parkingTextEn?.trim() || null

  void shouldShowAccessText

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

export const EVENT_UI_EN = {
  basics: 'Basics',
  dates: 'Dates',
  hours: 'Hours',
  venue: 'Venue',
  address: 'Address',
  admission: 'Admission',
  reservation: 'Reservation',
  age: 'Age / Eligibility',
  duration: 'Duration',
  beforeYouGo: 'Before you go',
  access: 'Access',
  nearestStation: 'Nearest station',
  fromStation: 'From station',
  parking: 'Parking',
  venueMap: 'Venue map',
  openMap: 'Open in Google Maps',
  directions: 'Directions from your current location',
  openMapHint: 'Open map',
  reactions: 'What people are saying',
  officialCta: 'Visit the official website',
  organizerHeading: 'Event organizers',
  organizerBody:
    'Seekigo lists events based on publicly available information. If you would like to confirm listing details, share official images, or request updates, please contact us.',
  organizerCta: 'Contact us about this listing',
  backToList: '← Back to Tokyo events',
  notFound: 'Event not found.',
  breadcrumbTokyo: 'Tokyo events',
  breadcrumbNav: 'Breadcrumb',
  night: 'Night',
  ended: 'Ended',
  happeningToday: 'Happening Today',
  upcoming: 'Upcoming',
  free: 'Free',
  partiallyPaid: 'Partially paid',
  paid: 'Paid',
  varies: 'Varies',
  forKids: 'For kids',
  indoor: 'Indoor',
  reservationLink: 'Open reservation page',
  hoursNote: 'Japan Standard Time (JST)',
  source: 'Source',
  overview: 'Overview',
  relatedCurrent: 'You may also like',
  relatedEnded: 'More events to explore',
  illustrativeImage: 'Illustrative image',
} as const
