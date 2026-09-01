/**
 * likely / ambiguous を event_dedupe_reviews へ冪等保存。
 *
 * - DRY_RUN (write=false): ログのみ。INSERT/UPDATE しない
 * - pending のみ更新（payload / reason / scores）
 * - linked / created / rejected / expired は触らない（履歴維持）
 * - candidate_event_id が null でもアプリ側検索で冪等（UNIQUE の NULL 穴埋め）
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { EventSourceName } from '../../src/lib/event-sources'
import {
  extractEnjoytokyoEventId,
  extractGotokyoSpotId,
  extractWalkerplusEventId,
} from '../../src/lib/event-sources'

export type DedupeReviewDuplicateStatus = 'likely' | 'ambiguous'

export const RESOLVED_REVIEW_STATUSES = [
  'linked',
  'created',
  'rejected',
  'expired',
] as const

export type IncomingReviewPayload = {
  title: string | null
  start_date: string | null
  end_date: string | null
  start_time: string | null
  end_time: string | null
  venue: string | null
  area: string | null
  address: string | null
  official_url: string | null
  source_url: string | null
  source_event_id: string | null
  price_text: string | null
  is_free: boolean | null
  category: string[] | null
  summary: string | null
  image_url: string | null
  walkerplus_categories_raw?: string[] | null
}

export type UpsertDedupeReviewInput = {
  incoming_source_name: EventSourceName
  incoming_source_url: string
  incoming_payload: IncomingReviewPayload
  /** likely/ambiguous では通常セット。null でも冪等に扱う */
  candidate_event_id: number | null
  duplicate_status: DedupeReviewDuplicateStatus
  reason: string | null
  scores: Record<string, unknown> | null
}

export type UpsertDedupeReviewResult =
  | 'inserted'
  | 'updated_pending'
  | 'skipped_resolved'
  | 'dry_run'
  | 'skipped_invalid'

function isResolvedStatus(status: string): boolean {
  return (RESOLVED_REVIEW_STATUSES as readonly string[]).includes(status)
}

function logReview(
  kind: 'pending' | 'dry-run' | 'skipped',
  lines: Record<string, string | number | null | undefined>,
) {
  console.log(`[dedupe-review] ${kind}`)
  for (const [k, v] of Object.entries(lines)) {
    if (v === undefined) continue
    console.log(`${k}: ${v == null ? 'null' : String(v)}`)
  }
}

export function buildIncomingPayload(opts: {
  sourceName: EventSourceName
  title?: string | null
  start_date?: string | null
  end_date?: string | null
  start_time?: string | null
  end_time?: string | null
  venue?: string | null
  area?: string | null
  address?: string | null
  official_url?: string | null
  source_url?: string | null
  price_text?: string | null
  is_free?: boolean | null
  category?: string[] | null
  summary?: string | null
  image_url?: string | null
  /** Walkerplus 取得元カテゴリ（source metadata） */
  walkerplus_categories_raw?: string[] | null
}): IncomingReviewPayload {
  const sourceUrl = opts.source_url ?? null
  const sourceEventId =
    opts.sourceName === 'gotokyo'
      ? extractGotokyoSpotId(sourceUrl)
      : opts.sourceName === 'walkerplus'
        ? extractWalkerplusEventId(sourceUrl)
        : extractEnjoytokyoEventId(sourceUrl)

  const payload: IncomingReviewPayload = {
    title: opts.title ?? null,
    start_date: opts.start_date ?? null,
    end_date: opts.end_date ?? null,
    start_time: opts.start_time ?? null,
    end_time: opts.end_time ?? null,
    venue: opts.venue ?? null,
    area: opts.area ?? null,
    address: opts.address ?? null,
    official_url: opts.official_url ?? null,
    source_url: sourceUrl,
    source_event_id: sourceEventId,
    price_text: opts.price_text ?? null,
    is_free: typeof opts.is_free === 'boolean' ? opts.is_free : null,
    category: Array.isArray(opts.category) ? opts.category : null,
    summary: opts.summary ?? null,
    image_url: opts.image_url ?? null,
  }

  if (
    opts.sourceName === 'walkerplus' &&
    Array.isArray(opts.walkerplus_categories_raw)
  ) {
    payload.walkerplus_categories_raw = opts.walkerplus_categories_raw
  }

  return payload
}

