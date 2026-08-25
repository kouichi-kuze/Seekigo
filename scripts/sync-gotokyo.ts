/**
 * GO TOKYO 同期パイプライン（1コマンド）
 * 1) 一覧取得 → 2) 詳細取得 → 3) AI整形 → 4) Supabase import
 * 各ステップは既存スクリプトを実行する（ロジックの再実装なし）
 */
import { config } from 'dotenv'
import { getGotokyoLimit } from './lib/gotokyo-limit'
import { runTsxScript } from './lib/run-tsx'

config()

const DRY_RUN = process.env.DRY_RUN !== 'false'
const limit = getGotokyoLimit()

type Step = {
  label: string
  script: string
}

const STEPS: Step[] = [
  { label: 'Step 1/4 listing fetch', script: 'scripts/fetch-gotokyo.ts' },
  { label: 'Step 2/4 detail fetch', script: 'scripts/fetch-gotokyo-details.ts' },
  { label: 'Step 3/4 AI enrichment', script: 'scripts/enrich-events-ai.ts' },
  { label: 'Step 4/4 Supabase import', script: 'scripts/import-events-supabase.ts' },
]

async function main() {
  console.log('[sync-gotokyo] start')
  console.log(`[sync-gotokyo] GOTOKYO_LIMIT: ${limit}`)
  console.log(`[sync-gotokyo] DRY_RUN: ${DRY_RUN}`)
  if (DRY_RUN) {
    console.log(
      '[sync-gotokyo] note: Step 4 will plan only (no DB write). Set DRY_RUN=false to insert drafts.',
    )
  }

  const childEnv = {
    GOTOKYO_LIMIT: String(limit),
    DRY_RUN: DRY_RUN ? 'true' : 'false',
  }

  for (const step of STEPS) {
    console.log(`[sync-gotokyo] ${step.label}`)
    try {
      await runTsxScript(step.script, childEnv)
      console.log(`[sync-gotokyo] ${step.label} — success`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[sync-gotokyo] ${step.label} — failed`)
      console.error(`[sync-gotokyo] ${message}`)
      console.error('[sync-gotokyo] stopped (subsequent steps were not run)')
      process.exit(1)
    }
  }

  console.log('[sync-gotokyo] done')
}

main().catch((error) => {
  console.error('[sync-gotokyo] unexpected error:', error)
  process.exit(1)
})
