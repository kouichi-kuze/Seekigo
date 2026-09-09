/**
 * DEV admin: English translation draft generate / save / publish / hide.
 * Browser never calls OpenAI — server-side POST only.
 */
import OpenAI from 'openai'
import { createAdminClient } from './supabase-admin'
import {
  parsePositiveIntIds,
  readAdminPostForm,
  verifyAdminCsrf,
} from './admin-security'
import {
  EVENT_TRANSLATION_SELECT,
  REACTION_TRANSLATION_SELECT,
  mapEventTranslationRow,
  mapReactionTranslationRow,
  type EventTranslationRow,
  type ReactionSummaryTranslationRow,
} from './event-translations'
import {
  resolveEventTranslateModel,
  translateEventFieldsWithAi,
  translateReactionBulletsWithAi,
  type EventTranslateFields,
} from './event-translate-ai'
import { bulletsFromTextarea } from './event-reaction-summary'
import { discoverOfficialEnglishTitle } from '../../scripts/lib/translate/official-title'

type AdminCookies = {
  get: (name: string) => { value: string } | undefined
}

export type AdminTranslateResult =
  | { ok: true; redirectTo: string }
  | { ok: false; message: string }

const TRANSLATION_INTENTS = [
  'translation_ai_generate',
  'translation_save',
  'translation_publish',
  'translation_hide',
] as const

export function isTranslationIntent(intent: string): boolean {
  return (TRANSLATION_INTENTS as readonly string[]).includes(intent)
}

function logTranslate(
  details: Record<string, string | number | boolean | null | undefined>,
): void {
  if (!import.meta.env.DEV) return
  console.info('[admin/event-translate] POST', details)
}

function nullTrim(value: FormDataEntryValue | null): string | null {
  const t = String(value ?? '').trim()
  return t ? t : null
}

function readFieldsFromForm(form: FormData): EventTranslateFields {
  return {
    title: nullTrim(form.get('tr_title')),
    summary: nullTrim(form.get('tr_summary')),
    access_text: nullTrim(form.get('tr_access_text')),
    price_text: nullTrim(form.get('tr_price_text')),
    age_note: nullTrim(form.get('tr_age_note')),
    parking_text: nullTrim(form.get('tr_parking_text')),
  }
}

