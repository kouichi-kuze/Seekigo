/**
 * DEV admin: イベント物理削除（Danger Zone のみ）。
 * soft delete は deleted_at migration 後に切替可能（scripts/migrate-add-deleted-at.sql 参照）。
 */
import { createAdminClient } from './supabase-admin'
import {
  parsePositiveIntIds,
  readAdminPostForm,
  verifyAdminCsrf,
} from './admin-security'

type AdminCookies = {
  get: (name: string) => { value: string } | undefined
}

export type AdminDeleteResult =
  | { ok: true; redirectTo: string }
  | { ok: false; message: string }

export async function processAdminDeletePost(opts: {
  request: Request
  url: URL
  cookies: AdminCookies
  form?: FormData
}): Promise<AdminDeleteResult> {
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
  if (intent !== 'delete_event') {
    return { ok: false, message: 'Invalid delete request' }
  }

  const ids = parsePositiveIntIds(
    [form.get('event_id')].filter(Boolean) as FormDataEntryValue[],
  )
  if (ids.length !== 1) {
    return { ok: false, message: 'Invalid event id' }
  }
  const eventId = ids[0]

  const confirm = String(form.get('confirm_delete') ?? '').trim()
  if (confirm !== String(eventId)) {
    return {
      ok: false,
      message: '確認のため event id を正確に入力してください',
    }
  }

  const admin = createAdminClient()
  const { data: existing, error: selErr } = await admin
    .from('events')
    .select('id, title')
    .eq('id', eventId)
    .maybeSingle()

  if (selErr) throw selErr
  if (!existing) {
    return { ok: false, message: `Event id=${eventId} not found` }
  }

  const { error: delErr } = await admin.from('events').delete().eq('id', eventId)
  if (delErr) throw delErr

  const title = encodeURIComponent(String(existing.title ?? eventId))
  return {
    ok: true,
    redirectTo: `/admin/events/all/?deleted=1&title=${title}`,
  }
}
