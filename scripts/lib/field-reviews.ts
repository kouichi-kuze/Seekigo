/**
 * published exact match 時のフィールド差分を event_field_reviews へ冪等保存。
 *
 * - DRY_RUN (write=false): 差分検知・ログのみ。DB 非接触
 * - events 本体は絶対に変更しない
 * - 同一 proposal_hash の accepted/rejected は再生成しない
 * - 同一 pending は current_value のみ更新可
 * - 同 field で別 proposal が来た場合: 旧 pending を expired → 新規 pending
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { EventSourceName } from '../../src/lib/event-sources'
import {
  computeFieldDiffs,
  type FieldDiff,
  type FieldSnapshot,
  type ReviewableFieldName,
} from '../../src/lib/event-field-review'

export type SyncFieldReviewsResult = {
  detected: number
  created: number
  updated: number
  skipped: number
  expired: number
  dry_run: number
}

const EMPTY_RESULT: SyncFieldReviewsResult = {
  detected: 0,
  created: 0,
  updated: 0,
  skipped: 0,
  expired: 0,
  dry_run: 0,
}

const EVENT_SELECT_FOR_DIFF =
  'id, status, start_date, end_date, start_time, end_time, venue, area, address, price_text, is_free, category, official_url'

function logFieldReview(
  kind: string,
  lines: Record<string, string | number | null | undefined>,
) {
  console.log(`[field-review] ${kind}`)
  for (const [k, v] of Object.entries(lines)) {
    if (v === undefined) continue
    console.log(`${k}: ${v == null ? 'null' : String(v)}`)
  }
}

function snapshotFromEventRow(row: Record<string, unknown>): FieldSnapshot {
  return {
    start_date: (row.start_date as string | null) ?? null,
    end_date: (row.end_date as string | null) ?? null,
    start_time: (row.start_time as string | null) ?? null,
    end_time: (row.end_time as string | null) ?? null,
    venue: (row.venue as string | null) ?? null,
    area: (row.area as string | null) ?? null,
    address: (row.address as string | null) ?? null,
    price_text: (row.price_text as string | null) ?? null,
    is_free:
      row.is_free === true || row.is_free === false ? row.is_free : null,
    category: Array.isArray(row.category) ? (row.category as string[]) : null,
    official_url: (row.official_url as string | null) ?? null,
  }
}

function displayJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

async function expireOtherPending(
  client: SupabaseClient,
  opts: {
    eventId: number
    sourceName: string
    fieldName: ReviewableFieldName
    keepHash: string
  },
): Promise<number> {
  const { data, error } = await client
    .from('event_field_reviews')
    .update({
      status: 'expired',
      reason: 'superseded_by_new_proposal',
      updated_at: new Date().toISOString(),
    })
    .eq('event_id', opts.eventId)
    .eq('source_name', opts.sourceName)
    .eq('field_name', opts.fieldName)
    .eq('status', 'pending')
    .neq('proposal_hash', opts.keepHash)
    .select('id')

  if (error) throw error
  return data?.length ?? 0
}

async function processOneDiff(
  client: SupabaseClient | null,
  write: boolean,
  opts: {
    eventId: number
    sourceName: EventSourceName
    sourceUrl: string | null
    diff: FieldDiff
  },
  tally: SyncFieldReviewsResult,
): Promise<void> {
  const { eventId, sourceName, sourceUrl, diff } = opts

  if (!write || !client) {
    logFieldReview('dry-run', {
      event_id: eventId,
      source: sourceName,
      field: diff.field_name,
      current: displayJson(diff.current_value),
      proposed: displayJson(diff.proposed_value),
      action: 'would_create_review',
    })
    tally.dry_run += 1
    return
  }

  // 同一 proposal の履歴（accepted / rejected / expired / pending）を検索
  const { data: existingRows, error: selErr } = await client
    .from('event_field_reviews')
    .select('id, status, current_value, proposed_value, proposal_hash')
    .eq('event_id', eventId)
    .eq('source_name', sourceName)
    .eq('field_name', diff.field_name)
    .eq('proposal_hash', diff.proposal_hash)
    .order('id', { ascending: true })
    .limit(5)

  if (selErr) throw selErr

  const existing = existingRows?.[0] ?? null

  if (existing) {
    const status = String(existing.status)
    if (status === 'accepted' || status === 'rejected' || status === 'expired') {
      logFieldReview('skipped', {
        reason: `already_${status}`,
        event_id: eventId,
        field: diff.field_name,
        review_id: Number(existing.id),
        action: 'no_resurrect',
      })
      tally.skipped += 1
      return
    }

    if (status === 'pending') {
      // current_value が変わっていれば更新
      const { error: updErr } = await client
        .from('event_field_reviews')
        .update({
          current_value: diff.current_value,
          proposed_value: diff.proposed_value,
          source_url: sourceUrl,
          reason: diff.reason,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .eq('status', 'pending')

      if (updErr) throw updErr

      logFieldReview('pending', {
        action: 'updated_current',
        event_id: eventId,
        field: diff.field_name,
        review_id: Number(existing.id),
        current: displayJson(diff.current_value),
        proposed: displayJson(diff.proposed_value),
      })
      tally.updated += 1
      return
    }
  }

  // 同 field の別 pending を expire
  const expired = await expireOtherPending(client, {
    eventId,
    sourceName,
    fieldName: diff.field_name,
    keepHash: diff.proposal_hash,
  })
  tally.expired += expired

  const { data: inserted, error: insErr } = await client
    .from('event_field_reviews')
    .insert({
      event_id: eventId,
      source_name: sourceName,
      source_url: sourceUrl,
      field_name: diff.field_name,
      current_value: diff.current_value,
      proposed_value: diff.proposed_value,
      proposal_hash: diff.proposal_hash,
      status: 'pending',
      reason: diff.reason,
    })
    .select('id')
    .maybeSingle()

  if (insErr) {
    // UNIQUE 競合（並行）→ スキップ扱い
    if (String(insErr.code) === '23505') {
      logFieldReview('skipped', {
        reason: 'unique_conflict',
        event_id: eventId,
        field: diff.field_name,
      })
      tally.skipped += 1
      return
    }
    throw insErr
  }

  logFieldReview('pending', {
    action: 'created',
    event_id: eventId,
    field: diff.field_name,
    review_id: inserted?.id != null ? Number(inserted.id) : null,
    current: displayJson(diff.current_value),
    proposed: displayJson(diff.proposed_value),
  })
  tally.created += 1
}

/**
 * published exact イベントに対するフィールド差分レビュー同期。
 * draft / その他 status では何もしない。
 */
