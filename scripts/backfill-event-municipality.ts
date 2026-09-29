/**
 * 公開イベントの municipality だけを埋める。area は変えない。
 * 既に municipality がある行は更新しない。
 *
 * inferMunicipalitySlug の優先順（住所 → 会場文 → area 対応）に従う。
 * area スラッグ tama や「多摩」だけでは多摩市にしない。
 * 住所に別の自治体があるとき、ueno などの area 対応では上書きしない。
 *
 * DRY_RUN=true（デフォルト）: 予定だけ表示
 * DRY_RUN=false: municipality が NULL の published 行だけ UPDATE
 */

import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  MUNICIPALITY_REVIEW_AREA_SLUGS,
  inferMunicipalitySlug,
} from '../src/lib/event-field-rules'

config()

const LOG = '[backfill-municipality]'
const DRY_RUN = process.env.DRY_RUN !== 'false'
const REVIEW = new Set<string>(MUNICIPALITY_REVIEW_AREA_SLUGS)

type Row = {
  id: number
  status: string
  area: string | null
  address: string | null
  municipality: string | null
  title: string | null
}

function createServiceClient(): SupabaseClient {
  const url =
    process.env.PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim()
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url) throw new Error('PUBLIC_SUPABASE_URL (or SUPABASE_URL) is missing')
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is missing')
  if (serviceKey === process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    throw new Error('Refusing to use PUBLIC_SUPABASE_PUBLISHABLE_KEY')
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

async function main() {
  console.log(`${LOG} start`)
  console.log(`${LOG} DRY_RUN: ${DRY_RUN}`)

  const supabase = createServiceClient()
  const baseSelect = 'id, status, area, address, title'
  const withMunicipality = await supabase
    .from('events')
    .select(`${baseSelect}, municipality`)
    .eq('status', 'published')
    .order('id', { ascending: true })

  let rows: Row[]
  if (withMunicipality.error) {
    const message = withMunicipality.error.message
    const missingColumn = /municipality/i.test(message)
    if (!missingColumn || !DRY_RUN) {
      throw new Error(
        missingColumn
          ? 'events.municipality がありません。先に scripts/migrate-add-event-municipality.sql を適用してください。'
          : message,
      )
    }
    console.log(`${LOG} note: municipality column is not applied yet. Planning against area and address only.`)
    const fallback = await supabase
      .from('events')
      .select(baseSelect)
      .eq('status', 'published')
      .order('id', { ascending: true })
    if (fallback.error) throw new Error(fallback.error.message)
    rows = ((fallback.data ?? []) as Omit<Row, 'municipality'>[]).map((row) => ({
      ...row,
      municipality: null,
    }))
  } else {
    rows = (withMunicipality.data ?? []) as Row[]
  }

  const byMunicipality: Record<string, number> = {}
  const planned: Array<{ id: number; area: string | null; municipality: string }> = []
  let alreadySet = 0
  let review = 0
  let addressNeedsSlug = 0
  let unknown = 0

  for (const row of rows) {
    const areaKey = row.area?.trim().toLowerCase() || ''
    const inferred = inferMunicipalitySlug({
      area: row.area,
      address: row.address,
    })
    const addressText = row.address?.normalize('NFKC') ?? ''
    const bareTama =
      areaKey === 'tama' &&
      inferred === 'tama' &&
      !addressText.includes('多摩市')

    if (row.municipality?.trim()) {
      alreadySet += 1
      continue
    }
    if (bareTama || !inferred) {
      const unlisted = /府中市|小平市/.test(addressText)
      if (areaKey && REVIEW.has(areaKey)) review += 1
      else if (unlisted) addressNeedsSlug += 1
      else unknown += 1
      continue
    }

    planned.push({
      id: row.id,
      area: row.area,
      municipality: inferred,
    })
    byMunicipality[inferred] = (byMunicipality[inferred] ?? 0) + 1
  }

  console.log(`${LOG} published: ${rows.length}`)
  console.log(`${LOG} would_update: ${planned.length}`)
  console.log(`${LOG} already_set: ${alreadySet}`)
  console.log(`${LOG} skipped_review: ${review}`)
  console.log(`${LOG} skipped_address_needs_slug: ${addressNeedsSlug}`)
  console.log(`${LOG} skipped_unknown: ${unknown}`)
  console.log(`${LOG} area_updates: 0`)
  const sorted = Object.entries(byMunicipality).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  for (const [slug, count] of sorted) {
    console.log(`${LOG} municipality ${slug}: ${count}`)
  }

  if (DRY_RUN) {
    console.log(`${LOG} done (dry-run, no DB write)`)
    return
  }

  let updated = 0
  for (const row of planned) {
    const { data: written, error: updateError } = await supabase
      .from('events')
      .update({ municipality: row.municipality })
      .eq('id', row.id)
      .eq('status', 'published')
      .is('municipality', null)
      .select('id, area, municipality')

    if (updateError) {
      console.error(`${LOG} update failed id=${row.id}: ${updateError.message}`)
      process.exitCode = 1
      continue
    }
    const saved = written?.[0] as { area: string | null; municipality: string | null } | undefined
    if (!saved) continue
    if ((saved.area ?? null) !== (row.area ?? null)) {
      console.error(`${LOG} area changed unexpectedly id=${row.id}`)
      process.exitCode = 1
      continue
    }
    updated += 1
  }
  console.log(`${LOG} updated: ${updated}`)
  console.log(`${LOG} done`)
}

main().catch((error) => {
  console.error(LOG, error instanceof Error ? error.message : error)
  process.exit(1)
})