async function findExistingReview(
  client: SupabaseClient,
  sourceName: EventSourceName,
  sourceUrl: string,
  candidateEventId: number | null,
): Promise<{ id: number; status: string } | null> {
  let q = client
    .from('event_dedupe_reviews')
    .select('id, status')
    .eq('incoming_source_name', sourceName)
    .eq('incoming_source_url', sourceUrl)

  if (candidateEventId == null) {
    q = q.is('candidate_event_id', null)
  } else {
    q = q.eq('candidate_event_id', candidateEventId)
  }

  // UNIQUE が NULL を重複扱いしないため、null 候補は複数行があり得る。
  // 解決済みを優先してスキップ判定し、なければ pending を1件取る。
  const { data, error } = await q.order('id', { ascending: true }).limit(20)
  if (error) throw error
  if (!data || data.length === 0) return null

  const resolved = data.find((r) => isResolvedStatus(String(r.status)))
  if (resolved) {
    return { id: Number(resolved.id), status: String(resolved.status) }
  }

  const pending = data.find((r) => r.status === 'pending')
  if (pending) {
    return { id: Number(pending.id), status: String(pending.status) }
  }

  return { id: Number(data[0].id), status: String(data[0].status) }
}

/**
 * pending 行のみ upsert。解決済み行は履歴として維持。
 */
export async function upsertDedupeReview(
  client: SupabaseClient,
  input: UpsertDedupeReviewInput,
  write: boolean,
  _logPrefix = '[dedupe-review]',
): Promise<UpsertDedupeReviewResult> {
  const sourceUrl = input.incoming_source_url.trim()
  if (!sourceUrl) return 'skipped_invalid'
  if (
    input.duplicate_status !== 'likely' &&
    input.duplicate_status !== 'ambiguous'
  ) {
    return 'skipped_invalid'
  }

  const candidateId =
    input.candidate_event_id != null &&
    Number.isFinite(input.candidate_event_id) &&
    input.candidate_event_id > 0
      ? Number(input.candidate_event_id)
      : null

  // DRY_RUN: DB へ SELECT/INSERT/UPDATE しない（ログのみ）
  if (!write) {
    logReview('dry-run', {
      source: input.incoming_source_name,
      incoming: input.incoming_payload.title ?? sourceUrl,
      candidate_event_id: candidateId,
      status: input.duplicate_status,
      action: 'would_save_review',
    })
    return 'dry_run'
  }

  const existing = await findExistingReview(
    client,
    input.incoming_source_name,
    sourceUrl,
    candidateId,
  )

  if (existing && isResolvedStatus(existing.status)) {
    logReview('skipped', {
      reason: 'already_resolved',
      source: input.incoming_source_name,
      incoming: input.incoming_payload.title ?? sourceUrl,
      candidate_event_id: candidateId,
      status: existing.status,
      review_id: existing.id,
    })
    return 'skipped_resolved'
  }

  const row = {
    status: 'pending' as const,
    incoming_source_name: input.incoming_source_name,
    incoming_source_url: sourceUrl,
    incoming_payload: input.incoming_payload,
    candidate_event_id: candidateId,
    duplicate_status: input.duplicate_status,
    reason: input.reason,
    scores: input.scores,
    updated_at: new Date().toISOString(),
  }

  if (existing && existing.status === 'pending') {
    const { error: updErr } = await client
      .from('event_dedupe_reviews')
      .update({
        incoming_payload: row.incoming_payload,
        duplicate_status: row.duplicate_status,
        reason: row.reason,
        scores: row.scores,
        updated_at: row.updated_at,
      })
      .eq('id', existing.id)
      .eq('status', 'pending')

    if (updErr) throw updErr

    logReview('pending', {
      source: input.incoming_source_name,
      incoming: input.incoming_payload.title ?? sourceUrl,
      candidate_event_id: candidateId,
      status: input.duplicate_status,
      action: 'review_updated',
      review_id: existing.id,
    })
    return 'updated_pending'
  }

  const { data: inserted, error: insErr } = await client
    .from('event_dedupe_reviews')
    .insert(row)
    .select('id')
    .single()

  if (insErr) throw insErr

  logReview('pending', {
    source: input.incoming_source_name,
    incoming: input.incoming_payload.title ?? sourceUrl,
    candidate_event_id: candidateId,
    status: input.duplicate_status,
    action: 'review_saved',
    review_id: inserted?.id ?? null,
  })
  return 'inserted'
}
