/**
 * DEV admin: dedupe review 操作（link / create_new / reject）。
 * published 本体は変更しない。create_new は必ず draft。
 */
import { createHash } from 'node:crypto'
import { createAdminClient } from './supabase-admin'
import {
  parsePositiveIntIds,
  readAdminPostForm,
  verifyAdminCsrf,
} from './admin-security'
import {
  cleanAddressAccess,
  inferIsFreeFromPriceText,
  resolveAreaSlug,
} from './event-field-rules'
import { defaultImageMetaForSource } from './event-image-usage'
import {
  ensureEventSource,
  extractEnjoytokyoEventId,
  extractGotokyoSpotId,
  extractWalkerplusEventId,
  type EventSourceName,
} from './event-sources'

type AdminCookies = {
  get: (name: string) => { value: string } | undefined
}

export type AdminReviewResult =
  | { ok: true; redirectTo: string }
  | { ok: false; message: string }

type IncomingPayload = {
  title?: string | null
  start_date?: string | null
  end_date?: string | null
  start_time?: string | null
  end_time?: string | null
  venue?: string | null
  area?: string | null
  official_url?: string | null
  source_url?: string | null
  source_event_id?: string | null
  price_text?: string | null
  is_free?: boolean | null
  address?: string | null
  category?: string[] | null
  summary?: string | null
  image_url?: string | null
}

type ReviewRow = {
  id: number
  status: string
  incoming_source_name: string
  incoming_source_url: string
  incoming_payload: IncomingPayload
  candidate_event_id: number | null
  duplicate_status: string
}

function resolveSourceEventId(
  sourceName: EventSourceName,
  sourceUrl: string,
  payloadId?: string | null,
): string | null {
  if (payloadId) return payloadId
  if (sourceName === 'gotokyo') return extractGotokyoSpotId(sourceUrl)
  if (sourceName === 'walkerplus') return extractWalkerplusEventId(sourceUrl)
  return extractEnjoytokyoEventId(sourceUrl)
}

function generateDraftSlug(
  sourceName: EventSourceName,
  title: string,
  startDate: string,
  sourceUrl: string,
): string {
  const year = startDate.slice(0, 4)

  if (sourceName === 'gotokyo') {
    const spot = extractGotokyoSpotId(sourceUrl)
    if (spot) return `gotokyo-${spot}-${year}`
  }
  if (sourceName === 'enjoytokyo') {
    const eid = extractEnjoytokyoEventId(sourceUrl)
    if (eid) return `enjoytokyo-${eid}-${year}`
  }
  if (sourceName === 'walkerplus') {
    const wid = extractWalkerplusEventId(sourceUrl)
    if (wid) return `walkerplus-${wid}-${year}`
  }

  const normalized = title.normalize('NFKC').trim().toLowerCase()
  const hash = createHash('sha1')
    .update(`seekigo-review:${sourceName}:${normalized}:${year}:${sourceUrl}`)
    .digest('hex')
    .slice(0, 12)
  return `${sourceName}-${hash}-${year}`
}

