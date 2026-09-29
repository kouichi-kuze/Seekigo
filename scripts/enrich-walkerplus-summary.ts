/**
 * Walkerplus の紹介文から、SEEKIGO 独自の短い summary 候補を作る。
 * Importer からは呼ばない。公開済みの events.summary は更新しない。
 *
 * 対象は summary が空で、Walkerplus ソースがあるイベントだけ。
 * 既に summary がある行は対象外。
 *
 * DRY_RUN=true（デフォルト）: 表示のみ。DB もレビューも書かない
 * DRY_RUN=false:
 *   - draft だけ summary を空の行へ書く
 *   - published は event_field_reviews の summary 候補にする
 *
 * 対象 ID は WALKERPLUS_SUMMARY_IDS=40,99 のように必須。
 */
import { config } from 'dotenv'
import OpenAI from 'openai'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  DEFAULT_OPENAI_MODEL,
  generateWalkerplusSummary,
  reviewWalkerplusSummaryDraft,
} from './lib/ai-enrichment'
import { syncFieldReviewsForPublishedEvent } from './lib/field-reviews'
import {
  extractWalkerplusDetail,
  walkerplusIncompleteNotes,
  walkerplusSummaryMaterial,
} from './lib/walkerplus-detail-extract'
import { sleep } from './lib/walkerplus-parse'
import type { WalkerplusListEvent } from './lib/walkerplus-parse'

config()

const DRY_RUN = process.env.DRY_RUN !== 'false'
const LOG = '[enrich-walkerplus-summary]'
const GAP_MS = 2000
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function parseIds(raw: string | undefined): number[] {
  return [...new Set(
    (raw ?? '')
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((id) => Number.isInteger(id) && id > 0),
  )]
}