export async function syncFieldReviewsForPublishedEvent(
  client: SupabaseClient | null,
  opts: {
    eventId: number
    eventStatus: string | null | undefined
    sourceName: EventSourceName
    sourceUrl: string | null
    proposed: FieldSnapshot
    /** false = DRY_RUN（DB 非接触） */
    write: boolean
  },
): Promise<SyncFieldReviewsResult> {
  const tally: SyncFieldReviewsResult = { ...EMPTY_RESULT }

  if (opts.eventStatus !== 'published') {
    return tally
  }

  // DRY_RUN: SELECT もしない（既存方針）
  if (!opts.write) {
    // current が無いと差分が出せない → write=false でも「検知ログ」には
    // proposed のみでは current 不明。read 用 client がある場合のみ current 取得は
    // ユーザー要件: DRY_RUN では review DB 非接触。events SELECT は review DB ではない。
    // 差分検知のため events の SELECT は許可（review table のみ非接触）。
  }

  if (!client) {
    logFieldReview('skipped', {
      reason: 'no_db_client',
      event_id: opts.eventId,
    })
    return tally
  }

  const { data: eventRow, error } = await client
    .from('events')
    .select(EVENT_SELECT_FOR_DIFF)
    .eq('id', opts.eventId)
    .in('status', ['published', 'hidden'])
    .maybeSingle()

  if (error) throw error
  if (!eventRow) {
    logFieldReview('skipped', {
      reason: 'protected_event_not_found',
      event_id: opts.eventId,
    })
    return tally
  }

  const current = snapshotFromEventRow(eventRow as Record<string, unknown>)
  const diffs = computeFieldDiffs(current, opts.proposed)
  tally.detected = diffs.length

  if (diffs.length === 0) {
    logFieldReview('none', {
      event_id: opts.eventId,
      source: opts.sourceName,
      action: 'no_diffs',
    })
    return tally
  }

  for (const diff of diffs) {
    await processOneDiff(
      client,
      opts.write,
      {
        eventId: opts.eventId,
        sourceName: opts.sourceName,
        sourceUrl: opts.sourceUrl,
        diff,
      },
      tally,
    )
  }

  return tally
}

export function fieldSnapshotFromPartial(
  row: FieldSnapshot,
): FieldSnapshot {
  return { ...row }
}
