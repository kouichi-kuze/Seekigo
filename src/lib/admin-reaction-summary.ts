/**
 * DEV admin: SNS・Web 反応要約の保存 / Publish / Hidden / AI 生成.
 */
import OpenAI from 'openai'
import { createAdminClient } from './supabase-admin'
import {
  parsePositiveIntIds,
  readAdminPostForm,
  verifyAdminCsrf,
} from './admin-security'
import {
  bulletsFromTextarea,
  parseReactionSignals,
  REACTION_CONFIDENCE_LEVELS,
  REACTION_CROWD_LEVELS,
  REACTION_WAIT_LEVELS,
  type ReactionConfidence,
  type ReactionCrowdLevel,
  type ReactionSignals,
  type ReactionWaitLevel,
} from './event-reaction-summary'
import {
  aiSignalsToDbSignals,
  buildReactionSummaryAiPayload,
  generateReactionSummaryWithAi,
  MIN_REACTION_SOURCES_FOR_AI,
  resolveReactionSummaryModel,
} from './reaction-summary-ai'

type AdminCookies = {
  get: (name: string) => { value: string } | undefined
}

export type AdminReactionResult =
  | { ok: true; redirectTo: string }
  | { ok: false; message: string }

function logReactionPost(
  details: Record<string, string | number | boolean | null | undefined>,
): void {
  if (!import.meta.env.DEV) return
  // 秘密情報・excerpt 本文は出さない
  console.info('[admin/reaction-summary] POST', details)
}

function parseBoolFlag(form: FormData, name: string): boolean | null {
  const raw = String(form.get(name) ?? '').trim()
  if (raw === '1' || raw === 'true' || raw === 'on') return true
  if (raw === '0' || raw === 'false') return false
  // checkbox absent → false for editable flags (explicit off)
  if (!form.has(name)) return false
  return null
}

function readSignalsFromForm(form: FormData): ReactionSignals {
  const crowdRaw = String(form.get('crowd_level') ?? '').trim()
  const waitRaw = String(form.get('wait_time') ?? '').trim()
  const crowd: ReactionCrowdLevel | null = (
    REACTION_CROWD_LEVELS as readonly string[]
  ).includes(crowdRaw)
    ? (crowdRaw as ReactionCrowdLevel)
    : null
  const wait: ReactionWaitLevel | null = (
    REACTION_WAIT_LEVELS as readonly string[]
  ).includes(waitRaw)
    ? (waitRaw as ReactionWaitLevel)
    : null
  const recommended = String(form.get('recommended_time') ?? '').trim()

  return parseReactionSignals({
    crowd_level: crowd,
    family: parseBoolFlag(form, 'signal_family'),
    date: parseBoolFlag(form, 'signal_date'),
    solo: parseBoolFlag(form, 'signal_solo'),
    photo: parseBoolFlag(form, 'signal_photo'),
    rain: parseBoolFlag(form, 'signal_rain'),
    wait_time: wait,
    recommended_time: recommended || null,
  })
}

function readConfidence(form: FormData): ReactionConfidence {
  const raw = String(form.get('confidence') ?? 'low').trim()
  return (REACTION_CONFIDENCE_LEVELS as readonly string[]).includes(raw)
    ? (raw as ReactionConfidence)
    : 'low'
}

