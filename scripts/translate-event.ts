/**
 * Seekigo Phase 4C-6: AI translate event free-text → event_translations (draft)
 *
 * Usage (PowerShell):
 *   $env:EVENT_ID="42"
 *   $env:LOCALE="en"
 *   $env:DRY_RUN="true"
 *   $env:TRANSLATE_REACTION="true"
 *   npm run translate:event
 *
 * Optional:
 *   TRANSLATE_FORCE=true  — allow overwrite of published/hidden (still writes draft)
 *   AI_DRY_RUN_NO_API=true — skip OpenAI (print source fields only)
 *   OPENAI_TRANSLATE_MODEL (default gpt-4.1-nano)
 *
 * Never logs API keys. Never auto-publishes.
 */
import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import OpenAI from 'openai'
import {
  mergeUsage,
  resolveEventTranslateModel,
  translateEventFieldsWithAi,
  translateReactionBulletsWithAi,
  type EventTranslateFields,
} from '../src/lib/event-translate-ai'
import { estimateOpenAiCostUsd } from '../src/lib/reaction-summary-ai'
import { discoverOfficialEnglishTitle } from './lib/translate/official-title'

config()

const LOG = '[translate-event]'
const DRY_RUN = process.env.DRY_RUN !== 'false'
const NO_API = process.env.AI_DRY_RUN_NO_API === 'true'
const FORCE = process.env.TRANSLATE_FORCE === 'true'
const TRANSLATE_REACTION = process.env.TRANSLATE_REACTION !== 'false'
const EVENT_ID = Number(process.env.EVENT_ID ?? '')
const LOCALE = (process.env.LOCALE ?? 'en').trim() || 'en'

