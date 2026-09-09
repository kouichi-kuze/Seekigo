/**
 * Phase 4C-3: Google Maps destination / URL helpers.
 * - Prefer lat/lng over address
 * - Never persist Maps URLs in DB
 * - No navigator.geolocation (Maps handles current location)
 * - Programmatic iframe without API key is unstable; embed only with optional Embed API key
 */

export type EventMapInput = {
  latitude?: number | null
  longitude?: number | null
  address?: string | null
  venue?: string | null
}

export type EventMapDestination =
  | {
      kind: 'latlng'
      latitude: number
      longitude: number
      /** Maps query string (lat,lng) */
      query: string
    }
  | {
      kind: 'address'
      query: string
    }

function asFiniteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function isValidLatLng(lat: number, lng: number): boolean {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

/** lat/lng 両方有効なら優先。なければ address。どちらもなければ null */
export function getEventMapDestination(
  event: EventMapInput,
): EventMapDestination | null {
  const lat = asFiniteNumber(event.latitude)
  const lng = asFiniteNumber(event.longitude)
  if (lat != null && lng != null && isValidLatLng(lat, lng)) {
    return {
      kind: 'latlng',
      latitude: lat,
      longitude: lng,
      query: `${lat},${lng}`,
    }
  }

  const address = event.address?.trim() || null
  if (address) {
    return { kind: 'address', query: address }
  }

  return null
}

/** https://www.google.com/maps/search/?api=1&query=... */
export function getGoogleMapsSearchUrl(event: EventMapInput): string | null {
  const dest = getEventMapDestination(event)
  if (!dest) return null
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(dest.query)}`
}

/**
 * origin なし → Google Maps 側で現在地を起点にできる。
 * travelmode 固定なし。
 */
export function getGoogleMapsDirectionsUrl(
  event: EventMapInput,
): string | null {
  const dest = getEventMapDestination(event)
  if (!dest) return null
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest.query)}`
}

/**
 * 埋め込み URL。
 * - PUBLIC_GOOGLE_MAPS_EMBED_API_KEY があるときのみ公式 Embed API を返す
 * - キーなしの output=embed は現行で iframe 不可（X-Frame-Options）のため null
 */
export function getGoogleMapsEmbedUrl(
  event: EventMapInput,
  apiKey?: string | null,
  opts?: { language?: 'ja' | 'en' },
): string | null {
  const dest = getEventMapDestination(event)
  if (!dest) return null

  const key = apiKey?.trim() || null
  if (!key) return null

  const language = opts?.language === 'en' ? 'en' : 'ja'
  return `https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(key)}&q=${encodeURIComponent(dest.query)}&zoom=15&language=${encodeURIComponent(language)}`
}

export type EventMapModel = {
  destination: EventMapDestination
  searchUrl: string
  directionsUrl: string
  embedUrl: string | null
  /** カード上の補足（住所 or 座標） */
  label: string
  venue: string | null
}

export function buildEventMapModel(
  event: EventMapInput,
  opts?: { embedApiKey?: string | null; locale?: 'ja' | 'en' },
): EventMapModel | null {
  const destination = getEventMapDestination(event)
  const searchUrl = getGoogleMapsSearchUrl(event)
  const directionsUrl = getGoogleMapsDirectionsUrl(event)
  if (!destination || !searchUrl || !directionsUrl) return null

  const embedUrl = getGoogleMapsEmbedUrl(event, opts?.embedApiKey ?? null, {
    language: opts?.locale === 'en' ? 'en' : 'ja',
  })
  const venue = event.venue?.trim() || null
  const label =
    destination.kind === 'address'
      ? destination.query
      : event.address?.trim() || destination.query

  return {
    destination,
    searchUrl,
    directionsUrl,
    embedUrl,
    label,
    venue,
  }
}
