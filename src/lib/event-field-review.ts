/**
 * published イベントのフィールド差分レビュー。
 * - sync は差分検知のみ（本体非変更）
 * - summary は AI 再生成ノイズのため対象外
 * - title / image_* / slug / status も対象外
 */
import { createHash } from 'node:crypto'
import { cleanAddressAccess } from './event-field-rules'
import { normalizeHmToDb } from './event-time-rules'
import { normalizeUrl, normalizeVenue } from './event-dedupe'

/** sync / admin でレビュー可能なフィールド（明示マップ） */
export const REVIEWABLE_FIELD_NAMES = [
  'start_date',
  'end_date',
  'start_time',
  'end_time',
  'venue',
  'area',
  'address',
  'price_text',
  'is_free',
  'category',
  'official_url',
] as const

export type ReviewableFieldName = (typeof REVIEWABLE_FIELD_NAMES)[number]

/**
 * summary を除外した理由:
 * - gotokyo: enrich が毎 sync で summary を再生成し、exact 時は published に載らないが
 *   incoming 側は毎回文言が揺れる → 差分ノイズ多発
 * - enjoytokyo: description 切り詰め / AI draft 経路があり、安定比較が難しい
 * - published の curated summary をソース由来要約で置き換えるのは危険
 */
export const SUMMARY_EXCLUDED_FROM_FIELD_REVIEW = true

/** field_name → events カラム（任意名を SQL に渡さない） */
export const REVIEWABLE_FIELD_COLUMN: Record<
  ReviewableFieldName,
  ReviewableFieldName
> = {
  start_date: 'start_date',
  end_date: 'end_date',
  start_time: 'start_time',
  end_time: 'end_time',
  venue: 'venue',
  area: 'area',
  address: 'address',
  price_text: 'price_text',
  is_free: 'is_free',
  category: 'category',
  official_url: 'official_url',
}

export type FieldSnapshot = {
  start_date?: string | null
  end_date?: string | null
  start_time?: string | null
  end_time?: string | null
  venue?: string | null
  area?: string | null
  address?: string | null
  price_text?: string | null
  is_free?: boolean | null
  category?: string[] | null
  official_url?: string | null
}

export type FieldDiff = {
  field_name: ReviewableFieldName
  current_value: unknown
  proposed_value: unknown
  proposal_hash: string
  reason: string
}

export function isReviewableFieldName(
  value: unknown,
): value is ReviewableFieldName {
  return (
    typeof value === 'string' &&
    (REVIEWABLE_FIELD_NAMES as readonly string[]).includes(value)
  )
}

