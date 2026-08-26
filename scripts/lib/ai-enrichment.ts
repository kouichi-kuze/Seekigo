/**
 * Seekigo 共通のイベント AI 整形（Structured Outputs）。
 * GO TOKYO / EnjoyTokyo 双方から利用する。
 */
import OpenAI from 'openai'

export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini'

export const CATEGORY_VALUES = [
  'exhibition',
  'art',
  'science',
  'festival',
  'food',
  'kids',
  'traditional',
  'illumination',
  'nightlife',
  'workshop',
  'music',
  'sports',
  'market',
  'seasonal',
  'other',
] as const

export type CategoryValue = (typeof CATEGORY_VALUES)[number]

export type EnrichmentInput = {
  title: string | null
  description: string | null
  venue: string | null
  address: string | null
  price_text: string | null
  start_date: string | null
  end_date: string | null
  start_time: string | null
  end_time: string | null
  /** 取得元の日本語エリア表記など（あればヒント。最終は slug 正規化） */
  area_hint?: string | null
}

export type FlagJudgment = {
  value: boolean | null
  reason: string
}

export type AiEnrichment = {
  area: {
    value: string | null
    reason: string
  }
  is_free: FlagJudgment
  is_indoor: FlagJudgment
  is_kids: FlagJudgment
  is_night: FlagJudgment
  category: string[]
  summary: string
}

export const enrichmentSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    area: {
      type: 'object',
      additionalProperties: false,
      properties: {
        value: {
          type: ['string', 'null'],
          description:
            'Tokyo area slug in lowercase english, e.g. shinjuku, shibuya, ueno, odaiba, asakusa, roppongi, arakawa, chuo, minato, taito, tama, higashiyamato, machida, meguro. Prefer specific area over ward. null if not certain.',
        },
        reason: { type: 'string' },
      },
      required: ['value', 'reason'],
    },
    is_free: {
      type: 'object',
      additionalProperties: false,
      properties: {
        value: { type: ['boolean', 'null'] },
        reason: { type: 'string' },
      },
      required: ['value', 'reason'],
    },
    is_indoor: {
      type: 'object',
      additionalProperties: false,
      properties: {
        value: { type: ['boolean', 'null'] },
        reason: { type: 'string' },
      },
      required: ['value', 'reason'],
    },
    is_kids: {
      type: 'object',
      additionalProperties: false,
      properties: {
        value: { type: ['boolean', 'null'] },
        reason: { type: 'string' },
      },
      required: ['value', 'reason'],
    },
    is_night: {
      type: 'object',
      additionalProperties: false,
      properties: {
        value: { type: ['boolean', 'null'] },
        reason: { type: 'string' },
      },
      required: ['value', 'reason'],
    },
    category: {
      type: 'array',
      items: {
        type: 'string',
        enum: [...CATEGORY_VALUES],
      },
    },
    summary: {
      type: 'string',
      description:
        'Japanese summary, about 80-140 characters, based only on description.',
    },
  },
  required: [
    'area',
    'is_free',
    'is_indoor',
    'is_kids',
    'is_night',
    'category',
    'summary',
  ],
} as const

const SYSTEM_PROMPT = [
  'You enrich Tokyo event records for Seekigo.',
  'Use ONLY the provided fields. Do not invent facts.',
  'Do not change or invent title, venue, dates, times, price, urls, or address.',
  'area: lowercase English Tokyo area slug.',
  'Examples: odaiba, ueno, asakusa, roppongi, shibuya, shinjuku, arakawa, chuo, minato, taito, tama, higashiyamato, harajuku, koenji, machida, meguro.',
  'Prefer specific neighborhood over ward name when both are known (e.g. 港区+お台場 -> odaiba, not minato).',
  'If area cannot be determined from venue/address/area_hint, area.value must be null.',
  'is_free.value = true if admission/participation itself is free (入場無料/参加無料/無料), even when some contents are paid (一部有料).',
  'is_free.value = false for clearly paid events (入場料○円 / 一般○円 / 有料). Prefer null when unclear.',
  'Prefer null over false when uncertain for booleans.',
  'is_indoor.value = true only for clearly indoor venues (museum, gallery, hall). Outdoor or unclear => false or null.',
  'is_kids.value = true only if clearly kids-oriented. Otherwise false or null.',
  'is_night.value = true only if clearly a nighttime event. Otherwise false or null.',
  'category: choose one or more from the allowed enum.',
  'summary: Japanese, about 80-140 characters, based only on description. Do not add dates, prices, address, or times not in description. Do not invent new facts.',
  'Every boolean/area object must include a short Japanese reason.',
].join('\n')

export function buildEnrichmentPromptPayload(event: EnrichmentInput) {
  return {
    title: event.title,
    description: event.description,
    venue: event.venue,
    address: event.address,
    price_text: event.price_text,
    start_date: event.start_date,
    end_date: event.end_date,
    start_time: event.start_time,
    end_time: event.end_time,
    area_hint: event.area_hint ?? null,
  }
}

export function normalizeAiEnrichment(parsed: AiEnrichment): AiEnrichment {
  const category = (parsed.category ?? []).filter((c) =>
    (CATEGORY_VALUES as readonly string[]).includes(c),
  )

  let areaValue = parsed.area?.value ?? null
  if (areaValue) {
    const slug = areaValue.trim().toLowerCase()
    areaValue = /^[a-z0-9-]+$/.test(slug) ? slug : null
  }

  return {
    area: {
      value: areaValue,
      reason: parsed.area?.reason ?? '',
    },
    is_free: {
      value: parsed.is_free?.value ?? null,
      reason: parsed.is_free?.reason ?? '',
    },
    is_indoor: {
      value: parsed.is_indoor?.value ?? null,
      reason: parsed.is_indoor?.reason ?? '',
    },
    is_kids: {
      value: parsed.is_kids?.value ?? null,
      reason: parsed.is_kids?.reason ?? '',
    },
    is_night: {
      value: parsed.is_night?.value ?? null,
      reason: parsed.is_night?.reason ?? '',
    },
    category: category.length > 0 ? category : ['other'],
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
  }
}

export async function enrichEventWithAi(
  client: OpenAI,
  model: string,
  event: EnrichmentInput,
): Promise<AiEnrichment> {
  const completion = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: JSON.stringify(buildEnrichmentPromptPayload(event), null, 2),
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'seekigo_event_enrichment',
        strict: true,
        schema: enrichmentSchema,
      },
    },
  })

  const content = completion.choices[0]?.message?.content
  if (!content) {
    throw new Error('Empty OpenAI response content')
  }

  const parsed = JSON.parse(content) as AiEnrichment
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('OpenAI response is not an object')
  }
  if (!Array.isArray(parsed.category) || typeof parsed.summary !== 'string') {
    throw new Error('OpenAI response missing category/summary')
  }

  return normalizeAiEnrichment(parsed)
}
