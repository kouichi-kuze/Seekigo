/**
 * events.status の共通定義（公開・sync 保護）。
 * DB CHECK 制約は Supabase 側要確認。hidden 追加時は migrate-add-hidden-status.sql を参照。
 */
export const EVENT_STATUSES = ['draft', 'published', 'hidden'] as const

export type EventStatus = (typeof EVENT_STATUSES)[number]

/** 公開サイト・SSG・sitemap に載せる status */
export function isPublicStatus(status: string | null | undefined): boolean {
  return status === 'published'
}

/** sync / import が events 本体を更新してはいけない status */
export function isBodyProtectedFromSync(
  status: string | null | undefined,
): boolean {
  return status === 'published' || status === 'hidden'
}

export function isEventStatus(value: string): value is EventStatus {
  return (EVENT_STATUSES as readonly string[]).includes(value)
}