async function processTranslationAiGenerate(opts: {
  eventId: number
  force: boolean
  translateReaction: boolean
}): Promise<AdminTranslateResult> {
  const { eventId, force, translateReaction } = opts
  const returnTo = `/admin/events/${eventId}/`
  const admin = createAdminClient()
  const locale = 'en'

  const { data: existing, error: exErr } = await admin
    .from('event_translations')
    .select('id, status')
    .eq('event_id', eventId)
    .eq('locale', locale)
    .maybeSingle()
  if (exErr) return { ok: false, message: exErr.message }

  const status = existing ? String(existing.status ?? 'draft') : null
  if ((status === 'published' || status === 'hidden') && !force) {
    logTranslate({
      intent: 'translation_ai_generate',
      event_id: eventId,
      ok: false,
      reason: `status_${status}_needs_force`,
    })
    return {
      ok: false,
      message: `英語翻訳が ${status} のため上書きしません（force が必要）`,
    }
  }

  const { data: event, error: evErr } = await admin
    .from('events')
    .select(
      'id, title, summary, access_text, price_text, age_note, parking_text, venue, official_url',
    )
    .eq('id', eventId)
    .maybeSingle()
  if (evErr) return { ok: false, message: evErr.message }
  if (!event) return { ok: false, message: 'Event not found' }

  const source: EventTranslateFields = {
    title: (event.title as string | null)?.trim() || null,
    summary: (event.summary as string | null)?.trim() || null,
    access_text: (event.access_text as string | null)?.trim() || null,
    price_text: (event.price_text as string | null)?.trim() || null,
    age_note: (event.age_note as string | null)?.trim() || null,
    parking_text: (event.parking_text as string | null)?.trim() || null,
  }

  const apiKey =
    import.meta.env.OPENAI_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    return { ok: false, message: 'OPENAI_API_KEY が未設定です' }
  }

  const official = await discoverOfficialEnglishTitle(
    (event.official_url as string | null) ?? null,
  )
  const model = resolveEventTranslateModel()
  const openai = new OpenAI({ apiKey })

  try {
    const result = await translateEventFieldsWithAi(openai, model, source, {
      official_english_title: official.title,
      venue: (event.venue as string | null) ?? null,
    })
    const now = new Date().toISOString()
    const patch = {
      event_id: eventId,
      locale,
      ...result.fields,
      status: 'draft' as const,
      generated_at: now,
      updated_at: now,
    }

    if (existing) {
      const { error: upErr } = await admin
        .from('event_translations')
        .update(patch)
        .eq('id', existing.id)
      if (upErr) return { ok: false, message: upErr.message }
    } else {
      const { error: insErr } = await admin
        .from('event_translations')
        .insert(patch)
      if (insErr) return { ok: false, message: insErr.message }
    }

    if (translateReaction) {
      const { data: sum } = await admin
        .from('event_reaction_summaries')
        .select('id, status, summary_bullets')
        .eq('event_id', eventId)
        .eq('status', 'published')
        .maybeSingle()
      if (sum) {
        const summaryId = Number(sum.id)
        const bulletsJa = Array.isArray(sum.summary_bullets)
          ? (sum.summary_bullets as unknown[])
              .map((b) => String(b ?? '').trim())
              .filter(Boolean)
              .slice(0, 5)
          : []
        const { data: rxExisting } = await admin
          .from('event_reaction_summary_translations')
          .select('id, status')
          .eq('summary_id', summaryId)
          .eq('locale', locale)
          .maybeSingle()
        const rxStatus = rxExisting
          ? String(rxExisting.status ?? 'draft')
          : null
        if (
          (rxStatus === 'published' || rxStatus === 'hidden') &&
          !force
        ) {
          logTranslate({
            intent: 'translation_ai_generate',
            event_id: eventId,
            reaction_skip: `status_${rxStatus}`,
          })
        } else if (bulletsJa.length) {
          const rx = await translateReactionBulletsWithAi(
            openai,
            model,
            bulletsJa,
          )
          const rxPatch = {
            summary_id: summaryId,
            locale,
            summary_bullets: rx.summary_bullets,
            status: 'draft' as const,
            generated_at: now,
            updated_at: now,
          }
          if (rxExisting) {
            await admin
              .from('event_reaction_summary_translations')
              .update(rxPatch)
              .eq('id', rxExisting.id)
          } else {
            await admin
              .from('event_reaction_summary_translations')
              .insert(rxPatch)
          }
        }
      }
    }

    logTranslate({
      intent: 'translation_ai_generate',
      event_id: eventId,
      ok: true,
      model: result.model,
      estimated_cost: result.usage.estimated_cost_display,
      prompt_tokens: result.usage.prompt_tokens,
      completion_tokens: result.usage.completion_tokens,
      official_title: official.title ? 1 : 0,
    })

    return { ok: true, redirectTo: `${returnTo}?translation_ai=1` }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logTranslate({
      intent: 'translation_ai_generate',
      event_id: eventId,
      ok: false,
      error: msg.slice(0, 200),
    })
    return { ok: false, message: `AI翻訳失敗: ${msg}` }
  }
}

