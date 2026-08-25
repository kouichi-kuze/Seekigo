/**
 * 全ソース一括同期（GO TOKYO → EnjoyTokyo）
 *
 * 1) npm run sync:gotokyo 相当
 * 2) EnjoyTokyo: listing → details → dedupe → import → AI enrichment
 *
 * - shell:false（scripts/lib/run-tsx.ts）
 * - 失敗時は即停止 exit 1
 * - DRY_RUN デフォルト true（子プロセスへ継承）
 */
import { config } from 'dotenv'
import { runTsxScript } from './lib/run-tsx'

config()

const DRY_RUN = process.env.DRY_RUN !== 'false'

type Step = {
  label: string
  script: string
}

type Source = {
  name: string
  steps: Step[]
}

const SOURCES: Source[] = [
  {
    name: 'GO TOKYO',
    steps: [{ label: 'sync:gotokyo', script: 'scripts/sync-gotokyo.ts' }],
  },
  {
    name: 'EnjoyTokyo',
    steps: [
      { label: 'Step 1/5 listing', script: 'scripts/fetch-enjoytokyo.ts' },
      {
        label: 'Step 2/5 details',
        script: 'scripts/fetch-enjoytokyo-details.ts',
      },
      { label: 'Step 3/5 dedupe', script: 'scripts/check-event-duplicates.ts' },
      {
        label: 'Step 4/5 import',
        script: 'scripts/import-enjoytokyo-supabase.ts',
      },
      {
        label: 'Step 5/5 AI enrichment',
        script: 'scripts/enrich-enjoytokyo-ai.ts',
      },
    ],
  },
]

async function main() {
  console.log('[sync-all] start')
  console.log(`[sync-all] DRY_RUN: ${DRY_RUN}`)
  if (DRY_RUN) {
    console.log(
      '[sync-all] note: import / AI update are dry-run (no DB write). Set DRY_RUN=false to write drafts.',
    )
  } else {
    console.log(
      '[sync-all] note: will insert/attach drafts and AI-update drafts only. published bodies are not overwritten.',
    )
  }

  const childEnv = {
    DRY_RUN: DRY_RUN ? 'true' : 'false',
    // 一覧最大10件に合わせて詳細も取得（個別指定があればそれを優先）
    ENJOYTOKYO_DETAILS_LIMIT:
      process.env.ENJOYTOKYO_DETAILS_LIMIT?.trim() || '10',
  }

  for (let s = 0; s < SOURCES.length; s++) {
    const source = SOURCES[s]
    console.log('')
    console.log(`[sync-all] Source ${s + 1}/${SOURCES.length}: ${source.name}`)

    for (const step of source.steps) {
      console.log(`[sync-all] ${step.label}`)
      try {
        await runTsxScript(step.script, childEnv)
        console.log(`[sync-all] ${step.label} — success`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[sync-all] ${step.label} — failed`)
        console.error(`[sync-all] ${message}`)
        console.error('[sync-all] stopped (subsequent steps were not run)')
        process.exit(1)
      }
    }

    console.log(`[sync-all] ${source.name} — success`)
  }

  console.log('')
  console.log('[sync-all] done')
}

main().catch((error) => {
  console.error('[sync-all] unexpected error:', error)
  process.exit(1)
})
