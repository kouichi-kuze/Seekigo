/**
 * Phase 4A / 4B-3: SNS・Web 反応要約（公開表示・型・AI 入出力）。
 * - 第三者投稿の大量転載はしない
 * - 公開は status=published のみ
 * - AI 生成は draft。自動 Publish しない
 */

export const REACTION_SUMMARY_STATUSES = [
  'draft',
  'reviewed',
  'published',
  'hidden',
] as const

export type ReactionSummaryStatus =
  (typeof REACTION_SUMMARY_STATUSES)[number]

export const REACTION_CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const
export type ReactionConfidence = (typeof REACTION_CONFIDENCE_LEVELS)[number]

export const REACTION_CROWD_LEVELS = ['high', 'medium', 'low'] as const
export type ReactionCrowdLevel = (typeof REACTION_CROWD_LEVELS)[number]

export const REACTION_WAIT_LEVELS = ['long', 'medium', 'short'] as const
export type ReactionWaitLevel = (typeof REACTION_WAIT_LEVELS)[number]

export const REACTION_SOURCE_TYPES = [
  'x',
  'instagram',
  'web',
  'blog',
  'news',
  'other',
  'official_web',
  'rss',
  'press_release',
  'other_web',
] as const
export type ReactionSourceType = (typeof REACTION_SOURCE_TYPES)[number]

/** DB signals JSONB */
export type ReactionSignals = {
  crowd_level?: ReactionCrowdLevel | null
  family?: boolean | null
  date?: boolean | null
  solo?: boolean | null
  photo?: boolean | null
  rain?: boolean | null
  wait_time?: ReactionWaitLevel | null
  recommended_time?: string | null
}

export type EventReactionSummaryRow = {
  id: number
  event_id: number
  summary_bullets: string[]
  signals: ReactionSignals
  source_count: number
  confidence: ReactionConfidence
  status: ReactionSummaryStatus
  generated_at: string | null
  reviewed_at: string | null
  reviewed_by: string | null
  created_at: string
  updated_at: string
}

export type EventReactionSourceRow = {
  id: number
  event_id: number
  summary_id: number
  source_type: ReactionSourceType
  source_url: string | null
  source_name: string | null
  observed_at: string | null
  excerpt_for_internal_review: string | null
  created_at: string
}

export const REACTION_SIGNAL_TAGS: {
  key: keyof ReactionSignals
  label: string
  when: (s: ReactionSignals) => boolean
}[] = [
  {
    key: 'crowd_level',
    label: '混雑傾向',
    when: (s) => s.crowd_level === 'high',
  },
  {
    key: 'crowd_level',
    label: 'やや混雑',
    when: (s) => s.crowd_level === 'medium',
  },
  {
    key: 'crowd_level',
    label: '比較的ゆったり',
    when: (s) => s.crowd_level === 'low',
  },
  { key: 'family', label: '子ども向け', when: (s) => s.family === true },
  { key: 'date', label: 'デート', when: (s) => s.date === true },
  { key: 'solo', label: '一人でも', when: (s) => s.solo === true },
  { key: 'photo', label: '写真', when: (s) => s.photo === true },
  { key: 'rain', label: '雨の日', when: (s) => s.rain === true },
  {
    key: 'wait_time',
    label: '待ち時間長め',
    when: (s) => s.wait_time === 'long',
  },
  {
    key: 'wait_time',
    label: '待ち時間あり',
    when: (s) => s.wait_time === 'medium',
  },
  {
    key: 'wait_time',
    label: '待ち時間短め',
    when: (s) => s.wait_time === 'short',
  },
]

/** Public UI tags — unknown/null/false and mixed are never shown. */
export function publicReactionSignalLabels(signals: ReactionSignals): string[] {
  return REACTION_SIGNAL_TAGS.filter((t) => t.when(signals)).map((t) => t.label)
}

/** @deprecated use publicReactionSignalLabels */
export function activeReactionSignalLabels(signals: ReactionSignals): string[] {
  return publicReactionSignalLabels(signals)
}

export function parseSummaryBullets(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
    .slice(0, 12)
}

export function parseReactionSignals(value: unknown): ReactionSignals {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const raw = value as Record<string, unknown>
  const crowd = raw.crowd_level
  const wait = raw.wait_time
  return {
    crowd_level:
      crowd === 'high' || crowd === 'medium' || crowd === 'low' ? crowd : null,
    family: typeof raw.family === 'boolean' ? raw.family : null,
    date: typeof raw.date === 'boolean' ? raw.date : null,
    solo: typeof raw.solo === 'boolean' ? raw.solo : null,
    photo: typeof raw.photo === 'boolean' ? raw.photo : null,
    rain: typeof raw.rain === 'boolean' ? raw.rain : null,
    wait_time:
      wait === 'long' || wait === 'medium' || wait === 'short' ? wait : null,
    recommended_time:
      typeof raw.recommended_time === 'string' && raw.recommended_time.trim()
        ? raw.recommended_time.trim().slice(0, 40)
        : null,
  }
}