export async function processAdminEventTranslatePost(opts: {
  request: Request
  url: URL
  cookies: AdminCookies
  form?: FormData
}): Promise<AdminTranslateResult> {
  const { request, url, cookies } = opts
  const form = opts.form ?? (await readAdminPostForm(request))

  const csrfCheck = verifyAdminCsrf({
    formToken: String(form.get('csrf_token') ?? ''),
    cookieToken: cookies.get('seekigo_admin_csrf')?.value,
    request,
    url,
  })
  if (!csrfCheck.ok) {
    return { ok: false, message: `Security check failed: ${csrfCheck.reason}` }
  }

  const intent = String(form.get('intent') ?? '')
  const ids = parsePositiveIntIds(
    [form.get('event_id')].filter(Boolean) as FormDataEntryValue[],
  )
  if (ids.length !== 1) {
    return { ok: false, message: 'Invalid event id' }
  }
  const eventId = ids[0]
  const returnTo = `/admin/events/${eventId}/`
  const admin = createAdminClient()
  const locale = 'en'

  if (intent === 'translation_ai_generate') {
    const force =
      String(form.get('force') ?? '') === '1' ||
      String(form.get('force') ?? '') === 'true'
    const translateReaction =
      String(form.get('translate_reaction') ?? '1') !== '0'
    return processTranslationAiGenerate({
      eventId,
      force,
      translateReaction,
    })
  }

  if (intent === 'translation_publish' || intent === 'translation_hide') {
    const next = intent === 'translation_publish' ? 'published' : 'hidden'
    const { data: existing, error } = await admin
      .from('event_translations')
      .select('id, status')
      .eq('event_id', eventId)
      .eq('locale', locale)
      .maybeSingle()
    if (error) return { ok: false, message: error.message }
    if (!existing) {
      return { ok: false, message: '英語翻訳がまだありません' }
    }
    const now = new Date().toISOString()
    const { error: upErr } = await admin
      .from('event_translations')
      .update({
        status: next,
        reviewed_at: now,
        reviewed_by: 'admin',
        updated_at: now,
      })
      .eq('id', existing.id)
    if (upErr) return { ok: false, message: upErr.message }

    // Also publish/hide reaction translation if present
    const { data: sum } = await admin
      .from('event_reaction_summaries')
      .select('id')
      .eq('event_id', eventId)
      .maybeSingle()
    if (sum) {
      await admin
        .from('event_reaction_summary_translations')
        .update({
          status: next,
          reviewed_at: now,
          reviewed_by: 'admin',
          updated_at: now,
        })
        .eq('summary_id', Number(sum.id))
        .eq('locale', locale)
    }

    const q =
      next === 'published' ? 'translation_published=1' : 'translation_hidden=1'
    logTranslate({ intent, event_id: eventId, ok: true, status: next })
    return { ok: true, redirectTo: `${returnTo}?${q}` }
  }

  if (intent === 'translation_save') {
    const fields = readFieldsFromForm(form)
    const reactionBullets = bulletsFromTextarea(
      String(form.get('tr_reaction_bullets') ?? ''),
    )
    const now = new Date().toISOString()

    const { data: existing, error: exErr } = await admin
      .from('event_translations')
      .select('id, status')
      .eq('event_id', eventId)
      .eq('locale', locale)
      .maybeSingle()
    if (exErr) return { ok: false, message: exErr.message }

    const patch = {
      event_id: eventId,
      locale,
      ...fields,
      updated_at: now,
      // keep status; do not auto-publish
      status: (existing?.status as string) || 'draft',
    }

    if (existing) {
      const { error } = await admin
        .from('event_translations')
        .update({
          title: fields.title,
          summary: fields.summary,
          access_text: fields.access_text,
          price_text: fields.price_text,
          age_note: fields.age_note,
          parking_text: fields.parking_text,
          updated_at: now,
        })
        .eq('id', existing.id)
      if (error) return { ok: false, message: error.message }
    } else {
      const { error } = await admin.from('event_translations').insert({
        ...patch,
        status: 'draft',
      })
      if (error) return { ok: false, message: error.message }
    }

    // Save reaction EN bullets if JA published summary exists
    const { data: sum } = await admin
      .from('event_reaction_summaries')
      .select('id')
      .eq('event_id', eventId)
      .maybeSingle()
    if (sum) {
      const summaryId = Number(sum.id)
      const { data: rxExisting } = await admin
        .from('event_reaction_summary_translations')
        .select('id, status')
        .eq('summary_id', summaryId)
        .eq('locale', locale)
        .maybeSingle()
      if (reactionBullets.length > 0 || rxExisting) {
        const rxPatch = {
          summary_id: summaryId,
          locale,
          summary_bullets: reactionBullets,
          updated_at: now,
          status: (rxExisting?.status as string) || 'draft',
        }
        if (rxExisting) {
          await admin
            .from('event_reaction_summary_translations')
            .update({
              summary_bullets: reactionBullets,
              updated_at: now,
            })
            .eq('id', rxExisting.id)
        } else if (reactionBullets.length > 0) {
          await admin.from('event_reaction_summary_translations').insert({
            ...rxPatch,
            status: 'draft',
          })
        }
      }
    }

    logTranslate({ intent: 'translation_save', event_id: eventId, ok: true })
    return { ok: true, redirectTo: `${returnTo}?translation_saved=1` }
  }

  return { ok: false, message: 'Invalid translation intent' }
}

/** Admin page load helper (any status). */
export async function fetchAdminEventTranslation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: { from: (table: string) => any },
  eventId: number,
  locale = 'en',
): Promise<EventTranslationRow | null> {
  const { data, error } = await client
    .from('event_translations')
    .select(EVENT_TRANSLATION_SELECT)
    .eq('event_id', eventId)
    .eq('locale', locale)
    .maybeSingle()
  if (error || !data) return null
  return mapEventTranslationRow(data as Record<string, unknown>)
}

export async function fetchAdminReactionTranslation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: { from: (table: string) => any },
  summaryId: number,
  locale = 'en',
): Promise<ReactionSummaryTranslationRow | null> {
  const { data, error } = await client
    .from('event_reaction_summary_translations')
    .select(REACTION_TRANSLATION_SELECT)
    .eq('summary_id', summaryId)
    .eq('locale', locale)
    .maybeSingle()
  if (error || !data) return null
  return mapReactionTranslationRow(data as Record<string, unknown>)
}
