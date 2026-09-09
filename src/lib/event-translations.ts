/**
 * Phase 4C-6: event / reaction free-text translations.
 */
import { parseSummaryBullets } from './event-reaction-summary'

export const TRANSLATION_LOCALES = ['en'] as const
export type TranslationLocale = (typeof TRANSLATION_LOCALES)[number]

export const TRANSLATION_STATUSES = ['draft', 'published', 'hidden'] as const
export type TranslationStatus = (typeof TRANSLATION_STATUSES)[number]

export type EventTranslationRow = {
  id: number
  event_id: number
  locale: string
  title: string | null
  summary: string | null
  access_text: string | null
  price_text: string | null
  age_note: string | null
  parking_text: string | null
  status: TranslationStatus
  generated_at: string | null
  reviewed_at: string | null
  reviewed_by: string | null
  created_at: string
  updated_at: string
}

export type ReactionSummaryTranslationRow = {
  id: number
  summary_id: number
  locale: string
  summary_bullets: string[]
  status: TranslationStatus
  generated_at: string | null
  reviewed_at: string | null
  reviewed_by: string | null
  created_at: string
  updated_at: string
}

export const EVENT_TRANSLATION_SELECT =
  'id, event_id, locale, title, summary, access_text, price_text, age_note, parking_text, status, generated_at, reviewed_at, reviewed_by, created_at, updated_at'

export const REACTION_TRANSLATION_SELECT =
  'id, summary_id, locale, summary_bullets, status, generated_at, reviewed_at, reviewed_by, created_at, updated_at'

export function isTranslationStatus(value: unknown): value is TranslationStatus {
  return (TRANSLATION_STATUSES as readonly string[]).includes(String(value))
}

export function mapEventTranslationRow(
  data: Record<string, unknown>,
): EventTranslationRow {
  return {
    id: Number(data.id),
    event_id: Number(data.event_id),
    locale: String(data.locale ?? 'en'),
    title: (data.title as string | null) ?? null,
    summary: (data.summary as string | null) ?? null,
    access_text: (data.access_text as string | null) ?? null,
    price_text: (data.price_text as string | null) ?? null,
    age_note: (data.age_note as string | null) ?? null,
    parking_text: (data.parking_text as string | null) ?? null,
    status: isTranslationStatus(data.status) ? data.status : 'draft',
    generated_at: (data.generated_at as string | null) ?? null,
    reviewed_at: (data.reviewed_at as string | null) ?? null,
    reviewed_by: (data.reviewed_by as string | null) ?? null,
    created_at: String(data.created_at ?? ''),
    updated_at: String(data.updated_at ?? ''),
  }
}

export function mapReactionTranslationRow(
  data: Record<string, unknown>,
): ReactionSummaryTranslationRow {
  return {
    id: Number(data.id),
    summary_id: Number(data.summary_id),
    locale: String(data.locale ?? 'en'),
    summary_bullets: parseSummaryBullets(data.summary_bullets),
    status: isTranslationStatus(data.status) ? data.status : 'draft',
    generated_at: (data.generated_at as string | null) ?? null,
    reviewed_at: (data.reviewed_at as string | null) ?? null,
    reviewed_by: (data.reviewed_by as string | null) ?? null,
    created_at: String(data.created_at ?? ''),
    updated_at: String(data.updated_at ?? ''),
  }
}

/** Public SSG: published translation only */
export async function fetchPublishedEventTranslation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: { from: (table: string) => any },
  eventId: number,
  locale: string = 'en',
): Promise<EventTranslationRow | null> {
  const { data, error } = await client
    .from('event_translations')
    .select(EVENT_TRANSLATION_SELECT)
    .eq('event_id', eventId)
    .eq('locale', locale)
    .eq('status', 'published')
    .maybeSingle()

  if (error) {
    const msg = error.message ?? ''
    if (
      /does not exist|PGRST205|schema cache|Could not find the table/i.test(msg)
    ) {
      return null
    }
    console.error('[event-translations]', msg)
    return null
  }
  if (!data) return null
  return mapEventTranslationRow(data as Record<string, unknown>)
}

export async function fetchPublishedReactionTranslation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: { from: (table: string) => any },
  summaryId: number,
  locale: string = 'en',
): Promise<ReactionSummaryTranslationRow | null> {
  const { data, error } = await client
    .from('event_reaction_summary_translations')
    .select(REACTION_TRANSLATION_SELECT)
    .eq('summary_id', summaryId)
    .eq('locale', locale)
    .eq('status', 'published')
    .maybeSingle()

  if (error) {
    const msg = error.message ?? ''
    if (
      /does not exist|PGRST205|schema cache|Could not find the table/i.test(msg)
    ) {
      return null
    }
    console.error('[reaction-translations]', msg)
    return null
  }
  if (!data) return null
  const row = mapReactionTranslationRow(data as Record<string, unknown>)
  if (row.summary_bullets.length === 0) return null
  return row
}
