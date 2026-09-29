/**
 * 確認済み Walkerplus summary だけを event_field_reviews へ登録する。
 * events.summary は更新しない。summary 以外の field は提案しない。
 *
 * 同一 proposal_hash の pending が既にある場合は新規行を作らない。
 * 品質OK 30件には id 119 と 121 が含まれるため、修正3件を足したユニーク数は 31。
 * 生成見送り 9件（43, 100, 101, 102, 104, 107, 108, 120, 128）は登録しない。
 */
import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { syncFieldReviewsForPublishedEvent } from './lib/field-reviews'
import { computeFieldDiffs } from '../src/lib/event-field-review'

config()

export const CONFIRMED_SUMMARIES: Record<number, string> = {
  40: 'クリエイティブチームentakuによる最新作「はてな展」が開催されます。',
  41: 'ピクサー・アニメーション・スタジオの作品を再現した没入型体験イベントです。物語の主人公になりきることができます。',
  42: '「ドラえもん」の漫画やアニメ、大長編の世界を楽しめる展覧会です。',
  44: '大英博物館の日本美術作品を展示する巡回展です。',
  45: 'サンリオキャラクターたちの「理想のホテル」をテーマにした体験型展示イベントが日本で開催される。多彩な展示が展開される。',
  47: '謎解きカフェ「サニサニーピクニック」で体験型イベントが開催される。',
  98: '全国各地の飲食店48店舗が集まるカレーフェス。カレー専門店のほか、ラーメン店やイタリアンも参加。',
  99: '「レストラン1899お茶の水」で開催される抹茶ビアガーデン。ドリンク、料理、スイーツが茶尽くしのメニューで提供される。',
  103: '「ちいかわ」と東京スカイツリーのコラボイベントが開催される。映画『ちいかわ 人魚の島のひみつ』の公開に合わせた内容。',
  105: '「リアル脱出ゲーム」と「名探偵コナン」のコラボイベントが新宿で開催される。全世界48会場以上で体験できる。',
  106: '『映画ちいかわ 人魚の島のひみつ』の公開を記念した、東京メトロ沿線での体験型謎解きイベントです。',
  109: '明治神宮外苑にあるビアガーデンで、1984年の開園以来親しまれています。',
  110: 'コニカミノルタプラネタリウムの初のホラープラネタリウム作品「ふり返りの旋律」のリバイバル上映。お化け屋敷プロデューサーの五味弘文さんが監修。',
  111: 'プレイヤーが主人公となり、東京の街を巡りながら物語を進める没入型体験ゲームです。',
  112: '「文フェス 2026AUTUMN」では、ロフト先行アイテムを含む秋の新作文具が集まります。',
  113: '池袋の東武百貨店16階屋上で、アジアの夜市をイメージしたビアガーデンが開催されます。',
  114: 'BUMP OF CHICKENの楽曲と星空を楽しむプラネタリウム作品です。',
  115: 'シンエイ動画の設立50周年を記念した企画展。『ドラえもん』や『クレヨンしんちゃん』など、多彩なアニメが展示される。',
  116: '第10回羽田航空博物館展が羽田イノベーションシティで開催されます。',
  117: 'サンシャイン水族館で「ざんねんないきもの事典」シリーズのコラボイベントが開催され、ざんねんな生き物たちを紹介します。',
  118: '浅草エキミセの屋上で、スカイツリーを眺めながらビアガーデンを楽しめるお祭りBBQ。',
  119: 'ダイアログ・イン・ザ・ダークは真っ暗闇のエンターテイメントで、視覚障害者のアテンドが体験を案内します。',
  121: 'しながわ水族館の開館35周年と、エリック・カールの『はらぺこあおむし』日本語版刊行50周年を記念した特別展。',
  122: '映画美術のホラーの世界を体験できる展示会です。実際に見て、触って、撮影を楽しめます。',
  123: 'The Artcomplex Center of Tokyo企画 TRATRATでは、アートのある生活が敷居が高いとされている。アートは、日常生活に潤いや優しさをもたらす役割を果たす。',
  124: '神田でスタンプラリーを開催し、街の活性化を目指します。',
  125: 'XEOXYが制作した体験型リアル謎解きゲーム「/」は、ひらめきに満ちた内容です。',
  126: '東京スカイツリータウンで開催される『オクトーバーフェスト』は、世界最大規模のビール祭典の雰囲気を楽しめるイベントです。今年で3回目の開催となります。',
  127: 'ホテル7階のルーフトップテラスで、オーストラリアのサンセットビーチをテーマにしたビアガーデンが開催される。',
  129: 'ルミネエスト新宿のビアガーデンでは、ネオン輝く屋上空間で韓国の屋台文化「ポジャンマチャ」を体験できます。',
  130: '江戸東京博物館で、2026年の大河ドラマに関連した特別展「豊臣兄弟！」が開催される。展覧会は、豊臣秀吉の弟、秀長に焦点を当てている。',
}

