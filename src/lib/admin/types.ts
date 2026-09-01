/** Admin 画面共通の events 行型 */
export type AdminEvent = {
  id: number | string
  title: string | null
  slug: string | null
  area: string | null
  start_date: string | null
  end_date: string | null
  start_time?: string | null
  end_time?: string | null
  venue: string | null
  address?: string | null
  category: string[] | null
  summary: string | null
  source_url: string | null
  official_url: string | null
  price_text?: string | null
  status: string | null
  image_url?: string | null
  image_usage_status?: string | null
  image_source?: string | null
  image_credit?: string | null
  updated_at?: string | null
}

export const ADMIN_EVENT_SELECT =
  'id, title, slug, area, start_date, end_date, start_time, end_time, venue, address, category, summary, source_url, official_url, price_text, status, image_url, image_usage_status, image_source, image_credit, updated_at'

export const ADMIN_EVENT_SELECT_BASE =
  'id, title, slug, area, start_date, end_date, venue, address, category, summary, source_url, official_url, status'
