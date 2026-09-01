/**
 * Admin Phase 2 最終確認用（本番データを壊さない read + 限定 write テスト）
 * 使い方: npx tsx scripts/verify-admin-phase2.ts [--apply-hide-test]
 *
 * --apply-hide-test: published イベント1件を hidden → 即 published に戻す往復テスト
 */
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

config()

const APPLY_HIDE_TEST = process.argv.includes('--apply-hide-test')

const url = process.env.PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が必要です')
  process.exit(1)
}

const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
})

type Row = { id: number; status: string; title: string | null; slug: string | null }

async function countByStatus() {
  const { data, error } = await admin.from('events').select('status')
  if (error) throw error
  const counts: Record<string, number> = {}
  for (const r of data ?? []) {
    counts[r.status] = (counts[r.status] ?? 0) + 1
  }
  return counts
}

async function pickPublished(): Promise<Row | null> {
  const { data, error } = await admin
    .from('events')
    .select('id, status, title, slug')
    .eq('status', 'published')
    .not('slug', 'is', null)
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data as Row | null
}

async function testHiddenConstraint() {
  const pub = await pickPublished()
  if (!pub) return { ok: false, reason: 'published イベントなし' }

  const { error: hideErr } = await admin
    .from('events')
    .update({ status: 'hidden', updated_at: new Date().toISOString() })
    .eq('id', pub.id)
    .eq('status', 'published')

  if (hideErr) {
    return {
      ok: false,
      reason: hideErr.message,
      hint: 'migrate-add-hidden-status.sql 未適用の可能性',
    }
  }

  const { data: hidden, error: selErr } = await admin
    .from('events')
    .select('id, status')
    .eq('id', pub.id)
    .maybeSingle()
  if (selErr) throw selErr
  if (hidden?.status !== 'hidden') {
    return { ok: false, reason: `hide 後 status=${hidden?.status}` }
  }

  const { error: unhideErr } = await admin
    .from('events')
    .update({ status: 'published', updated_at: new Date().toISOString() })
    .eq('id', pub.id)
    .eq('status', 'hidden')
  if (unhideErr) throw unhideErr

  const { data: restored } = await admin
    .from('events')
    .select('status')
    .eq('id', pub.id)
    .maybeSingle()

  return {
    ok: restored?.status === 'published',
    eventId: pub.id,
    title: pub.title,
    slug: pub.slug,
  }
}

async function main() {
  console.log('=== Admin Phase 2 DB 確認 ===\n')

  const counts = await countByStatus()
  console.log('status 別件数:', counts)
  console.log('draft 件数:', counts.draft ?? 0)

  const { data: drafts } = await admin
    .from('events')
    .select('id, title')
    .eq('status', 'draft')
    .limit(5)
  console.log(
    'draft サンプル:',
    (drafts ?? []).map((d) => `#${d.id} ${d.title?.slice(0, 30) ?? ''}`),
  )

  if (APPLY_HIDE_TEST) {
    console.log('\n--- hide ↔ published 往復テスト ---')
    const result = await testHiddenConstraint()
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(
      '\nhide 往復テストはスキップ（--apply-hide-test で実行。published 1件を一時 hidden にします）',
    )
  }

  // hidden が公開クエリに含まれないか
  const { data: publicRows, error: pubErr } = await admin
    .from('events')
    .select('id')
    .eq('status', 'published')
  if (pubErr) throw pubErr
  const { data: hiddenRows } = await admin
    .from('events')
    .select('id, slug')
    .eq('status', 'hidden')
  const hiddenIds = new Set((hiddenRows ?? []).map((r) => r.id))
  const leak = (publicRows ?? []).filter((r) => hiddenIds.has(r.id))
  console.log('\n公開クエリと hidden の重複:', leak.length === 0 ? 'なし ✓' : leak)
  if (hiddenRows?.length) {
    console.log('hidden イベント:', hiddenRows)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