async function markReview(
  admin: ReturnType<typeof createAdminClient>,
  reviewId: number,
  patch: {
    status: 'linked' | 'created' | 'rejected'
    review_action: 'link_existing' | 'create_new' | 'reject'
    resolved_event_id?: number | null
  },
) {
  const { data, error } = await admin
    .from('event_dedupe_reviews')
    .update({
      status: patch.status,
      review_action: patch.review_action,
      resolved_event_id: patch.resolved_event_id ?? null,
      decided_by: 'local_admin',
      decided_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', reviewId)
    .eq('status', 'pending')
    .select('id')

  if (error) throw error
  if (!data || data.length === 0) {
    throw new Error('Review is no longer pending')
  }
}

async function loadPendingReview(
  admin: ReturnType<typeof createAdminClient>,
  reviewId: number,
): Promise<ReviewRow> {
  const { data, error } = await admin
    .from('event_dedupe_reviews')
    .select(
      'id, status, incoming_source_name, incoming_source_url, incoming_payload, candidate_event_id, duplicate_status',
    )
    .eq('id', reviewId)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error(`Review id=${reviewId} not found`)
  if (data.status !== 'pending') {
    throw new Error(`Review is not pending (status=${data.status})`)
  }
  return data as ReviewRow
}

async function linkExisting(
  admin: ReturnType<typeof createAdminClient>,
  review: ReviewRow,
): Promise<number> {
  const candidateId = Number(review.candidate_event_id)
  if (!Number.isFinite(candidateId) || candidateId <= 0) {
    throw new Error('candidate_event_id is missing')
  }

  const { data: event, error } = await admin
    .from('events')
    .select('id, status')
    .eq('id', candidateId)
    .maybeSingle()

  if (error) throw error
  if (!event) throw new Error(`Candidate event id=${candidateId} not found`)

  const sourceName = review.incoming_source_name as EventSourceName
  if (sourceName !== 'gotokyo' && sourceName !== 'enjoytokyo') {
    throw new Error(`Invalid source name: ${review.incoming_source_name}`)
  }

  const payload = review.incoming_payload ?? {}
  const sourceUrl =
    (payload.source_url || review.incoming_source_url || '').trim()
  if (!sourceUrl) throw new Error('incoming source_url is missing')

  const sourceEventId = resolveSourceEventId(
    sourceName,
    sourceUrl,
    payload.source_event_id,
  )

  // events 本体は触らない（published / draft 問わず）
  await ensureEventSource(
    admin,
    {
      event_id: candidateId,
      source_name: sourceName,
      source_url: sourceUrl,
      source_event_id: sourceEventId,
      official_url: payload.official_url ?? null,
      last_checked_at: new Date().toISOString(),
    },
    true,
    '[admin-dedupe]',
  )

  await markReview(admin, review.id, {
    status: 'linked',
    review_action: 'link_existing',
    resolved_event_id: candidateId,
  })

  return candidateId
}

async function createNewDraft(
  admin: ReturnType<typeof createAdminClient>,
  review: ReviewRow,
): Promise<number> {
  const sourceName = review.incoming_source_name as EventSourceName
  if (sourceName !== 'gotokyo' && sourceName !== 'enjoytokyo') {
    throw new Error(`Invalid source name: ${review.incoming_source_name}`)
  }

  const payload = review.incoming_payload ?? {}
  const title = String(payload.title ?? '').trim()
  const startDate = String(payload.start_date ?? '').trim()
  const sourceUrl =
    (payload.source_url || review.incoming_source_url || '').trim()

  if (!title) throw new Error('incoming title is required')
  if (!startDate || !isValidYmd(startDate)) {
    throw new Error('incoming start_date is invalid')
  }
  if (!sourceUrl) throw new Error('incoming source_url is required')

  if (payload.end_date != null && payload.end_date !== '') {
    if (!isValidYmd(String(payload.end_date))) {
      throw new Error('incoming end_date is invalid')
    }
  }

  const address =
    cleanAddressAccess(payload.address) ??
    (typeof payload.address === 'string'
      ? payload.address.trim() || null
      : null)
  const area =
    resolveAreaSlug({
      areaHint: payload.area,
      address,
      venue: payload.venue,
    }) ?? null
  const is_free =
    typeof payload.is_free === 'boolean'
      ? payload.is_free
      : inferIsFreeFromPriceText(payload.price_text)
  const slug = generateDraftSlug(sourceName, title, startDate, sourceUrl)
  const now = new Date().toISOString()

  const { data: existingSlug, error: slugErr } = await admin
    .from('events')
    .select('id, status')
    .eq('slug', slug)
    .maybeSingle()
  if (slugErr) throw slugErr
  if (existingSlug) {
    throw new Error(
      `Slug already exists (id=${existingSlug.id}, status=${existingSlug.status}). Use link instead.`,
    )
  }

  const category = Array.isArray(payload.category)
    ? payload.category.filter((c): c is string => typeof c === 'string')
    : []

  const row = {
    title,
    slug,
    official_url: payload.official_url ?? null,
    source_url: sourceUrl,
    venue: payload.venue ?? null,
    area,
    address,
    start_date: startDate,
    end_date: payload.end_date ?? null,
    start_time: payload.start_time ?? null,
    end_time: payload.end_time ?? null,
    price_text: payload.price_text ?? null,
    is_free,
    is_indoor: null,
    is_kids: null,
    is_night: null,
    category,
    summary: payload.summary ?? null,
    image_url: payload.image_url ?? null,
    ...(payload.image_url
      ? defaultImageMetaForSource(
          sourceName === 'gotokyo' ? 'gotokyo' : 'enjoytokyo',
        )
      : {
          image_usage_status: 'unknown' as const,
          image_source: null,
          image_credit: null,
        }),
    status: 'draft' as const,
    last_checked_at: now,
  }

  const { data: inserted, error: insErr } = await admin
    .from('events')
    .insert(row)
    .select('id')
    .single()

  if (insErr) throw insErr
  if (!inserted?.id) throw new Error('insert returned no id')

  const eventId = Number(inserted.id)
  const sourceEventId = resolveSourceEventId(
    sourceName,
    sourceUrl,
    payload.source_event_id,
  )

  await ensureEventSource(
    admin,
    {
      event_id: eventId,
      source_name: sourceName,
      source_url: sourceUrl,
      source_event_id: sourceEventId,
      official_url: payload.official_url ?? null,
      last_checked_at: now,
    },
    true,
    '[admin-dedupe]',
  )

  await markReview(admin, review.id, {
    status: 'created',
    review_action: 'create_new',
    resolved_event_id: eventId,
  })

  return eventId
}

async function rejectReview(
  admin: ReturnType<typeof createAdminClient>,
  review: ReviewRow,
): Promise<void> {
  await markReview(admin, review.id, {
    status: 'rejected',
    review_action: 'reject',
    resolved_event_id: null,
  })
}

/** DEV 用: dedupe review POST を処理 */
export async function processAdminDedupeReviewPost(opts: {
  request: Request
  url: URL
  cookies: AdminCookies
  form?: FormData
}): Promise<AdminReviewResult> {
  const { request, url, cookies } = opts
  const form = opts.form ?? (await readAdminPostForm(request))
  const csrfCheck = verifyAdminCsrf({
    formToken: String(form.get('csrf_token') ?? ''),
    cookieToken: cookies.get('seekigo_admin_csrf')?.value,
    request,
    url,
  })

  if (!csrfCheck.ok) {
    return { ok: false, message: `Security check failed: ${csrfCheck.reason}` }
  }

  const intent = String(form.get('intent') ?? '')
  const ids = parsePositiveIntIds(
    [form.get('review_id')].filter(Boolean) as FormDataEntryValue[],
  )
  if (ids.length !== 1) {
    return { ok: false, message: 'Invalid review id' }
  }
  const reviewId = ids[0]
  const admin = createAdminClient()
  const review = await loadPendingReview(admin, reviewId)

  if (intent === 'dedupe_link') {
    const eventId = await linkExisting(admin, review)
    return {
      ok: true,
      redirectTo: `/admin/events/draft/?review=linked&event_id=${eventId}`,
    }
  }

  if (intent === 'dedupe_create') {
    const eventId = await createNewDraft(admin, review)
    return {
      ok: true,
      redirectTo: `/admin/events/draft/?review=created&event_id=${eventId}`,
    }
  }

  if (intent === 'dedupe_reject') {
    await rejectReview(admin, review)
    return {
      ok: true,
      redirectTo: `/admin/events/draft/?review=rejected&review_id=${reviewId}`,
    }
  }

  return { ok: false, message: 'Invalid dedupe review request' }
}