async function processReactionAiGenerate(opts: {
  eventId: number
  force: boolean
}): Promise<AdminReactionResult> {
  const { eventId, force } = opts
  const returnTo = `/admin/events/${eventId}/`
  const admin = createAdminClient()

  const { data: existing, error: sumErr } = await admin
    .from('event_reaction_summaries')
    .select('id, status')
    .eq('event_id', eventId)
    .maybeSingle()
  if (sumErr) {
    logReactionPost({
      intent: 'reaction_ai_generate',
      event_id: eventId,
      ok: false,
      error: sumErr.message,
    })
    return { ok: false, message: sumErr.message }
  }

  const status = existing ? String(existing.status ?? 'draft') : null
  if ((status === 'published' || status === 'hidden') && !force) {
    logReactionPost({
      intent: 'reaction_ai_generate',
      event_id: eventId,
      ok: false,
      reason: `status_${status}_needs_force`,
    })
    return {
      ok: false,
      message: `反応要約が ${status} のため上書きしません（force が必要）`,
    }
  }

  const { data: event, error: evErr } = await admin
    .from('events')
    .select('id, title, venue, area, start_date, end_date, category')
    .eq('id', eventId)
    .maybeSingle()
  if (evErr) return { ok: false, message: evErr.message }
  if (!event) return { ok: false, message: 'Event not found' }

  const { data: sources, error: srcErr } = await admin
    .from('event_reaction_sources')
    .select(
      'source_type, observed_at, excerpt_for_internal_review, source_name, created_at',
    )
    .eq('event_id', eventId)
    .order('observed_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(40)
  if (srcErr) return { ok: false, message: srcErr.message }

  const payload = buildReactionSummaryAiPayload({
    event: {
      title: String(event.title ?? ''),
      venue: (event.venue as string | null) ?? null,
      area: (event.area as string | null) ?? null,
      start_date: (event.start_date as string | null) ?? null,
      end_date: (event.end_date as string | null) ?? null,
      category: (event.category as string[] | string | null) ?? null,
    },
    sources: sources ?? [],
  })

  if (payload.sources.length < MIN_REACTION_SOURCES_FOR_AI) {
    logReactionPost({
      intent: 'reaction_ai_generate',
      event_id: eventId,
      ok: false,
      reason: 'insufficient_sources',
      source_count: payload.sources.length,
    })
    return {
      ok: false,
      message: `ソースが不足しています（${payload.sources.length}/${MIN_REACTION_SOURCES_FOR_AI}）`,
    }
  }

  const apiKey =
    import.meta.env.OPENAI_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    return { ok: false, message: 'OPENAI_API_KEY が未設定です' }
  }

  const model = resolveReactionSummaryModel()
  try {
    const openai = new OpenAI({ apiKey })
    const result = await generateReactionSummaryWithAi(openai, model, payload)
    const now = new Date().toISOString()
    const signals = aiSignalsToDbSignals(result.output)
    const patch = {
      summary_bullets: result.output.summary_bullets,
      signals,
      source_count: payload.sources.length,
      confidence: result.output.confidence,
      generated_at: now,
      status: 'draft' as const,
    }

    if (existing) {
      const { error: upErr } = await admin
        .from('event_reaction_summaries')
        .update(patch)
        .eq('event_id', eventId)
      if (upErr) return { ok: false, message: upErr.message }
    } else {
      const { error: insErr } = await admin
        .from('event_reaction_summaries')
        .insert({
          event_id: eventId,
          ...patch,
        })
      if (insErr) return { ok: false, message: insErr.message }
    }

    logReactionPost({
      intent: 'reaction_ai_generate',
      event_id: eventId,
      ok: true,
      source_count: payload.sources.length,
      bullet_count: result.output.summary_bullets.length,
      confidence: result.output.confidence,
      model: result.model,
      estimated_cost: result.usage.estimated_cost_display,
      prompt_tokens: result.usage.prompt_tokens,
      completion_tokens: result.usage.completion_tokens,
    })

    return { ok: true, redirectTo: `${returnTo}?reaction_ai=1` }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logReactionPost({
      intent: 'reaction_ai_generate',
      event_id: eventId,
      ok: false,
      error: msg.slice(0, 200),
    })
    return { ok: false, message: `AI生成失敗: ${msg}` }
  }
}