function createService(): SupabaseClient {
  const url = process.env.PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim()
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !key) throw new Error('Supabase service env is missing')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en;q=0.8',
    },
    redirect: 'follow',
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`)
  return response.text()
}

function emptyListItem(title: string, url: string): WalkerplusListEvent {
  return {
    source_name: 'walkerplus',
    source_event_id: null,
    title,
    detail_url: url,
    date_text: null,
    start_date: null,
    end_date: null,
    venue: null,
    area_text: null,
    summary: null,
    categories: [],
    image_url: null,
    fetched_at: new Date().toISOString(),
  }
}

async function main() {
  const ids = parseIds(process.env.WALKERPLUS_SUMMARY_IDS)
  if (ids.length === 0) {
    throw new Error('WALKERPLUS_SUMMARY_IDS is required')
  }
  console.log(`${LOG} DRY_RUN: ${DRY_RUN}`)
  console.log(`${LOG} ids: ${ids.join(',')}`)

  const supabase = createService()
  const { data: events, error } = await supabase
    .from('events')
    .select('id, title, status, summary')
    .in('id', ids)
    .order('id')
  if (error) throw new Error(error.message)

  const { data: sources, error: sourceError } = await supabase
    .from('event_sources')
    .select('event_id, source_name, source_url')
    .in('event_id', ids)
    .eq('source_name', 'walkerplus')
  if (sourceError) throw new Error(sourceError.message)
  const sourceBy = new Map<number, string>()
  for (const row of sources ?? []) {
    sourceBy.set(row.event_id as number, String(row.source_url))
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) throw new Error('OPENAI_API_KEY is missing')
  const client = new OpenAI({ apiKey })
  const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL
  let dbUpdates = 0
  let fieldReviews = 0
  let fetchOk = 0
  let fetchFail = 0
  let generatedOk = 0
  let skippedMaterial = 0
  let reviewOk = 0
  let reviewFlag = 0

  for (const [index, event] of (events ?? []).entries()) {
    if (index > 0) await sleep(GAP_MS)
    const id = event.id as number
    const title = String(event.title)
    const summary = (event.summary as string | null)?.trim() ?? ''
    const sourceUrl = sourceBy.get(id)
    console.log(`${LOG} ---- ${id} ${title} ----`)
    if (!sourceUrl) {
      console.log(`${LOG} skip: no walkerplus source`)
      console.log(`${LOG} RESULT ${JSON.stringify({ id, title, fetch: 'fail', reason: 'no walkerplus source' })}`)
      fetchFail += 1
      continue
    }
    if (summary) {
      console.log(`${LOG} skip: summary already set`)
      continue
    }
    if (event.status !== 'published' && event.status !== 'draft') {
      console.log(`${LOG} skip: status ${event.status}`)
      continue
    }

    let html: string
    try {
      html = await fetchHtml(sourceUrl)
      fetchOk += 1
    } catch (error) {
      fetchFail += 1
      const reason = error instanceof Error ? error.message : 'fetch failed'
      console.log(`${LOG} fetch failed: ${reason}`)
      console.log(`${LOG} RESULT ${JSON.stringify({ id, title, fetch: 'fail', reason })}`)
      continue
    }
    const detail = extractWalkerplusDetail(
      html,
      sourceUrl,
      emptyListItem(title, sourceUrl),
    )
    const material = walkerplusSummaryMaterial(detail.description)
    const dropped = walkerplusIncompleteNotes(detail.description)
    console.log(`${LOG} description: ${detail.description ?? 'null'}`)
    console.log(`${LOG} material: ${material ?? 'null'}`)
    if (!material) {
      skippedMaterial += 1
      console.log(`${LOG} summary: null`)
      console.log(`${LOG} chars: 0`)
      console.log(`${LOG} RESULT ${JSON.stringify({ id, title, fetch: 'ok', outcome: 'no_material' })}`)
      continue
    }
    const generated = await generateWalkerplusSummary(client, model, {
      title,
      material,
    })
    const draft = generated.draft
    console.log(`${LOG} summary: ${draft ?? 'null'}`)
    console.log(`${LOG} chars: ${draft ? [...draft].length : 0}`)
    if (generated.reason) console.log(`${LOG} reason: ${generated.reason}`)
    if (!generated.summary || !draft) {
      console.log(`${LOG} RESULT ${JSON.stringify({
        id,
        title,
        fetch: 'ok',
        outcome: 'rejected',
        reason: generated.reason,
        draft,
      })}`)
      continue
    }
    const flags = reviewWalkerplusSummaryDraft({
      title,
      material,
      dropped,
      summary: generated.summary,
    })
    generatedOk += 1
    if (flags.length > 0) reviewFlag += 1
    else reviewOk += 1
    console.log(`${LOG} RESULT ${JSON.stringify({
      id,
      title,
      fetch: 'ok',
      outcome: flags.length > 0 ? 'review' : 'ok',
      summary: generated.summary,
      chars: [...generated.summary].length,
      flags,
    })}`)

    if (DRY_RUN) continue
    if (event.status === 'draft') {
      const { data: written, error: updateError } = await supabase
        .from('events')
        .update({ summary: generated.summary })
        .eq('id', id)
        .eq('status', 'draft')
        .is('summary', null)
        .select('id')
      if (updateError) throw new Error(updateError.message)
      dbUpdates += written?.length ?? 0
      continue
    }
    await syncFieldReviewsForPublishedEvent(supabase, {
      eventId: id,
      eventStatus: 'published',
      sourceName: 'walkerplus',
      sourceUrl,
      proposed: { summary: generated.summary },
      write: true,
    })
    fieldReviews += 1
  }

  console.log(`${LOG} fetch_ok: ${fetchOk}`)
  console.log(`${LOG} fetch_fail: ${fetchFail}`)
  console.log(`${LOG} generated: ${generatedOk}`)
  console.log(`${LOG} skipped_material: ${skippedMaterial}`)
  console.log(`${LOG} review_ok: ${reviewOk}`)
  console.log(`${LOG} review_flag: ${reviewFlag}`)
  console.log(`${LOG} event_summary_updates: ${dbUpdates}`)
  console.log(`${LOG} field_reviews: ${fieldReviews}`)
}

main().catch((error) => {
  console.error(LOG, error instanceof Error ? error.message : error)
  process.exit(1)
})
