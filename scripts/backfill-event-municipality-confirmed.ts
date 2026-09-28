/**
 * 監査で確定した公開イベント 25 件だけ municipality を埋める。
 * ID と自治体の対応は固定。会場名や町名からの推測はしない。
 *
 * - municipality が NULL の行だけ更新
 * - area その他の列は変えない
 * DRY_RUN=true（デフォルト）: 予定だけ表示
 * DRY_RUN=false: 上記 25 件のうち municipality IS NULL だけ UPDATE
 */

import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

config()

const LOG = '[backfill-municipality-confirmed]'
const DRY_RUN = process.env.DRY_RUN !== 'false'

/** 監査「確定」25件。この表に無い ID は更新しない。 */
const CONFIRMED_MUNICIPALITY_BY_ID: Record<number, string> = {
  5: 'koto',
  22: 'minato',
  39: 'toshima',
  43: 'toshima',
  54: 'fuchu',
  56: 'musashino',
  61: 'minato',
  69: 'kita',
  70: 'koto',
  79: 'minato',
  80: 'minato',
  82: 'minato',
  84: 'minato',
  85: 'minato',
  88: 'minato',
  89: 'minato',
  93: 'kodaira',
  99: 'chiyoda',
  107: 'chiyoda',
  110: 'chiyoda',
  113: 'toshima',
  114: 'chiyoda',
  117: 'toshima',
  122: 'bunkyo',
  124: 'chiyoda',
}

const TARGET_IDS = Object.keys(CONFIRMED_MUNICIPALITY_BY_ID).map(Number)

type Row = {
  id: number
  status: string
  area: string | null
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
  console.log(`${LOG} targets: ${TARGET_IDS.length}`)

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('events')
    .select('id, status, area, municipality, title')
    .in('id', TARGET_IDS)
    .order('id', { ascending: true })

  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Row[]
  const byId = new Map(rows.map((row) => [row.id, row]))

  const byMunicipality: Record<string, number> = {}
  const planned: Array<{ id: number; area: string | null; municipality: string }> = []
  let alreadySet = 0
  let skipped = 0

  for (const id of TARGET_IDS) {
    const municipality = CONFIRMED_MUNICIPALITY_BY_ID[id]
    const row = byId.get(id)
    if (!row || row.status !== 'published') {
      skipped += 1
      console.log(`${LOG} skipped id=${id} (missing or not published)`)
      continue
    }
    if (row.municipality?.trim()) {
      alreadySet += 1
      continue
    }
    planned.push({ id, area: row.area, municipality })
    byMunicipality[municipality] = (byMunicipality[municipality] ?? 0) + 1
    console.log(
      `${LOG} would_update id=${id} municipality=${municipality} area=${row.area ?? 'null'} title=${row.title ?? ''}`,
    )
  }

  console.log(`${LOG} would_update: ${planned.length}`)
  console.log(`${LOG} already_set: ${alreadySet}`)
  console.log(`${LOG} skipped: ${skipped}`)
  console.log(`${LOG} area_updates: 0`)
  console.log(`${LOG} errors: 0`)
  const sorted = Object.entries(byMunicipality).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )
  for (const [slug, count] of sorted) {
    console.log(`${LOG} municipality ${slug}: ${count}`)
  }

  if (DRY_RUN) {
    console.log(`${LOG} done (dry-run, no DB write)`)
    return
  }

  let updated = 0
  let errors = 0
  for (const row of planned) {
    const { data: written, error: updateError } = await supabase
      .from('events')
      .update({ municipality: row.municipality })
      .eq('id', row.id)
      .eq('status', 'published')
      .is('municipality', null)
      .select('id, area, municipality')

    if (updateError) {
      errors += 1
      console.error(`${LOG} update failed id=${row.id}: ${updateError.message}`)
      continue
    }
    const saved = written?.[0] as
      | { area: string | null; municipality: string | null }
      | undefined
    if (!saved) {
      skipped += 1
      continue
    }
    if ((saved.area ?? null) !== (row.area ?? null)) {
      errors += 1
      console.error(`${LOG} area changed unexpectedly id=${row.id}`)
      continue
    }
    updated += 1
  }
  console.log(`${LOG} updated: ${updated}`)
  console.log(`${LOG} errors: ${errors}`)
  console.log(`${LOG} done`)
  if (errors > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(LOG, error instanceof Error ? error.message : error)
  process.exit(1)
})
