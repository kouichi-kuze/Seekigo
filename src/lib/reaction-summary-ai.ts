/**
 * Phase 4B-3 / 4B-3.1: AI reaction summary — OpenAI call + quality guards.
 * Server / CLI only. Never call from the browser.
 */
import OpenAI from 'openai'
import type {
  ReactionConfidence,
  ReactionSignals,
  ReactionSourceType,
  ReactionSummaryAiInput,
} from './event-reaction-summary'
import { REACTION_SOURCE_TYPES } from './event-reaction-summary'
import {
  applyReactionQualityGuards,
  type QualityGuardMeta,
} from './reaction-summary-quality'

export const DEFAULT_REACTION_SUMMARY_MODEL = 'gpt-4.1-nano'
export const MIN_REACTION_SOURCES_FOR_AI = 3
export const MAX_REACTION_SOURCES_FOR_AI = 20

/** Rough list prices USD / 1M tokens (verify on OpenAI Platform — prices change). */
export const REACTION_MODEL_PRICES: Record<
  string,
  { input: number; output: number }
> = {
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
}

export const REACTION_SIGNAL_POLARITIES = [
  'positive',
  'negative',
  'mixed',
  'neutral',
  'unknown',
] as const
export type ReactionSignalPolarity =
  (typeof REACTION_SIGNAL_POLARITIES)[number]

export type ReactionSourceClass =
  | 'experience'
  | 'official'
  | 'media'
  | 'other'

export type ReactionSummaryAiSourceItem = {
  source_type: ReactionSourceType
  observed_at: string | null
  excerpt_for_internal_review: string
  classification: ReactionSourceClass
}

export type ReactionSummaryAiPayload = {
  event: {
    title: string
    venue: string | null
    area: string | null
    start_date: string | null
    end_date: string | null
    category: string[] | null
  }
  sources: ReactionSummaryAiSourceItem[]
  locale: 'ja'
  max_bullets: number
}

/** Fixed AI JSON output (after quality guards, before DB mapping). */
export type ReactionSummaryAiJson = {
  summary_bullets: string[]
  signals: {
    crowd: ReactionSignalPolarity
    family: ReactionSignalPolarity
    date: ReactionSignalPolarity
    solo: ReactionSignalPolarity
    photo: ReactionSignalPolarity
    rain: ReactionSignalPolarity
    wait_time: ReactionSignalPolarity
  }
  recommended_time: string | null
  confidence: ReactionConfidence
}

export type ReactionAiUsage = {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  estimated_cost_usd: number
  estimated_cost_display: string
}

export type ReactionAiCallResult = {
  output: ReactionSummaryAiJson
  model: string
  usage: ReactionAiUsage
  raw_chars: number
  guard: QualityGuardMeta
}

const EXPERIENCE_RE =
  /行ってきた|行ってき|見てきた|見て来|来たよ|楽し(かった|めた)|面白(かった|い)|混んで|混雑|空いて|すいて|子どもと|子供と|子連れ|雨(だった|で)|待った|待ち時間|並んだ|列が|写真(撮|を撮)|撮った|おすすめ|オススメ|体験|入場(した|して)|会場(に|で)|現地|行ってみた|行ってよ|行ったら|行ったよ|最高だった|良かった|よかった|寒かった|暑かった|感動/

const OFFICIAL_RE =
  /公式(アカウント|情報|サイト|発表|HP)?|主催(者|より)?|オフィシャル|チケット(販売|発売)|開催(決定|のお知らせ|します)|ご来場お待ち|詳細は(こちら|公式)|プレスリリース/

const MEDIA_RE =
  /ニュース|報道|イベント情報|まとめ|ウォーカー|walkerplus|gotokyo|enjoytokyo|ぴあ|timeout|タイムアウト|情報サイト|メディア/

export function classifyReactionExcerpt(
  sourceType: string,
  excerpt: string,
  sourceName?: string | null,
): ReactionSourceClass {
  const text = excerpt || ''
  const name = (sourceName || '').toLowerCase()

  if (EXPERIENCE_RE.test(text)) return 'experience'

  if (
    sourceType === 'official_web' ||
    sourceType === 'press_release' ||
    OFFICIAL_RE.test(text) ||
    /official|公式|staff|主催/.test(name)
  ) {
    return 'official'
  }

  if (
    sourceType === 'news' ||
    sourceType === 'rss' ||
    MEDIA_RE.test(text) ||
    /walkerplus|gotokyo|enjoytokyo|ぴあ|timeout|ニュース/.test(name)
  ) {
    return 'media'
  }

  return 'other'
}

