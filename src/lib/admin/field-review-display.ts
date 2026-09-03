/**
 * Field review 管理 UI 用ヘルパー（表示・警告のみ。承認判断は人間）。
 */

export type AdminFieldReviewRow = {
  id: number
  event_id: number
  source_name: string
  source_url: string | null
  field_name: string
  current_value: unknown
  proposed_value: unknown
  status: string
  reason: string | null
  created_at: string | null
  decided_at?: string | null
  event_title?: string | null
  event_slug?: string | null
}

/** 一括承認時に目立たせるフィールド */
export const FIELD_REVIEW_SENSITIVE_FIELDS = [
  'title',
  'start_date',
  'end_date',
  'official_url',
  'category',
] as const

export type FieldReviewStatusFilter = 'pending' | 'accepted' | 'rejected'

export const FIELD_REVIEW_STATUS_FILTERS: FieldReviewStatusFilter[] = [
  'pending',
  'accepted',
  'rejected',
]

export function parseFieldReviewStatusFilter(
  raw: string | null | undefined,
): FieldReviewStatusFilter {
  if (raw === 'accepted' || raw === 'rejected') return raw
  return 'pending'
}

export function fieldReviewStatusLabel(status: string): string {
  switch (status) {
    case 'pending':
      return 'Pending'
    case 'accepted':
      return 'Approved'
    case 'rejected':
      return 'Rejected'
    case 'expired':
      return 'Expired'
    default:
      return status
  }
}

export function fieldReviewFieldLabel(fieldName: string): string {
  return fieldName
}

function categoryArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((v) => String(v).trim()).filter(Boolean)
}

/** category 提案が既存より情報を失う「置換」か */
export function isCategoryReplacementWarning(
  current: unknown,
  proposed: unknown,
): boolean {
  const cur = categoryArray(current)
  const prop = categoryArray(proposed)
  if (prop.length === 0) return false
  if (cur.length === 0) return false
  const curSet = new Set(cur)
  const propSet = new Set(prop)
  if (propSet.size === curSet.size && [...propSet].every((p) => curSet.has(p))) {
    return false
  }
  return prop.length <= cur.length || ![...curSet].every((c) => propSet.has(c))
}

/** price_text で提案値の情報量が明らかに少ない */
export function isPriceTextInfoLossWarning(
  current: unknown,
  proposed: unknown,
): boolean {
  const cur = String(current ?? '').trim()
  const prop = String(proposed ?? '').trim()
  if (!cur || !prop) return false
  if (prop.length >= cur.length) return false
  if (cur.length < 8) return false
  return prop.length < cur.length * 0.65
}

export function getFieldReviewWarnings(
  fieldName: string,
  current: unknown,
  proposed: unknown,
): string[] {
  const warnings: string[] = []
  if (
    (FIELD_REVIEW_SENSITIVE_FIELDS as readonly string[]).includes(fieldName)
  ) {
    warnings.push('重要フィールドの変更です。内容をよく確認してください。')
  }
  if (fieldName === 'category' && isCategoryReplacementWarning(current, proposed)) {
    warnings.push(
      'category は置換です。既存のタグが失われる可能性があります（merge ではありません）。',
    )
  }
  if (fieldName === 'price_text' && isPriceTextInfoLossWarning(current, proposed)) {
    warnings.push(
      'price_text の提案値は現在値より情報量が少ない可能性があります。',
    )
  }
  return warnings
}

export function groupFieldReviewsByEvent(
  reviews: AdminFieldReviewRow[],
): Map<number, AdminFieldReviewRow[]> {
  const map = new Map<number, AdminFieldReviewRow[]>()
  for (const r of reviews) {
    const list = map.get(r.event_id) ?? []
    list.push(r)
    map.set(r.event_id, list)
  }
  return map
}

export function formatReviewTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
  } catch {
    return iso
  }
}