function createServiceClient(): SupabaseClient {
  const url = process.env.PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required')
  }
  if (key === process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    throw new Error('Refusing to use publishable key as service role')
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

type EventRow = {
  id: number
  title: string | null
  summary: string | null
  access_text: string | null
  price_text: string | null
  age_note: string | null
  parking_text: string | null
  venue: string | null
  official_url: string | null
}

function fieldsFromEvent(event: EventRow): EventTranslateFields {
  return {
    title: event.title?.trim() || null,
    summary: event.summary?.trim() || null,
    access_text: event.access_text?.trim() || null,
    price_text: event.price_text?.trim() || null,
    age_note: event.age_note?.trim() || null,
    parking_text: event.parking_text?.trim() || null,
  }
}

function countNonNull(fields: EventTranslateFields): number {
  return Object.values(fields).filter((v) => v != null && String(v).trim()).length
}

async function main(): Promise<void> {
  if (!Number.isFinite(EVENT_ID) || EVENT_ID <= 0) {
    throw new Error('EVENT_ID required (positive integer)')
  }
  if (LOCALE !== 'en') {
    console.warn(`${LOG} locale=${LOCALE} — v1 tested for en only`)
  }

  console.log(`${LOG} event_id=${EVENT_ID} locale=${LOCALE} dry_run=${DRY_RUN} translate_reaction=${TRANSLATE_REACTION} force=${FORCE}`)

  const client = createServiceClient()
  const { data: eventData, error: eventErr } = await client
    .from('events')
    .select(
      'id, title, summary, access_text, price_text, age_note, parking_text, venue, official_url',
    )
    .eq('id', EVENT_ID)
    .maybeSingle()
  if (eventErr) throw new Error(eventErr.message)
  if (!eventData) throw new Error(`event ${EVENT_ID} not found`)

  const event: EventRow = {
    id: Number(eventData.id),
    title: (eventData.title as string | null) ?? null,
    summary: (eventData.summary as string | null) ?? null,
    access_text: (eventData.access_text as string | null) ?? null,
    price_text: (eventData.price_text as string | null) ?? null,
    age_note: (eventData.age_note as string | null) ?? null,
    parking_text: (eventData.parking_text as string | null) ?? null,
    venue: (eventData.venue as string | null) ?? null,
    official_url: (eventData.official_url as string | null) ?? null,
  }

  const source = fieldsFromEvent(event)
  console.log(`${LOG} source_non_null_fields=${countNonNull(source)}`)
  console.log(
    `${LOG} source_keys=${FIELD_KEYS.filter((k) => source[k]).join(',') || '(none)'}`,
  )

  let existingTr: { id: number; status: string } | null = null
  {
    const { data, error: trErr } = await client
      .from('event_translations')
      .select('id, status')
      .eq('event_id', EVENT_ID)
      .eq('locale', LOCALE)
      .maybeSingle()
    if (trErr) {
      if (/does not exist|PGRST205|schema cache/i.test(trErr.message)) {
        console.warn(
          `${LOG} event_translations missing — run create-event-translations.sql + grant-event-translations.sql`,
        )
        if (!DRY_RUN) {
          throw new Error(
            `event_translations missing — apply SQL before write (${trErr.message})`,
          )
        }
      } else {
        throw new Error(trErr.message)
      }
    } else if (data) {
      existingTr = { id: Number(data.id), status: String(data.status ?? 'draft') }
    }
  }

  const existingStatus = existingTr?.status ?? null
  if (
    (existingStatus === 'published' || existingStatus === 'hidden') &&
    !FORCE
  ) {
    console.log(
      `${LOG} skip event translation: status=${existingStatus} (set TRANSLATE_FORCE=true to overwrite as draft)`,
    )
  }

  console.log(`${LOG} discovering official English title…`)
  const official = await discoverOfficialEnglishTitle(event.official_url)
  console.log(
    `${LOG} official_title=${official.title ? JSON.stringify(official.title) : 'null'} source=${official.source ?? '—'} note=${official.fetch_note ?? 'ok'}`,
  )
  if (official.candidates.length) {
    for (const c of official.candidates.slice(0, 5)) {
      console.log(`${LOG}   candidate: [${c.source}] ${c.value}`)
    }
  }

  const model = resolveEventTranslateModel()
  let translated: EventTranslateFields = {
    title: null,
    summary: null,
    access_text: null,
    price_text: null,
    age_note: null,
    parking_text: null,
  }
  let usage = estimateOpenAiCostUsd(model, 0, 0)
  let usedModel = model

  const canWriteEvent =
    !existingStatus ||
    existingStatus === 'draft' ||
    FORCE

  if (NO_API) {
    console.log(`${LOG} AI_DRY_RUN_NO_API=true — skipping OpenAI for event fields`)
  } else if (countNonNull(source) === 0) {
    console.log(`${LOG} no free-text fields to translate`)
  } else if (!canWriteEvent) {
    console.log(`${LOG} skipping AI event translate (protected status)`)
  } else {
    const apiKey = process.env.OPENAI_API_KEY?.trim()
    if (!apiKey) throw new Error('OPENAI_API_KEY required')
    const openai = new OpenAI({ apiKey })
    const result = await translateEventFieldsWithAi(openai, model, source, {
      official_english_title: official.title,
      venue: event.venue,
    })
    translated = result.fields
    usage = result.usage
    usedModel = result.model
    console.log(`${LOG} event AI done model=${usedModel}`)
    console.log(
      `${LOG} tokens prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens} cost=${usage.estimated_cost_display}`,
    )
  }

  // Apply official title even on NO_API when we have JA title
  if (official.title && source.title) {
    translated = { ...translated, title: official.title }
  }

  console.log(`${LOG} --- event translation draft preview ---`)
  for (const key of FIELD_KEYS) {
    const ja = source[key]
    const en = translated[key]
    if (!ja && !en) continue
    console.log(`${LOG} [${key}] JA: ${ja ?? 'null'}`)
    console.log(`${LOG} [${key}] EN: ${en ?? 'null'}`)
  }

  // Reaction bullets
  let reactionBulletsEn: string[] | null = null
  let reactionUsage = estimateOpenAiCostUsd(model, 0, 0)
  let reactionSummaryId: number | null = null
  let reactionProtected = false

  if (TRANSLATE_REACTION) {
    const { data: sum, error: sumErr } = await client
      .from('event_reaction_summaries')
      .select('id, status, summary_bullets')
      .eq('event_id', EVENT_ID)
      .eq('status', 'published')
      .maybeSingle()
    if (sumErr) {
      console.warn(`${LOG} reaction summary load: ${sumErr.message}`)
    } else if (!sum) {
      console.log(`${LOG} no published JA reaction summary — skip reaction translate`)
    } else {
      reactionSummaryId = Number(sum.id)
      const bulletsJa = Array.isArray(sum.summary_bullets)
        ? (sum.summary_bullets as unknown[])
            .map((b) => String(b ?? '').trim())
            .filter(Boolean)
            .slice(0, 5)
        : []
      console.log(`${LOG} published reaction bullets=${bulletsJa.length}`)

      const { data: existingRx, error: rxErr } = await client
        .from('event_reaction_summary_translations')
        .select('id, status')
        .eq('summary_id', reactionSummaryId)
        .eq('locale', LOCALE)
        .maybeSingle()
      if (rxErr) {
        if (/does not exist|PGRST205|schema cache/i.test(rxErr.message)) {
          console.warn(
            `${LOG} event_reaction_summary_translations missing — apply SQL (continuing DRY_RUN AI)`,
          )
        } else {
          throw new Error(rxErr.message)
        }
      }
      const rxStatus = existingRx ? String(existingRx.status ?? 'draft') : null
      if ((rxStatus === 'published' || rxStatus === 'hidden') && !FORCE) {
        reactionProtected = true
        console.log(
          `${LOG} skip reaction translation: status=${rxStatus} (TRANSLATE_FORCE to overwrite as draft)`,
        )
      }

      if (bulletsJa.length && !reactionProtected && !NO_API) {
        const apiKey = process.env.OPENAI_API_KEY?.trim()
        if (!apiKey) throw new Error('OPENAI_API_KEY required')
        const openai = new OpenAI({ apiKey })
        const rx = await translateReactionBulletsWithAi(openai, model, bulletsJa)
        reactionBulletsEn = rx.summary_bullets
        reactionUsage = rx.usage
        usage = mergeUsage(usage, reactionUsage)
        console.log(
          `${LOG} reaction AI tokens prompt=${rx.usage.prompt_tokens} completion=${rx.usage.completion_tokens} cost=${rx.usage.estimated_cost_display}`,
        )
        console.log(`${LOG} --- reaction bullets EN preview ---`)
        bulletsJa.forEach((ja, i) => {
          console.log(`${LOG}  JA[${i}]: ${ja}`)
          console.log(`${LOG}  EN[${i}]: ${reactionBulletsEn?.[i] ?? '(missing)'}`)
        })
      } else if (NO_API && bulletsJa.length) {
        console.log(`${LOG} reaction bullets (JA only, no API):`)
        bulletsJa.forEach((ja, i) => console.log(`${LOG}  [${i}] ${ja}`))
      }
    }
  }

  console.log(
    `${LOG} TOTAL cost estimate model=${usedModel} ${usage.estimated_cost_display} (prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens})`,
  )

  if (DRY_RUN) {
    console.log(`${LOG} DRY_RUN=true — no DB write`)
    return
  }

  const now = new Date().toISOString()

  if (canWriteEvent && countNonNull(source) > 0) {
    const patch = {
      event_id: EVENT_ID,
      locale: LOCALE,
      title: translated.title,
      summary: translated.summary,
      access_text: translated.access_text,
      price_text: translated.price_text,
      age_note: translated.age_note,
      parking_text: translated.parking_text,
      status: 'draft' as const,
      generated_at: now,
      updated_at: now,
    }
    if (existingTr) {
      const { error } = await client
        .from('event_translations')
        .update(patch)
        .eq('id', existingTr.id)
      if (error) throw new Error(error.message)
      console.log(`${LOG} updated event_translations id=${existingTr.id} status=draft`)
    } else {
      const { data, error } = await client
        .from('event_translations')
        .insert(patch)
        .select('id')
        .single()
      if (error) throw new Error(error.message)
      console.log(`${LOG} inserted event_translations id=${data.id} status=draft`)
    }
  }

  if (
    reactionSummaryId &&
    reactionBulletsEn &&
    reactionBulletsEn.length > 0 &&
    !reactionProtected
  ) {
    const { data: existingRx } = await client
      .from('event_reaction_summary_translations')
      .select('id')
      .eq('summary_id', reactionSummaryId)
      .eq('locale', LOCALE)
      .maybeSingle()

    const rxPatch = {
      summary_id: reactionSummaryId,
      locale: LOCALE,
      summary_bullets: reactionBulletsEn,
      status: 'draft' as const,
      generated_at: now,
      updated_at: now,
    }
    if (existingRx) {
      const { error } = await client
        .from('event_reaction_summary_translations')
        .update(rxPatch)
        .eq('id', existingRx.id)
      if (error) throw new Error(error.message)
      console.log(
        `${LOG} updated reaction translation id=${existingRx.id} status=draft`,
      )
    } else {
      const { data, error } = await client
        .from('event_reaction_summary_translations')
        .insert(rxPatch)
        .select('id')
        .single()
      if (error) throw new Error(error.message)
      console.log(
        `${LOG} inserted reaction translation id=${data.id} status=draft`,
      )
    }
  }

  console.log(`${LOG} done (status=draft — human Publish required)`)
}

const FIELD_KEYS = [
  'title',
  'summary',
  'access_text',
  'price_text',
  'age_note',
  'parking_text',
] as const

main().catch((e) => {
  console.error(LOG, e instanceof Error ? e.message : e)
  process.exit(1)
})
