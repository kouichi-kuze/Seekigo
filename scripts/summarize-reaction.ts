/**
 * Seekigo Phase 4B-3: AI reaction summary → event_reaction_summaries (draft)
 *
 * Usage (PowerShell):
 *   # 1) input only (no OpenAI, no DB)
 *   $env:REACTION_EVENT_ID="42"
 *   $env:DRY_RUN="true"
 *   $env:AI_DRY_RUN_NO_API="true"
 *   npm run summarize:reaction
 *
 *   # 2) call OpenAI once, no DB write
 *   $env:REACTION_EVENT_ID="42"
 *   $env:DRY_RUN="true"
 *   $env:AI_DRY_RUN_NO_API="false"
 *   npm run summarize:reaction
 *
 *   # 3) write draft (after human review of dry-run)
 *   $env:DRY_RUN="false"
 *   $env:REACTION_EVENT_ID="42"
 *   npm run summarize:reaction
 *
 * Optional: REACTION_FORCE=true to overwrite published/hidden (default: draft only)
 * Optional: OPENAI_REACTION_MODEL (default gpt-4.1-nano)
 *
 * Never logs API keys or full source excerpts.
 */
import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import OpenAI from 'openai'
import {
  aiSignalsToDbSignals,
  buildReactionSummaryAiPayload,
  countClassifications,
  countSourceTypes,
  estimateInputChars,
  generateReactionSummaryWithAi,
  MIN_REACTION_SOURCES_FOR_AI,
  resolveReactionSummaryModel,
  type ReactionSummaryAiJson,
  type ReactionSummaryAiPayload,
} from '../src/lib/reaction-summary-ai'

config()

const LOG = '[summarize-reaction]'
const DRY_RUN = process.env.DRY_RUN !== 'false'
const NO_API = process.env.AI_DRY_RUN_NO_API === 'true'
const FORCE = process.env.REACTION_FORCE === 'true'
const EVENT_ID = Number(process.env.REACTION_EVENT_ID ?? '')

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
  title: string
  venue: string | null
  area: string | null
  start_date: string | null
  end_date: string | null
  category: string[] | string | null
}