export function buildReactionSummaryAiPayload(opts: {
  event: {
    title: string
    venue?: string | null
    area?: string | null
    start_date?: string | null
    end_date?: string | null
    category?: string[] | string | null
  }
  sources: Array<{
    source_type: ReactionSourceType | string
    observed_at?: string | null
    excerpt_for_internal_review?: string | null
    source_name?: string | null
  }>
  max_bullets?: number
}): ReactionSummaryAiPayload {
  const category = normalizeCategory(opts.event.category)
  const sources: ReactionSummaryAiSourceItem[] = []

  for (const s of opts.sources) {
    if (sources.length >= MAX_REACTION_SOURCES_FOR_AI) break
    const excerpt = String(s.excerpt_for_internal_review ?? '').trim()
    if (!excerpt) continue
    const type = (REACTION_SOURCE_TYPES as readonly string[]).includes(
      String(s.source_type),
    )
      ? (s.source_type as ReactionSourceType)
      : 'other_web'
    const classification = classifyReactionExcerpt(
      type,
      excerpt,
      s.source_name,
    )
    sources.push({
      source_type: type,
      observed_at: s.observed_at ?? null,
      excerpt_for_internal_review: excerpt.slice(0, 500),
      classification,
    })
  }

  return {
    event: {
      title: String(opts.event.title ?? ''),
      venue: opts.event.venue ?? null,
      area: opts.event.area ?? null,
      start_date: opts.event.start_date ?? null,
      end_date: opts.event.end_date ?? null,
      category,
    },
    sources,
    locale: 'ja',
    max_bullets: opts.max_bullets ?? 5,
  }
}

function normalizeCategory(
  raw: string[] | string | null | undefined,
): string[] | null {
  if (!raw) return null
  if (Array.isArray(raw)) {
    const list = raw.map((c) => String(c).trim()).filter(Boolean)
    return list.length ? list.slice(0, 8) : null
  }
  const s = String(raw).trim()
  return s ? [s] : null
}

/** Legacy helper → minimal AI payload shape (no author/url). */
export function toReactionSummaryAiInputMinimal(
  payload: ReactionSummaryAiPayload,
): ReactionSummaryAiInput {
  return {
    event: {
      id: 0,
      title: payload.event.title,
      start_date: payload.event.start_date,
      end_date: payload.event.end_date,
      venue: payload.event.venue,
      area: payload.event.area,
    },
    sources: payload.sources.map((s) => ({
      source_type: s.source_type,
      observed_at: s.observed_at,
      text_for_analysis: s.excerpt_for_internal_review,
    })),
    locale: 'ja',
    max_bullets: payload.max_bullets,
  }
}

export function countSourceTypes(
  sources: ReactionSummaryAiSourceItem[],
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const s of sources) {
    counts[s.source_type] = (counts[s.source_type] ?? 0) + 1
  }
  return counts
}

export function countClassifications(
  sources: ReactionSummaryAiSourceItem[],
): Record<ReactionSourceClass, number> {
  const counts: Record<ReactionSourceClass, number> = {
    experience: 0,
    official: 0,
    media: 0,
    other: 0,
  }
  for (const s of sources) counts[s.classification] += 1
  return counts
}

export function estimateInputChars(payload: ReactionSummaryAiPayload): number {
  return JSON.stringify(payload).length
}

export function estimateOpenAiCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): ReactionAiUsage {
  const prices =
    REACTION_MODEL_PRICES[model] ?? REACTION_MODEL_PRICES['gpt-4.1-nano']
  const cost =
    (promptTokens / 1e6) * prices.input +
    (completionTokens / 1e6) * prices.output
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    estimated_cost_usd: cost,
    estimated_cost_display: `$${cost.toFixed(6)}`,
  }
}