const IDS = Object.keys(CONFIRMED_SUMMARIES).map(Number)

function createService(): SupabaseClient {
  const url = process.env.PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim()
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !key) throw new Error('Supabase service env is missing')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

function assertSummaryOnlyDiff(): void {
  const diffs = computeFieldDiffs({ summary: null }, { summary: '候補' })
  if (diffs.length !== 1 || diffs[0]?.field_name !== 'summary') {
    throw new Error(`summary-only diff expected, got ${diffs.map((d) => d.field_name).join(',')}`)
  }
}

async function main() {
  assertSummaryOnlyDiff()
  const supabase = createService()
  const { data: events, error } = await supabase
    .from('events')
    .select('id, title, status, summary')
    .in('id', IDS)
  if (error) throw new Error(error.message)
  const eventBy = new Map((events ?? []).map((row) => [row.id as number, row]))

  const { data: sources, error: sourceError } = await supabase
    .from('event_sources')
    .select('event_id, source_url')
    .in('event_id', IDS)
    .eq('source_name', 'walkerplus')
  if (sourceError) throw new Error(sourceError.message)
  const sourceBy = new Map<number, string>()
  for (const row of sources ?? []) {
    if (!sourceBy.has(row.event_id as number)) {
      sourceBy.set(row.event_id as number, String(row.source_url))
    }
  }

  const skipped: { id: number; reason: string }[] = []
  let created = 0
  let keptPending = 0

  for (const id of IDS) {
    const proposed = CONFIRMED_SUMMARIES[id]
    const event = eventBy.get(id)
    if (!event || event.status !== 'published') {
      skipped.push({ id, reason: `status ${event?.status ?? 'missing'}` })
      continue
    }
    const currentSummary = (event.summary as string | null)?.trim() ?? ''
    if (currentSummary) {
      skipped.push({ id, reason: 'summary already set' })
      continue
    }
    const sourceUrl = sourceBy.get(id)
    if (!sourceUrl) {
      skipped.push({ id, reason: 'no walkerplus source' })
      continue
    }

    const result = await syncFieldReviewsForPublishedEvent(supabase, {
      eventId: id,
      eventStatus: 'published',
      sourceName: 'walkerplus',
      sourceUrl,
      proposed: { summary: proposed },
      write: true,
    })
    if (result.detected !== 1) {
      throw new Error(`event ${id} produced ${result.detected} diffs`)
    }
    if (result.created === 1) created += 1
    else if (result.updated === 1 || result.skipped === 1) keptPending += 1
    else skipped.push({ id, reason: JSON.stringify(result) })
  }

  const { data: reviews, error: reviewError } = await supabase
    .from('event_field_reviews')
    .select('id, event_id, field_name, status, current_value, proposed_value')
    .in('event_id', IDS)
    .eq('status', 'pending')
  if (reviewError) throw new Error(reviewError.message)
  const pending = reviews ?? []
  const nonSummary = pending.filter((row) => row.field_name !== 'summary')
  const summaryPending = pending.filter((row) => row.field_name === 'summary')

  const { count: allSummaryPending, error: countError } = await supabase
    .from('event_field_reviews')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')
    .eq('field_name', 'summary')
  if (countError) throw new Error(countError.message)

  const { data: summaries, error: summaryError } = await supabase
    .from('events')
    .select('id, summary')
    .in('id', IDS)
  if (summaryError) throw new Error(summaryError.message)
  const summaryWrites = (summaries ?? []).filter((row) => ((row.summary as string | null)?.trim() ?? '') !== '')

  const samples = [40, 99, 119, 121, 123].map((id) => {
    const row = summaryPending.find((review) => review.event_id === id)
    return {
      id,
      current: row?.current_value ?? null,
      proposed: row?.proposed_value ?? null,
    }
  })

  console.log(JSON.stringify({
    candidates: IDS.length,
    created,
    kept_existing_pending: keptPending,
    skipped,
    non_summary_pending_on_targets: nonSummary.length,
    summary_pending_on_targets: summaryPending.length,
    pending_summary_reviews_total: allSummaryPending ?? 0,
    events_summary_nonempty: summaryWrites.length,
    samples,
  }, null, 2))
}

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/register-walkerplus-summary-reviews.ts')
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
