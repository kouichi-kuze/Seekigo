/**
 * Phase 4C-4: visit-attrs enrichment types.
 */

import type {
  FriendlyValue,
  ParkingStatus,
  ReservationStatus,
  VenueType,
} from '../../../src/lib/event-visit-attrs'

export type VisitConfidence = 'high' | 'medium' | 'low'

export type VisitFieldName =
  | 'is_free'
  | 'price_min'
  | 'price_max'
  | 'price_text'
  | 'reservation_status'
  | 'reservation_url'
  | 'nearest_station'
  | 'walk_minutes'
  | 'access_text'
  | 'venue_type'
  | 'family_friendly'
  | 'date_friendly'
  | 'solo_friendly'
  | 'rain_friendly'
  | 'age_note'
  | 'duration_minutes_min'
  | 'duration_minutes_max'
  | 'parking_status'
  | 'parking_text'

export type VisitProposedValue =
  | boolean
  | number
  | string
  | ReservationStatus
  | VenueType
  | FriendlyValue
  | ParkingStatus
  | null

export type VisitFieldProposal = {
  field: VisitFieldName
  proposed_value: VisitProposedValue
  confidence: VisitConfidence
  reason: string
  evidence_text: string
  source_url: string | null
  method: 'jsonld' | 'deterministic' | 'ai_assist'
}

export type FetchedSource = {
  role: 'official' | 'source' | 'reaction_official'
  url: string
  finalUrl: string
  ok: boolean
  reason?: string
  skipped?: boolean
  title?: string | null
  textExcerpt?: string
  htmlLength?: number
}

export type VisitEnrichEventRow = {
  id: number
  title: string | null
  status: string | null
  official_url: string | null
  source_url: string | null
  price_text: string | null
  is_free: boolean | null
  price_min: number | null
  price_max: number | null
  address: string | null
  venue: string | null
  category: string[] | null
  reservation_status: string | null
  reservation_url: string | null
  nearest_station: string | null
  walk_minutes: number | null
  access_text: string | null
  venue_type: string | null
  family_friendly: string | null
  date_friendly: string | null
  solo_friendly: string | null
  rain_friendly: string | null
  age_note: string | null
  duration_minutes_min: number | null
  duration_minutes_max: number | null
  parking_status: string | null
  parking_text: string | null
}