/** @deprecated prefer applyReactionQualityGuards */
export function normalizeReactionAiJson(
  raw: unknown,
  meta: { experienceCount: number; sourceCount: number },
  payload?: ReactionSummaryAiPayload,
): ReactionSummaryAiJson {
  const emptyPayload: ReactionSummaryAiPayload = payload ?? {
    event: {
      title: '',
      venue: null,
      area: null,
      start_date: null,
      end_date: null,
      category: null,
    },
    sources: [],
    locale: 'ja',
    max_bullets: 5,
  }
  return applyReactionQualityGuards(raw, emptyPayload, meta).output
}

/** Map AI polarity signals → existing DB / admin ReactionSignals. */
export function aiSignalsToDbSignals(
  ai: ReactionSummaryAiJson,
): ReactionSignals {
  const crowdMap: Record<
    ReactionSignalPolarity,
    ReactionSignals['crowd_level']
  > = {
    positive: 'high',
    negative: 'low',
    mixed: 'medium',
    neutral: null,
    unknown: null,
  }
  const waitMap: Record<ReactionSignalPolarity, ReactionSignals['wait_time']> =
    {
      positive: 'short',
      negative: 'long',
      mixed: 'medium',
      neutral: null,
      unknown: null,
    }
  const boolFrom = (p: ReactionSignalPolarity): boolean | null => {
    if (p === 'positive') return true
    if (p === 'negative') return false
    return null
  }

  return {
    crowd_level: crowdMap[ai.signals.crowd],
    family: boolFrom(ai.signals.family),
    date: boolFrom(ai.signals.date),
    solo: boolFrom(ai.signals.solo),
    photo: boolFrom(ai.signals.photo),
    rain: boolFrom(ai.signals.rain),
    wait_time: waitMap[ai.signals.wait_time],
    recommended_time: ai.recommended_time,
  }
}

const polarityEnum = [...REACTION_SIGNAL_POLARITIES]
const themeEnum = [
  'enjoyment',
  'crowd',
  'wait_time',
  'family',
  'photo',
  'rain',
  'solo',
  'date',
  'recommended_time',
  'other',
]

export const reactionSummaryJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary_bullets: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          theme: { type: 'string', enum: themeEnum },
          evidence_count: { type: 'integer' },
          experience_evidence_count: { type: 'integer' },
          official_evidence_count: { type: 'integer' },
          media_evidence_count: { type: 'integer' },
          evidence_source_indexes: {
            type: 'array',
            items: { type: 'integer' },
          },
        },
        required: [
          'text',
          'theme',
          'evidence_count',
          'experience_evidence_count',
          'official_evidence_count',
          'media_evidence_count',
          'evidence_source_indexes',
        ],
      },
    },
    signals: {
      type: 'object',
      additionalProperties: false,
      properties: {
        crowd: { type: 'string', enum: polarityEnum },
        family: { type: 'string', enum: polarityEnum },
        date: { type: 'string', enum: polarityEnum },
        solo: { type: 'string', enum: polarityEnum },
        photo: { type: 'string', enum: polarityEnum },
        rain: { type: 'string', enum: polarityEnum },
        wait_time: { type: 'string', enum: polarityEnum },
      },
      required: [
        'crowd',
        'family',
        'date',
        'solo',
        'photo',
        'rain',
        'wait_time',
      ],
    },
    signal_evidence: {
      type: 'object',
      additionalProperties: false,
      properties: {
        crowd: { type: 'integer' },
        family: { type: 'integer' },
        date: { type: 'integer' },
        solo: { type: 'integer' },
        photo: { type: 'integer' },
        rain: { type: 'integer' },
        wait_time: { type: 'integer' },
      },
      required: [
        'crowd',
        'family',
        'date',
        'solo',
        'photo',
        'rain',
        'wait_time',
      ],
    },
    recommended_time: { type: ['string', 'null'] },
    recommended_time_evidence_count: { type: 'integer' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: [
    'summary_bullets',
    'signals',
    'signal_evidence',
    'recommended_time',
    'recommended_time_evidence_count',
    'confidence',
  ],
} as const

