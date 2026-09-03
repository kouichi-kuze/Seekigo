/**
 * 管理画面イベント一覧の並び順（運用優先）。
 * 開催終了判定は display.isEventEnded を再利用する。
 */
import { isEventEnded, tokyoTodayYmd } from '../display'
import type { AdminEvent } from './types'

export type AdminEventScheduleGroup =
  | 'ongoing'
  | 'upcoming'
  | 'unknown'
  | 'ended'

const GROUP_RANK: Record<AdminEventScheduleGroup, number> = {
  upcoming: 0,
  ongoing: 1,
  unknown: 2,
  ended: 3,
}

function isValidYmd(value: string | null | undefined): boolean {
  if (!value?.trim()) return false
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
}

/** 一覧用の開催区分（isEventEnded と整合） */
export function getAdminEventScheduleGroup(
  event: Pick<AdminEvent, 'start_date' | 'end_date'>,
  today: string = tokyoTodayYmd(),
): AdminEventScheduleGroup {
  return classifyAdminEventTiming(event, today)
}

/** getAdminEventScheduleGroup の別名（管理画面デバッグ・ドキュメント用） */
export function classifyAdminEventTiming(
  event: Pick<AdminEvent, 'start_date' | 'end_date'>,
  today: string = tokyoTodayYmd(),
): AdminEventScheduleGroup {
  const start = event.start_date?.trim() ?? ''
  if (!start || !isValidYmd(start)) {
    return 'unknown'
  }
  if (isEventEnded(event.start_date, event.end_date, today)) {
    return 'ended'
  }
  if (start > today) {
    return 'upcoming'
  }
  return 'ongoing'
}

/** DEV ログ用: グループ + グループ内ソートキー */
export function getAdminEventSortKey(
  event: AdminEvent,
  today: string = tokyoTodayYmd(),
): string {
  const group = classifyAdminEventTiming(event, today)
  switch (group) {
    case 'ongoing':
      return `${group}:${event.start_date?.trim() ?? ''}`
    case 'upcoming':
      return `${group}:${event.start_date?.trim() ?? ''}`
    case 'unknown':
      return `${group}:${event.updated_at ?? ''}`
    case 'ended':
      return `${group}:${endedSortKey(event)}`
    default:
      return group
  }
}

function compareYmdAsc(a: string | null | undefined, b: string | null | undefined): number {
  const aa = a?.trim() ?? ''
  const bb = b?.trim() ?? ''
  if (!aa && !bb) return 0
  if (!aa) return 1
  if (!bb) return -1
  return aa.localeCompare(bb)
}

function compareYmdDesc(a: string | null | undefined, b: string | null | undefined): number {
  return compareYmdAsc(b, a)
}

function endedSortKey(event: AdminEvent): string {
  return event.end_date?.trim() || event.start_date?.trim() || ''
}

function compareWithinGroup(
  a: AdminEvent,
  b: AdminEvent,
  group: AdminEventScheduleGroup,
): number {
  switch (group) {
    case 'ongoing':
      return compareYmdDesc(a.start_date, b.start_date)
    case 'upcoming':
      return compareYmdAsc(a.start_date, b.start_date)
    case 'unknown':
      return (b.updated_at ?? '').localeCompare(a.updated_at ?? '')
    case 'ended':
      return compareYmdDesc(endedSortKey(a), endedSortKey(b))
    default:
      return 0
  }
}

/** All / Published / Hidden 向け: これから → 開催中 → 日付不明 → 終了 */
export function sortAdminEventsOperational(
  events: AdminEvent[],
  today: string = tokyoTodayYmd(),
): AdminEvent[] {
  return [...events].sort((a, b) => {
    const ga = classifyAdminEventTiming(a, today)
    const gb = classifyAdminEventTiming(b, today)
    if (ga !== gb) return GROUP_RANK[ga] - GROUP_RANK[gb]
    return compareWithinGroup(a, b, ga)
  })
}

/** Ended ページ向け: 終了日の新しい順 */
export function sortAdminEventsEnded(events: AdminEvent[]): AdminEvent[] {
  return [...events].sort((a, b) => compareYmdDesc(endedSortKey(a), endedSortKey(b)))
}