export async function processAdminReactionSummaryPost(opts: {
  request: Request
  url: URL
  cookies: AdminCookies
  form?: FormData
}): Promise<AdminReactionResult> {
  const { request, url, cookies } = opts
  const form = opts.form ?? (await readAdminPostForm(request))

  const csrfCheck = verifyAdminCsrf({
    formToken: String(form.get('csrf_token') ?? ''),
    cookieToken: cookies.get('seekigo_admin_csrf')?.value,
    request,
    url,
  })
  if (!csrfCheck.ok) {
    logReactionPost({
      intent: String(form.get('intent') ?? ''),
      ok: false,
      reason: csrfCheck.reason,
    })
    return { ok: false, message: `Security check failed: ${csrfCheck.reason}` }
  }

  const intent = String(form.get('intent') ?? '')
  const ids = parsePositiveIntIds(
    [form.get('event_id')].filter(Boolean) as FormDataEntryValue[],
  )
  if (ids.length !== 1) {
    logReactionPost({ intent, ok: false, reason: 'invalid_event_id' })
    return { ok: false, message: 'Invalid event id' }
  }
  const eventId = ids[0]
  const returnTo = `/admin/events/${eventId}/`
  const admin = createAdminClient()

  if (intent === 'reaction_ai_generate') {
    const force =
      String(form.get('force') ?? '') === '1' ||
      String(form.get('force') ?? '') === 'true'
    return processReactionAiGenerate({ eventId, force })
  }

  if (intent === 'reaction_publish' || intent === 'reaction_hide') {
    const { data: existing, error } = await admin
      .from('event_reaction_summaries')
      .select('id, status, summary_bullets')
      .eq('event_id', eventId)
      .maybeSingle()
    if (error) {
      logReactionPost({
        intent,
        event_id: eventId,
        ok: false,
        update_result: 'error',
        error: error.message,
      })
      return { ok: false, message: error.message }
    }
    if (!existing) {
      logReactionPost({
        intent,
        event_id: eventId,
        summary_id: null,
        ok: false,
        reason: 'summary_missing',
      })
      return {
        ok: false,
        message: '反応要約がまだありません。先に保存してください。',
      }
    }
    const bullets = Array.isArray(existing.summary_bullets)
      ? existing.summary_bullets
      : []
    if (intent === 'reaction_publish' && bullets.length === 0) {
      logReactionPost({
        intent,
        event_id: eventId,
        summary_id: Number(existing.id),
        ok: false,
        reason: 'empty_bullets',
      })
      return { ok: false, message: '要約文が空のため Publish できません' }
    }

    const prevStatus = String(existing.status ?? 'draft')
    const nextStatus = intent === 'reaction_publish' ? 'published' : 'hidden'
    const patch: Record<string, unknown> = {
      status: nextStatus,
    }
    if (intent === 'reaction_publish') {
      patch.reviewed_at = new Date().toISOString()
      patch.reviewed_by = 'local_admin'
    }

    const { error: upErr } = await admin
      .from('event_reaction_summaries')
      .update(patch)
      .eq('event_id', eventId)
    if (upErr) {
      logReactionPost({
        intent,
        event_id: eventId,
        summary_id: Number(existing.id),
        status_change: `${prevStatus}->${nextStatus}`,
        update_result: 'error',
        error: upErr.message,
      })
      return { ok: false, message: upErr.message }
    }

    logReactionPost({
      intent,
      event_id: eventId,
      summary_id: Number(existing.id),
      status_change: `${prevStatus}->${nextStatus}`,
      update_result: 'ok',
    })

    const flag =
      intent === 'reaction_publish' ? 'reaction_published' : 'reaction_hidden'
    return { ok: true, redirectTo: `${returnTo}?${flag}=1` }
  }

  if (intent !== 'reaction_save') {
    logReactionPost({
      intent,
      event_id: eventId,
      ok: false,
      reason: 'invalid_intent',
    })
    return { ok: false, message: 'Invalid reaction request' }
  }

  const bullets = bulletsFromTextarea(String(form.get('summary_bullets') ?? ''))
  const signals = readSignalsFromForm(form)
  const confidence = readConfidence(form)
  const sourceCountRaw = Number(String(form.get('source_count') ?? '0'))
  const sourceCount =
    Number.isFinite(sourceCountRaw) && sourceCountRaw >= 0
      ? Math.min(Math.floor(sourceCountRaw), 999)
      : 0

  const markReviewed = String(form.get('mark_reviewed') ?? '') === '1'
  const now = new Date().toISOString()

  const { data: existing, error: selErr } = await admin
    .from('event_reaction_summaries')
    .select('id, status')
    .eq('event_id', eventId)
    .maybeSingle()
  if (selErr) {
    logReactionPost({
      intent,
      event_id: eventId,
      update_result: 'error',
      error: selErr.message,
    })
    return { ok: false, message: selErr.message }
  }

  if (!existing) {
    const nextStatus = markReviewed ? 'reviewed' : 'draft'
    const { data: inserted, error: insErr } = await admin
      .from('event_reaction_summaries')
      .insert({
        event_id: eventId,
        summary_bullets: bullets,
        signals,
        source_count: sourceCount,
        confidence,
        status: nextStatus,
        generated_at: now,
        reviewed_at: markReviewed ? now : null,
        reviewed_by: markReviewed ? 'local_admin' : null,
      })
      .select('id')
      .maybeSingle()
    if (insErr) {
      logReactionPost({
        intent,
        event_id: eventId,
        status_change: `null->${nextStatus}`,
        update_result: 'error',
        error: insErr.message,
      })
      return { ok: false, message: insErr.message }
    }
    logReactionPost({
      intent,
      event_id: eventId,
      summary_id: inserted ? Number(inserted.id) : null,
      status_change: `null->${nextStatus}`,
      update_result: 'ok',
      bullet_count: bullets.length,
      signal_keys: Object.keys(signals).length,
      source_count: sourceCount,
      confidence,
    })
    return { ok: true, redirectTo: `${returnTo}?reaction_saved=1` }
  }

  const prevStatus = String(existing.status ?? 'draft')
  const patch: Record<string, unknown> = {
    summary_bullets: bullets,
    signals,
    source_count: sourceCount,
    confidence,
  }
  let nextStatus = prevStatus
  if (markReviewed && existing.status !== 'published') {
    patch.status = 'reviewed'
    patch.reviewed_at = now
    patch.reviewed_by = 'local_admin'
    nextStatus = 'reviewed'
  }

  const { error: upErr } = await admin
    .from('event_reaction_summaries')
    .update(patch)
    .eq('event_id', eventId)
  if (upErr) {
    logReactionPost({
      intent,
      event_id: eventId,
      summary_id: Number(existing.id),
      status_change: `${prevStatus}->${nextStatus}`,
      update_result: 'error',
      error: upErr.message,
    })
    return { ok: false, message: upErr.message }
  }

  logReactionPost({
    intent,
    event_id: eventId,
    summary_id: Number(existing.id),
    status_change: `${prevStatus}->${nextStatus}`,
    update_result: 'ok',
    bullet_count: bullets.length,
    signal_keys: Object.keys(signals).length,
    source_count: sourceCount,
    confidence,
  })

  return { ok: true, redirectTo: `${returnTo}?reaction_saved=1` }
}