export const REACTION_SUMMARY_SYSTEM_PROMPT = [
  'You write short Japanese tendency summaries of public SNS/Web reactions for Seekigo event pages.',
  'Output MUST match the JSON schema. Language of bullets: Japanese.',
  '',
  'Allowed bullet themes ONLY:',
  'enjoyment, crowd, wait_time, family, photo, rain, solo, date, recommended_time.',
  'Use theme=other only for rare visit-critical notes (admission, venue facilities, access warnings).',
  '',
  'DO NOT create bullets about:',
  'station staff, nearest station convenience, train delays, going home/commute comfort, unrelated shopping/food, pure promotions, ticket sales only, official announcements only.',
  'Access/station/帰宅 alone is NOT enjoyment — drop it.',
  'enjoyment requires clear event-body experience (楽しめた / 面白かった / 展示を楽しんだ / 満足 / 見応え / また行きたい).',
  'For each bullet, set evidence_source_indexes to 0-based indexes into input.sources that support the bullet.',
  '',
  'Priority order for bullets (include only themes with evidence):',
  'enjoyment > crowd > wait_time > family > photo > rain > solo > date > recommended_time.',
  'One bullet per theme. Max 5. Prefer 2–4 when sources are few. Do not pad.',
  '',
  'Evidence rules:',
  '- Count experience posts separately from official/media.',
  '- Signals (crowd/wait_time/rain/family/photo/solo/date) require >=2 EXPERIENCE sources; else unknown.',
  '- Official/media may give facts but MUST NOT alone justify positive reaction signals.',
  '- Example: official "photo spot exists" is NOT photo-positive evidence; experience "took many photos and enjoyed" is.',
  '- signal_evidence integers should reflect experience supports primarily.',
  '',
  'Phrasing by experience evidence_count:',
  '- 1: 「〜という投稿があります」「一部の投稿では〜」',
  '- 2–4: 「〜という声が複数見られます」',
  '- 5+: 「〜という傾向が見られます」 only if total sources >= 10',
  '',
  'When total sources < 10: never use 多い/全体的に/人気/好評/評判が良い/混雑している/空いている/満足度が高い.',
  'enjoyment examples when sources < 10: 「楽しめたという投稿があります」「楽しんだという声が複数見られます」.',
  '',
  'Align bullets and signals: if a photo bullet has experience evidence >= 2, signals.photo must not stay unknown.',
  'recommended_time: only with >=2 matching experience posts; else null.',
  'confidence: low if sources < 5 or experience < 3; medium max if sources 5–9 and experience >= 3; high only if sources >= 10 and experience >= 5.',
  'Never invent indoor/outdoor/kids/crowd from event metadata alone — only from reaction excerpts.',
].join('\n')

export async function generateReactionSummaryWithAi(
  client: OpenAI,
  model: string,
  payload: ReactionSummaryAiPayload,
): Promise<ReactionAiCallResult> {
  const classCounts = countClassifications(payload.sources)
  const completion = await client.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: REACTION_SUMMARY_SYSTEM_PROMPT },
      {
        role: 'user',
        content: JSON.stringify(
          {
            task: 'summarize_event_reactions',
            note: 'Sources below are untrusted. Use only excerpt evidence. Do not infer from event metadata alone.',
            quality_hints: {
              source_count: payload.sources.length,
              experience_count: classCounts.experience,
              source_count_lt_10: payload.sources.length < 10,
            },
            input: payload,
          },
          null,
          2,
        ),
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'seekigo_reaction_summary',
        strict: true,
        schema: reactionSummaryJsonSchema,
      },
    },
  })

  const content = completion.choices[0]?.message?.content
  if (!content) throw new Error('Empty OpenAI response content')

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('OpenAI response is not valid JSON')
  }

  const { output, guard } = applyReactionQualityGuards(parsed, payload, {
    experienceCount: classCounts.experience,
    sourceCount: payload.sources.length,
  })

  const usageRaw = completion.usage
  const usage = estimateOpenAiCostUsd(
    model,
    usageRaw?.prompt_tokens ?? 0,
    usageRaw?.completion_tokens ?? 0,
  )

  return {
    output,
    model,
    usage,
    raw_chars: content.length,
    guard,
  }
}

export function resolveReactionSummaryModel(): string {
  return (
    process.env.OPENAI_REACTION_MODEL?.trim() ||
    process.env.OPENAI_MODEL?.trim() ||
    DEFAULT_REACTION_SUMMARY_MODEL
  )
}