function normalizeDateYmd(value: unknown): string | null {
  if (value == null) return null
  const s = String(value).trim()
  if (!s) return null
  // Postgres date / ISO date
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

function normalizeWhitespaceText(value: unknown): string | null {
  if (value == null) return null
  const s = String(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return s || null
}

function normalizeCategory(value: unknown): string[] | null {
  if (value == null) return null
  if (!Array.isArray(value)) return null
  const items = [
    ...new Set(
      value
        .map((v) => String(v).trim())
        .filter((s) => s.length > 0),
    ),
  ].sort((a, b) => a.localeCompare(b))
  return items.length > 0 ? items : null
}

function normalizeAreaSlug(value: unknown): string | null {
  if (value == null) return null
  const s = String(value).trim().toLowerCase()
  return s || null
}

/** 比較キー（正規化後）。表示用とは別に使う */
export function normalizeFieldForCompare(
  field: ReviewableFieldName,
  value: unknown,
): unknown {
  switch (field) {
    case 'start_date':
    case 'end_date':
      return normalizeDateYmd(value)
    case 'start_time':
    case 'end_time':
      return normalizeHmToDb(
        value == null ? null : String(value),
      )
    case 'venue': {
      const v = normalizeVenue(value == null ? null : String(value))
      return v || null
    }
    case 'area':
      return normalizeAreaSlug(value)
    case 'address': {
      const cleaned = cleanAddressAccess(
        value == null ? null : String(value),
      )
      if (!cleaned) return null
      // 比較: NFKC + 空白（venue ほど攻撃的ではない）
      return (
        cleaned
          .normalize('NFKC')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase() || null
      )
    }
    case 'price_text':
      return normalizeWhitespaceText(value)
    case 'is_free':
      if (value === true || value === false) return value
      return null
    case 'category':
      return normalizeCategory(value)
    case 'official_url':
      return normalizeUrl(value == null ? null : String(value))
    default:
      return null
  }
}

/** DB / UI 向けの保存値（意味を壊さない軽い正規化） */
export function normalizeFieldForStorage(
  field: ReviewableFieldName,
  value: unknown,
): unknown {
  switch (field) {
    case 'start_date':
    case 'end_date':
      return normalizeDateYmd(value)
    case 'start_time':
    case 'end_time':
      return normalizeHmToDb(value == null ? null : String(value))
    case 'venue': {
      if (value == null) return null
      const s = String(value).normalize('NFKC').replace(/\s+/g, ' ').trim()
      return s || null
    }
    case 'area':
      return normalizeAreaSlug(value)
    case 'address':
      return cleanAddressAccess(value == null ? null : String(value))
    case 'price_text':
      return normalizeWhitespaceText(value)
    case 'is_free':
      if (value === true || value === false) return value
      return null
    case 'category':
      return normalizeCategory(value)
    case 'official_url': {
      if (value == null) return null
      const s = String(value).trim()
      return s || null
    }
    default:
      return null
  }
}

export function fieldValuesEqual(
  field: ReviewableFieldName,
  a: unknown,
  b: unknown,
): boolean {
  const na = normalizeFieldForCompare(field, a)
  const nb = normalizeFieldForCompare(field, b)
  if (na === null && nb === null) return true
  if (na === null || nb === null) return false
  if (field === 'category') {
    return JSON.stringify(na) === JSON.stringify(nb)
  }
  if (field === 'is_free') return na === nb
  return na === nb
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as object).sort()
    return `{${keys
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`
  }
  return JSON.stringify(String(value))
}

export function hashProposedValue(
  field: ReviewableFieldName,
  proposedStorage: unknown,
): string {
  // 比較キー基準で hash（表記ゆれで増殖しない）
  const key = normalizeFieldForCompare(field, proposedStorage)
  const payload = `${field}:${canonicalJson(key)}`
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

/**
 * published(current) vs incoming(proposed) の差分。
 * - 値あり → null は ignore（取得失敗で消さない）
 * - null → 値あり は候補
 */
export function computeFieldDiffs(
  current: FieldSnapshot,
  proposed: FieldSnapshot,
): FieldDiff[] {
  const diffs: FieldDiff[] = []

  for (const field of REVIEWABLE_FIELD_NAMES) {
    const curRaw = current[field]
    const propRaw = proposed[field]

    const curStore = normalizeFieldForStorage(field, curRaw)
    const propStore = normalizeFieldForStorage(field, propRaw)

    // proposed が実質 null → 自動 review しない
    const propCompare = normalizeFieldForCompare(field, propStore)
    if (propCompare === null || propCompare === undefined) {
      continue
    }
    if (Array.isArray(propCompare) && propCompare.length === 0) {
      continue
    }

    if (fieldValuesEqual(field, curStore, propStore)) {
      continue
    }

    const curCompare = normalizeFieldForCompare(field, curStore)
    const curEmpty =
      curCompare === null ||
      curCompare === undefined ||
      (Array.isArray(curCompare) && curCompare.length === 0)

    const reason = curEmpty
      ? `${field}: null → value`
      : `${field}: value changed`

    diffs.push({
      field_name: field,
      current_value: curStore,
      proposed_value: propStore,
      proposal_hash: hashProposedValue(field, propStore),
      reason,
    })
  }

  return diffs
}

/** admin accept: jsonb → DB 更新値 */
export function coerceProposedToDbValue(
  field: ReviewableFieldName,
  proposed: unknown,
): unknown {
  return normalizeFieldForStorage(field, proposed)
}

/** 表示用（admin） */
export function formatFieldValueForDisplay(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : value.join(', ')
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  const s = String(value)
  return s.length === 0 ? '""' : s
}