export function bulletsFromTextarea(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^[・\-*\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 12)
}

export function bulletsToTextarea(bullets: string[]): string {
  return bullets.map((b) => `・${b}`).join('\n')
}

export function formatReactionUpdatedAt(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const y = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
  return y.replace(/-/g, '/')
}

export function mapSummaryRow(data: Record<string, unknown>): EventReactionSummaryRow {
  return {
    id: Number(data.id),
    event_id: Number(data.event_id),
    summary_bullets: parseSummaryBullets(data.summary_bullets),
    signals: parseReactionSignals(data.signals),
    source_count: Number(data.source_count ?? 0),
    confidence: (['low', 'medium', 'high'] as const).includes(
      data.confidence as ReactionConfidence,
    )
      ? (data.confidence as ReactionConfidence)
      : 'low',
    status: (REACTION_SUMMARY_STATUSES as readonly string[]).includes(
      String(data.status),
    )
      ? (data.status as ReactionSummaryStatus)
      : 'draft',
    generated_at: (data.generated_at as string | null) ?? null,
    reviewed_at: (data.reviewed_at as string | null) ?? null,
    reviewed_by: (data.reviewed_by as string | null) ?? null,
    created_at: String(data.created_at ?? ''),
    updated_at: String(data.updated_at ?? ''),
  }
}

/** 公開サイト用: published のみ */
export async function fetchPublishedReactionSummary(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: { from: (table: string) => any },
  eventId: number,
): Promise<EventReactionSummaryRow | null> {
  const { data, error } = await client
    .from('event_reaction_summaries')
    .select(
      'id, event_id, summary_bullets, signals, source_count, confidence, status, generated_at, reviewed_at, reviewed_by, created_at, updated_at',
    )
    .eq('event_id', eventId)
    .eq('status', 'published')
    .maybeSingle()

  if (error) {
    // 未 migration / schema cache 未反映時は静かに非表示
    const msg = error.message ?? ''
    if (
      error.code === '42P01' ||
      error.code === 'PGRST205' ||
      /does not exist/i.test(msg) ||
      /Could not find the table/i.test(msg) ||
      /schema cache/i.test(msg)
    ) {
      return null
    }
    console.error('[reaction-summary] fetch published failed:', msg)
    return null
  }
  if (!data) return null
  const row = mapSummaryRow(data as Record<string, unknown>)
  if (row.summary_bullets.length === 0) return null
  return row
}

/**
 * AI 要約入出力契約（Phase 4B-3 で実行）。
 *
 * 絶対ルール:
 * - source にない内容を推測しない
 * - source 数が少なければ confidence を下げる
 * - 個人攻撃・個人特定情報を要約しない
 * - 単一投稿を「世間の評判」と表現しない
 * - 断定表現を避け「〜という反応 / 傾向」にする
 */
export type ReactionSummaryAiInput = {
  event: {
    id: number
    title: string
    start_date?: string | null
    end_date?: string | null
    venue?: string | null
    area?: string | null
    category?: string[] | null
  }
  sources: Array<{
    source_type: ReactionSourceType
    observed_at?: string | null
    /** 内部処理用の短い抜粋。公開転載禁止 */
    text_for_analysis: string
    classification?: 'experience' | 'official' | 'media' | 'other'
  }>
  locale: 'ja'
  max_bullets: number
}

export type ReactionSummaryAiOutput = {
  summary_bullets: string[]
  signals: ReactionSignals
  confidence: ReactionConfidence
  notes_for_reviewer?: string
  unused_source_indexes?: number[]
}

/**
 * event_reaction_sources → AI input（必要最小限）。
 * author / URL / プロフィールは渡さない。excerpt のみ。
 */
export function toReactionSummaryAiInput(opts: {
  event: ReactionSummaryAiInput['event']
  sources: Array<{
    source_type: ReactionSourceType | string
    source_url?: string | null
    source_name?: string | null
    observed_at?: string | null
    excerpt_for_internal_review?: string | null
    classification?: 'experience' | 'official' | 'media' | 'other'
  }>
  max_bullets?: number
}): ReactionSummaryAiInput {
  const sources = opts.sources
    .map((s) => {
      const text = String(s.excerpt_for_internal_review ?? '').trim()
      if (!text) return null
      const type = (REACTION_SOURCE_TYPES as readonly string[]).includes(
        String(s.source_type),
      )
        ? (s.source_type as ReactionSourceType)
        : 'other_web'
      return {
        source_type: type,
        observed_at: s.observed_at ?? null,
        text_for_analysis: text.slice(0, 500),
        classification: s.classification,
      }
    })
    .filter((s): s is NonNullable<typeof s> => Boolean(s))
    .slice(0, 20)

  return {
    event: {
      id: opts.event.id,
      title: opts.event.title,
      start_date: opts.event.start_date,
      end_date: opts.event.end_date,
      venue: opts.event.venue,
      area: opts.event.area,
      category: opts.event.category ?? null,
    },
    sources,
    locale: 'ja',
    max_bullets: opts.max_bullets ?? 5,
  }
}
