/**
 * 一括画像生成の対象判定。
 * 生成そのものは generateEventImage に任せ、ここでは開催と未着手だけを見る。
 */
import { DISPLAYABLE_IMAGE_USAGE_STATUSES } from './event-image-usage'
import type { ScheduleStatus } from './event-schedule'

export const BULK_IMAGE_EVENT_SELECT =
  'id, title, status, start_date, end_date, image_url, image_usage_status, generated_image_url, generated_image_status, generated_image_source, generated_image_instruction'

export type BulkImageEvent = {
  id: number
  title: string | null
  status: string | null
  start_date: string | null
  end_date: string | null
  image_url: string | null
  image_usage_status: string | null
  generated_image_url: string | null
  generated_image_status: string | null
  generated_image_source: string | null
  generated_image_instruction: string | null
}

export const BULK_IMAGE_EXCLUSIONS = [
  'not_active',
  'generated_status',
  'generated_url',
  'generated_source',
  'generated_instruction',
  'official_image',
  'image_forbidden',
] as const

export type BulkImageExclusion = (typeof BULK_IMAGE_EXCLUSIONS)[number]

export const BULK_IMAGE_EXCLUSION_LABELS: Record<BulkImageExclusion, string> = {
  not_active: '開催中・今後開催ではない',
  generated_status: 'generated_image_status が none ではない',
  generated_url: 'generated_image_url がある',
  generated_source: 'generated_image_source がある',
  generated_instruction: 'generated_image_instruction がある',
  official_image: '権利確認済みの公式画像がある',
  image_forbidden: 'image_usage_status が forbidden',
}

function filled(value: string | null | undefined): boolean {
  return Boolean(value?.trim())
}

export function isActiveSchedule(status: ScheduleStatus | null): boolean {
  return status === 'today' || status === 'upcoming'
}

/** 空なら対象。理由は複数あり得る。 */
export function bulkImageExclusionReasons(
  event: BulkImageEvent,
  scheduleStatus: ScheduleStatus | null,
): BulkImageExclusion[] {
  const reasons: BulkImageExclusion[] = []
  if (event.status !== 'published' || !isActiveSchedule(scheduleStatus)) {
    reasons.push('not_active')
  }
  const generatedStatus = event.generated_image_status?.trim() || 'none'
  if (generatedStatus !== 'none') reasons.push('generated_status')
  if (filled(event.generated_image_url)) reasons.push('generated_url')
  if (filled(event.generated_image_source)) reasons.push('generated_source')
  if (filled(event.generated_image_instruction)) reasons.push('generated_instruction')
  const usage = event.image_usage_status?.trim() ?? ''
  if (
    filled(event.image_url) &&
    (DISPLAYABLE_IMAGE_USAGE_STATUSES as readonly string[]).includes(usage)
  ) {
    reasons.push('official_image')
  }
  if (usage === 'forbidden') reasons.push('image_forbidden')
  return reasons
}

export function isBulkImageCandidate(
  event: BulkImageEvent,
  scheduleStatus: ScheduleStatus | null,
): boolean {
  return bulkImageExclusionReasons(event, scheduleStatus).length === 0
}