async function loadEvent(
  client: SupabaseClient,
  eventId: number,
): Promise<EventRow> {
  const { data, error } = await client
    .from('events')
    .select('id, title, venue, area, start_date, end_date, category')
    .eq('id', eventId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error(`event ${eventId} not found`)
  return {
    id: Number(data.id),
    title: String(data.title ?? ''),
    venue: (data.venue as string | null) ?? null,
    area: (data.area as string | null) ?? null,
    start_date: (data.start_date as string | null) ?? null,
    end_date: (data.end_date as string | null) ?? null,
    category: (data.category as string[] | string | null) ?? null,
  }
}

async function loadSources(
  client: SupabaseClient,
  eventId: number,
): Promise<
  Array<{
    source_type: string
    observed_at: string | null
    excerpt_for_internal_review: string | null
    source_name: string | null
  }>
> {
  const { data, error } = await client
    .from('event_reaction_sources')
    .select(
      'source_type, observed_at, excerpt_for_internal_review, source_name, created_at',
    )
    .eq('event_id', eventId)
    .order('observed_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(40)

  if (error) throw new Error(error.message)
  return (data ?? []).map((row) => ({
    source_type: String(row.source_type ?? 'other'),
    observed_at: (row.observed_at as string | null) ?? null,
    excerpt_for_internal_review:
      (row.excerpt_for_internal_review as string | null) ?? null,
    source_name: (row.source_name as string | null) ?? null,
  }))
}

function logPayloadMeta(payload: ReactionSummaryAiPayload): void {
  const classes = countClassifications(payload.sources)
  console.log(
    JSON.stringify({
      event_id: EVENT_ID,
      source_count: payload.sources.length,
      source_type_counts: countSourceTypes(payload.sources),
      experience_estimate: classes.experience,
      classification_counts: classes,
      input_chars: estimateInputChars(payload),
      event_title: payload.event.title,
      max_bullets: payload.max_bullets,
    }),
  )
}

async function saveDraft(
  client: SupabaseClient,
  eventId: number,
  output: ReactionSummaryAiJson,
  sourceCount: number,
): Promise<{ summary_id: number; created: boolean }> {
  const now = new Date().toISOString()
  const signals = aiSignalsToDbSignals(output)

  const { data: existing, error: selErr } = await client
    .from('event_reaction_summaries')
    .select('id, status')
    .eq('event_id', eventId)
    .maybeSingle()
  if (selErr) throw new Error(selErr.message)

  if (existing) {
    const status = String(existing.status ?? 'draft')
    if ((status === 'published' || status === 'hidden') && !FORCE) {
      throw new Error(
        `summary status=${status}; refuse overwrite without REACTION_FORCE=true`,
      )
    }
    const patch: Record<string, unknown> = {
      summary_bullets: output.summary_bullets,
      signals,
      source_count: sourceCount,
      confidence: output.confidence,
      generated_at: now,
    }
    if (status === 'draft' || status === 'reviewed' || FORCE) {
      if (status !== 'published' && status !== 'hidden') {
        patch.status = 'draft'
      }
    }
    const { error: upErr } = await client
      .from('event_reaction_summaries')
      .update(patch)
      .eq('event_id', eventId)
    if (upErr) throw new Error(upErr.message)
    return { summary_id: Number(existing.id), created: false }
  }

  const { data: inserted, error: insErr } = await client
    .from('event_reaction_summaries')
    .insert({
      event_id: eventId,
      summary_bullets: output.summary_bullets,
      signals,
      source_count: sourceCount,
      confidence: output.confidence,
      status: 'draft',
      generated_at: now,
    })
    .select('id')
    .maybeSingle()
  if (insErr) throw new Error(insErr.message)
  return { summary_id: Number(inserted?.id ?? 0), created: true }
}

async function main() {
  console.log(`${LOG} DRY_RUN: ${DRY_RUN}`)
  console.log(`${LOG} AI_DRY_RUN_NO_API: ${NO_API}`)
  console.log(`${LOG} REACTION_FORCE: ${FORCE}`)

  if (!Number.isFinite(EVENT_ID) || EVENT_ID <= 0) {
    console.error(
      `${LOG} set REACTION_EVENT_ID (PowerShell: $env:REACTION_EVENT_ID="42")`,
    )
    process.exit(1)
  }

  const client = createServiceClient()
  const event = await loadEvent(client, EVENT_ID)
  const rawSources = await loadSources(client, EVENT_ID)
  const payload = buildReactionSummaryAiPayload({
    event,
    sources: rawSources,
  })

  logPayloadMeta(payload)

  if (payload.sources.length < MIN_REACTION_SOURCES_FOR_AI) {
    console.log(
      JSON.stringify({
        skipped: true,
        reason: 'insufficient_sources',
        source_count: payload.sources.length,
        min_required: MIN_REACTION_SOURCES_FOR_AI,
        db_write_planned: false,
      }),
    )
    return
  }

  if (NO_API) {
    console.log(
      JSON.stringify({
        ai_response_status: 'skipped_no_api',
        model: resolveReactionSummaryModel(),
        db_write_planned: false,
        note: 'AI_DRY_RUN_NO_API=true — payload only',
      }),
    )
    return
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is missing')
  }
  const model = resolveReactionSummaryModel()
  console.log(JSON.stringify({ model, calling_openai: true }))

  const openai = new OpenAI({ apiKey })
  const result = await generateReactionSummaryWithAi(openai, model, payload)

  console.log(
    JSON.stringify({
      ai_response_status: 'ok',
      model: result.model,
      summary_bullet_count: result.output.summary_bullets.length,
      confidence: result.output.confidence,
      usage: {
        prompt_tokens: result.usage.prompt_tokens,
        completion_tokens: result.usage.completion_tokens,
        total_tokens: result.usage.total_tokens,
      },
      estimated_openai_cost: result.usage.estimated_cost_display,
      estimated_cost_note:
        'OpenAI pricing may change — verify on Platform Usage',
      quality_guard: result.guard,
      bullets_debug: result.guard.bullets_debug,
      generated_json: result.output,
      db_signals_mapped: aiSignalsToDbSignals(result.output),
    }),
  )

  if (DRY_RUN) {
    console.log(
      JSON.stringify({
        db_write_planned: false,
        db_write_skipped: true,
        reason: 'DRY_RUN',
      }),
    )
    console.log(`${LOG} dry-run mode — no DB writes`)
    return
  }

  // Safety: check status before write
  const { data: existing } = await client
    .from('event_reaction_summaries')
    .select('status')
    .eq('event_id', EVENT_ID)
    .maybeSingle()
  const status = existing ? String(existing.status) : null
  if (
    (status === 'published' || status === 'hidden') &&
    !FORCE
  ) {
    console.log(
      JSON.stringify({
        db_write_planned: false,
        db_write_skipped: true,
        reason: `status_${status}_needs_force`,
      }),
    )
    return
  }

  const saved = await saveDraft(
    client,
    EVENT_ID,
    result.output,
    payload.sources.length,
  )
  console.log(
    JSON.stringify({
      db_write_planned: true,
      db_write_skipped: false,
      summary_id: saved.summary_id,
      created: saved.created,
      status: 'draft',
      source_count: payload.sources.length,
    }),
  )
  console.log(`${LOG} done write_mode`)
}

main().catch((e) => {
  console.error(`${LOG} fatal:`, e instanceof Error ? e.message : e)
  process.exit(1)
})
