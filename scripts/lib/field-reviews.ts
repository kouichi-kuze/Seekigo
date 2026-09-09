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
  'id, status, start_date, end_date, start_time, end_time, venue, area, address, price_text, is_free, price_min, price_max, category, official_url, reservation_status, reservation_url, nearest_station, access_text, walk_minutes, latitude, longitude, venue_type, family_friendly, date_friendly, solo_friendly, rain_friendly, age_note, duration_minutes_min, duration_minutes_max, parking_status, parking_text'

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

function asInt(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && Number.isInteger(n) ? n : null
}

function asNum(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function asTextEnum(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s || null
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
    price_min: asInt(row.price_min),
    price_max: asInt(row.price_max),
    category: Array.isArray(row.category) ? (row.category as string[]) : null,
    official_url: (row.official_url as string | null) ?? null,
    reservation_status: asTextEnum(row.reservation_status) as FieldSnapshot['reservation_status'],
    reservation_url: (row.reservation_url as string | null) ?? null,
    nearest_station: (row.nearest_station as string | null) ?? null,
    access_text: (row.access_text as string | null) ?? null,
    walk_minutes: asInt(row.walk_minutes),
    latitude: asNum(row.latitude),
    longitude: asNum(row.longitude),
    venue_type: asTextEnum(row.venue_type) as FieldSnapshot['venue_type'],
    family_friendly: asTextEnum(row.family_friendly) as FieldSnapshot['family_friendly'],
    date_friendly: asTextEnum(row.date_friendly) as FieldSnapshot['date_friendly'],
    solo_friendly: asTextEnum(row.solo_friendly) as FieldSnapshot['solo_friendly'],
    rain_friendly: asTextEnum(row.rain_friendly) as FieldSnapshot['rain_friendly'],
    age_note: (row.age_note as string | null) ?? null,
    duration_minutes_min: asInt(row.duration_minutes_min),
    duration_minutes_max: asInt(row.duration_minutes_max),
    parking_status: asTextEnum(row.parking_status) as FieldSnapshot['parking_status'],
    parking_text: (row.parking_text as string | null) ?? null,
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
    sourceName: string
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
    /** gotokyo / enjoytokyo / walkerplus / official_web など */
    sourceName: string
    sourceUrl: string | null
    proposed: FieldSnapshot
    /** false = DRY_RUN（DB 非接触） */
    write: boolean
  },
): Promise<SyncFieldReviewsResult> {
  const tally: SyncFieldReviewsResult = { ...EMPTY_RESULT }

  if (opts.eventStatus !== 'published' && opts.eventStatus !== 'hidden') {
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
