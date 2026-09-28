/**
 * 全ソース一括同期（GO TOKYO → EnjoyTokyo → Walkerplus → 港区オープンデータ）
 *
 * - shell:false（scripts/lib/run-tsx.ts）
 * - DRY_RUN デフォルト true（子プロセスへ継承）
 * - 1ソース内の失敗はそのソースの残ステップを止め、次のソースは続ける
 * - いずれかが失敗したら最後に exit 1（GitHub Actions のデプロイには進まない）
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
  {
    name: 'Walkerplus',
    steps: [
      {
        label: 'Step 1/3 listing',
        script: 'scripts/fetch-walkerplus.ts',
      },
      {
        label: 'Step 2/3 details',
        script: 'scripts/fetch-walkerplus-details.ts',
      },
      {
        label: 'Step 3/3 import',
        script: 'scripts/import-walkerplus-supabase.ts',
      },
    ],
  },
  {
    name: 'Minato',
    steps: [
      {
        label: 'fetch Minato OpenData',
        script: 'scripts/fetch-minato-opendata.ts',
      },
      {
        label: 'import Minato OpenData',
        script: 'scripts/import-minato-opendata-supabase.ts',
      },
      {
        label: 'enrich Minato OpenData',
        script: 'scripts/enrich-minato-opendata.ts',
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

    // EnjoyTokyo: 一覧最大10件に合わせて詳細も取得
    // 個別指定があればそれを優先
    ENJOYTOKYO_DETAILS_LIMIT:
      process.env.ENJOYTOKYO_DETAILS_LIMIT?.trim() || '10',
  }

  let failedSources = 0

  for (let s = 0; s < SOURCES.length; s++) {
    const source = SOURCES[s]
    let sourceFailed = false

    console.log('')
    console.log(
      `[sync-all] Source ${s + 1}/${SOURCES.length}: ${source.name}`,
    )

    for (const step of source.steps) {
      console.log(`[sync-all] ${step.label}`)

      try {
        await runTsxScript(step.script, childEnv)
        console.log(`[sync-all] ${step.label} — success`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        sourceFailed = true
        console.error(`[sync-all] ${step.label} — failed`)
        console.error(`[sync-all] ${message}`)
        console.error(
          `[sync-all] ${source.name} stopped. Next sources will still run.`,
        )
        break
      }
    }

    if (sourceFailed) {
      failedSources += 1
      console.error(`[sync-all] ${source.name} — failed`)
    } else {
      console.log(`[sync-all] ${source.name} — success`)
    }
  }

  console.log('')
  if (failedSources > 0) {
    console.error(`[sync-all] done with ${failedSources} failed source(s)`)
    process.exit(1)
  }
  console.log('[sync-all] done')
}

main().catch((error) => {
  console.error('[sync-all] unexpected error:', error)
  process.exit(1)
})