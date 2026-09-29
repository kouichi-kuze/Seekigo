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

export type PriceTypeJudgment = {
  value: 'free' | 'partially_paid' | 'paid' | 'varies' | null
  reason: string
}

export type AiEnrichment = {
  area: {
    value: string | null
    reason: string
  }
  price_type: PriceTypeJudgment
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
    price_type: {
      type: 'object',
      additionalProperties: false,
      properties: {
        value: {
          type: ['string', 'null'],
          enum: ['free', 'partially_paid', 'paid', 'varies', null],
        },
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
    'price_type',
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
  'price_type.value classifies the event fee. null if the text does not support a class.',
  'price_type free: the main admission or participation is clearly free (入場無料, 観覧無料, 参加無料, 無料).',
  'price_type partially_paid: a free base and a paid part coexist. 一部有料. 入場無料 but food, experience, or participation costs money. 観覧無料 but parade or activity entry is paid.',
  'price_type paid: the main general admission or participation is paid (一般○円, 参加費○円, チケット○円, 有料). Child, infant, disability, or special-day free exceptions stay paid.',
  'price_type varies: the fee system itself differs by shop, program, or content (店舗によって異なる, プログラムによって異なる).',
  'Do not set price_type from a bare 無料 or 円 mention when the role of that fee is unclear.',
  'Prefer null over false when uncertain for booleans.',
  'is_indoor.value = true only for clearly indoor venues (museum, gallery, hall). Outdoor or unclear => false or null.',
  'is_kids.value = true only if clearly kids-oriented. Otherwise false or null.',
  'is_night.value = true only for a "where to go at night" outing, not merely because a venue stays open late.',
  'Set is_night true when the main program starts at 17:00 or later, the text explicitly says a night program (夜市, 宵祭, ナイト, 夜間開催), or the outing itself is a night activity such as a beer garden or Bon Odori that continues until 20:00 or later.',
  'Do not set is_night true only because a museum or exhibition closes late, last entry is late, the title contains 暗闇 or グッドナイト, the category is nightlife or illumination, or the event is fireworks.',
  'If it is not clearly a night outing, is_night.value must be null. Use false only when it is clearly a daytime event.',
  'category: choose one or more from the allowed enum.',
  'If one or more specific categories fully describe the event, do not also include other.',
  'Use other alone when no specific category fits.',
  'Include other together with a specific category only when that category does not fully describe the event, such as a community gathering that is only partly a workshop or a closed meal that is only partly food.',
  'Do not add other as a filler beside a category that already describes the event.',
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
    price_type: {
      value:
        parsed.price_type?.value === 'free' ||
        parsed.price_type?.value === 'partially_paid' ||
        parsed.price_type?.value === 'paid' ||
        parsed.price_type?.value === 'varies'
          ? parsed.price_type.value
          : null,
      reason: parsed.price_type?.reason ?? '',
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

const WALKERPLUS_SUMMARY_PROMPT = [
  'You write a short original Japanese summary for a Tokyo outing site called SEEKIGO.',
  'Use ONLY the supplied title and source notes.',
  'Do not add facts, dates, prices, addresses, times, audiences, or scenes that are not written in the notes.',
  'Incomplete notes have already had the cut-off ending removed. Do not guess or complete a truncated sentence.',
  'If the remaining notes are not enough to say what the event is, return summary null.',
  'Rephrase into new sentences. Do not paste or shorten the source as-is.',
  'Do not add originality by inventing new facts or opinions.',
  'Keep each fact with the same subject as the notes. If the notes say "AはB", do not write "[event title]はB" unless A is the event title. Do not add where or when the event happens unless the notes say it.',
  'Copy proper nouns exactly, including Latin spellings such as "The Artcomplex Center of Tokyo". Do not translate them or mix scripts.',
  'Keep the words attached to a number. If the notes say 開館35周年, do not write a bare 35周年.',
  'Do not introduce verbs that are not in the notes, including 提案する.',
  'Write plainly, like an event listing. A good shape is: what it is, then what is offered.',
  'Do not write promotional copy. Never add phrases such as: 友人や家族と, デートに, 子どもと, 誰でも, 初心者でも, 特別なひととき, 素敵な時間, おすすめ, 必見, リラックスできる, 思い出になる, ぜひ.',
  'Also do not add evaluations or who it is for, unless those exact words are in the notes.',
  'If exact_latin_name is provided, copy that string into the summary unchanged.',
  'Aim for about 50 to 100 Japanese characters. Shorter is correct when the notes are short. Never pad the text to reach a length.',
].join('\n')

export async function generateWalkerplusSummary(
  client: OpenAI,
  model: string,
  input: { title: string; material: string },
): Promise<{ summary: string | null; draft: string | null; reason: string | null }> {
  const completion = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: WALKERPLUS_SUMMARY_PROMPT },
      {
        role: 'user',
        content:
          (exactLatinName(input.title)
            ? `The summary must include this exact text: ${exactLatinName(input.title)}\n\n`
            : '') +
          JSON.stringify(
          {
            title: input.title,
            source_notes: input.material,
          },
          null,
          2,
        ),
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'seekigo_walkerplus_summary',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: ['string', 'null'] },
          },
          required: ['summary'],
        },
      },
    },
  })
  const content = completion.choices[0]?.message?.content
  if (!content) throw new Error('Empty OpenAI response content')
  const parsed = JSON.parse(content) as { summary?: string | null }
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
  if (!summary) return { summary: null, draft: null, reason: 'empty' }
  const accepted = acceptWalkerplusSummary(summary, input.material, input.title)
  if (accepted.summary) return accepted

  const retry = await client.chat.completions.create({
    model,
    temperature: accepted.reason === 'added:示さ' || accepted.reason?.startsWith('missing:') ? 1 : accepted.reason?.startsWith('name:') ? 0.8 : 0.2,
    messages: [
      { role: 'system', content: WALKERPLUS_SUMMARY_PROMPT },
      {
        role: 'user',
        content:
          rewriteAfterRejection(accepted.reason) +
          '\n\n' +
          JSON.stringify(
          {
            title: input.title,
            source_notes: input.material,
            previous_summary: summary,
            rejection: accepted.reason,
          },
          null,
          2,
        ),
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'seekigo_walkerplus_summary',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: ['string', 'null'] },
          },
          required: ['summary'],
        },
      },
    },
  })
  const retryContent = retry.choices[0]?.message?.content
  if (!retryContent) return accepted
  const retryParsed = JSON.parse(retryContent) as { summary?: string | null }
  const retrySummary = typeof retryParsed.summary === 'string' ? retryParsed.summary.trim() : ''
  if (!retrySummary) return accepted
  const second = acceptWalkerplusSummary(retrySummary, input.material, input.title)
  if (second.summary || !second.draft) return second
  if (
    second.reason === accepted.reason &&
    !second.reason?.startsWith('name:') &&
    !second.reason?.startsWith('missing:') &&
    second.reason !== 'added:示さ'
  ) return second
  const again = await client.chat.completions.create({
    model,
    temperature: second.reason === 'added:示さ' || second.reason?.startsWith('missing:') ? 1 : second.reason?.startsWith('name:') ? 0.8 : 0.2,
    messages: [
      { role: 'system', content: WALKERPLUS_SUMMARY_PROMPT },
      {
        role: 'user',
        content:
          rewriteAfterRejection(second.reason) +
          '\n\n' +
          JSON.stringify(
          {
            title: input.title,
            source_notes: input.material,
            previous_summary: second.draft,
            rejection: second.reason,
          },
          null,
          2,
        ),
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'seekigo_walkerplus_summary',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: ['string', 'null'] },
          },
          required: ['summary'],
        },
      },
    },
  })
  const againContent = again.choices[0]?.message?.content
  if (!againContent) return second
  const againParsed = JSON.parse(againContent) as { summary?: string | null }
  const againSummary = typeof againParsed.summary === 'string' ? againParsed.summary.trim() : ''
  if (!againSummary) return second
  return acceptWalkerplusSummary(againSummary, input.material, input.title)
}

const WALKERPLUS_ADDED_PHRASES = [
  '友人や家族',
  '友人と',
  '家族と',
  'デート',
  '子どもと',
  '誰でも',
  '初心者',
  '特別なひととき',
  '特別な時間',
  '特別な空間',
  '素敵な時間',
  '素敵な',
  'おすすめ',
  'オススメ',
  '必見',
  'リラックス',
  '思い出',
  'ぜひ',
  '提案',
  '身近',
  '示さ',
]

function acceptWalkerplusSummary(
  summary: string,
  material: string,
  title: string,
): { summary: string | null; draft: string | null; reason: string | null } {
  const length = [...summary].length
  if (length > 140) {
    return { summary: null, draft: summary, reason: `length ${length}` }
  }
  const added = addedPhrase(summary, material)
  if (added) {
    return { summary: null, draft: summary, reason: `added:${added}` }
  }
  const missingFact = missingSourceFact(summary, material)
  if (missingFact) {
    return { summary: null, draft: summary, reason: `missing:${missingFact}` }
  }
  if (shiftsSubjectOntoTitle(summary, material)) {
    return { summary: null, draft: summary, reason: 'subject_shift' }
  }
  const missingName = missingExactLatinName(summary, title)
  if (missingName) {
    return { summary: null, draft: summary, reason: `name:${missingName}` }
  }
  if (sharesLongQuote(summary, material)) {
    return { summary: null, draft: summary, reason: 'too_close_to_source' }
  }
  return { summary, draft: summary, reason: null }
}

const REVIEW_AUDIENCE = [
  '友人',
  '家族',
  'デート',
  '子ども',
  'kids',
  '誰でも',
  '初心者',
  'カップル',
  '親子',
  '恋人',
  '一人で',
  'みんなで',
]

const REVIEW_PROMO = [
  ...WALKERPLUS_ADDED_PHRASES,
  '最高',
  '絶品',
  '人気',
  '話題',
  'お見逃し',
  '必見',
  '癒や',
  '癒し',
  '非日常',
  '特別な',
]

export function reviewWalkerplusSummaryDraft(input: {
  title: string
  material: string
  dropped: string
  summary: string
}): string[] {
  const flags: string[] = []
  const summary = input.summary.trim()
  const length = [...summary].length
  if (length > 140) flags.push(`over_140:${length}`)
  const corpus = `${input.title}\n${input.material}`.replace(/\s+/g, '')
  const compactSummary = summary.replace(/\s+/g, '')
  const compactMaterial = input.material.replace(/\s+/g, '')
  if (compactSummary.length >= 20 && compactMaterial.includes(compactSummary)) {
    flags.push('verbatim')
  }
  if (sharesLongQuote(summary, input.material)) flags.push('long_copy')

  const noteAdded = (label: string, phrase: string) => {
    if (compactSummary.includes(phrase) && !corpus.includes(phrase)) flags.push(`${label}:${phrase}`)
  }
  for (const phrase of REVIEW_AUDIENCE) noteAdded('audience', phrase)
  for (const phrase of REVIEW_PROMO) noteAdded('promo', phrase)

  for (const number of summary.match(/\d+/g) ?? []) {
    if (!corpus.includes(number)) flags.push(`number:${number}`)
  }
  for (const token of summary.match(/[ァ-ヶー]{3,}/g) ?? []) {
    if (!corpus.includes(token)) flags.push(`name:${token}`)
  }
  for (const token of summary.match(/[A-Za-z][A-Za-z0-9&'.-]{1,}/g) ?? []) {
    if (!corpus.toLowerCase().includes(token.toLowerCase())) flags.push(`name:${token}`)
  }
  for (const quoted of summary.matchAll(/「([^」]{2,})」/g)) {
    const inner = quoted[1].replace(/\s+/g, '')
    if (inner && !corpus.includes(inner)) flags.push(`quote:${quoted[1]}`)
  }

  const dropped = input.dropped.replace(/\s+/g, '')
  if (dropped) {
    const pieces = [
      ...(summary.match(/[ァ-ヶー]{3,}/g) ?? []),
      ...(summary.match(/\d+/g) ?? []),
      ...(summary.match(/[A-Za-z][A-Za-z0-9]{2,}/g) ?? []),
    ]
    for (const piece of pieces) {
      if (dropped.includes(piece) && !corpus.includes(piece)) flags.push(`truncated:${piece}`)
    }
  }
  return [...new Set(flags)]
}

function exactLatinName(title: string): string | null {
  return title.match(/[A-Z][A-Za-z0-9'’.,]*(?:\s+[A-Za-z0-9'’.,]+){2,}/)?.[0] ?? null
}

function missingExactLatinName(summary: string, title: string): string | null {
  const name = exactLatinName(title)
  if (!name || summary.includes(name)) return null
  return name
}

function shiftsSubjectOntoTitle(summary: string, material: string): boolean {
  const named = material.match(/([^。．]{2,40})は/)
  if (!named) return false
  const subject = named[1].replace(/\s+/g, '').trim()
  if (!subject || subject.length < 4) return false
  const text = summary.replace(/\s+/g, '')
  const titleSubject = text.match(/^(.+?)は/)
  if (!titleSubject) return false
  const claimed = titleSubject[1]
  if (claimed.includes(subject) || subject.includes(claimed)) return false
  if (text.includes(`${subject}は`) || text.includes(`${subject}が`)) return false
  return text.includes(subject)
}

function rewriteAfterRejection(reason: string | null): string {
  if (reason === 'subject_shift') {
    return 'The previous summary gave the event title a description whose subject in the notes is a different name. Keep that name as the subject. Do not add where the event is held.'
  }
  if (reason === 'too_close_to_source') {
    return 'The previous summary copied a long stretch of the notes. Rephrase the predicates. Keep each proper noun and each subject. Do not paste は真っ暗闇のエンターテイメント as a block. Do not add 提案する.'
  }
  if (reason?.startsWith('name:')) {
    const name = reason.slice(5)
    return `Include this exact string, unchanged: ${name}. Then rephrase the facts in source_notes as new sentences. Keep their subjects. Do not paste them. Do not write 提案.`
  }
  if (reason?.startsWith('missing:')) {
    return `Keep this wording from the notes: ${reason.slice(8)}. Include the exact Latin name when one is required. Do not replace it with 示す, 提案, or 身近.`
  }
  if (reason?.startsWith('added:')) {
    return `Remove "${reason.slice(6)}". If the notes say 敷居が高いと感じられている, keep that phrase. Keep 潤いや優しさ and the exact Latin name.`
  }
  return 'Previous summary was rejected. Keep only facts written in source_notes, with the same subject. Copy proper nouns exactly. Keep modifiers on numbers. Do not lengthen the text to hit a count.'
}

function missingSourceFact(summary: string, material: string): string | null {
  const text = summary.replace(/\s+/g, '')
  const source = material.replace(/\s+/g, '')
  for (const phrase of ['敷居が高い', '開館']) {
    if (source.includes(phrase) && !text.includes(phrase)) return phrase
  }
  return null
}

function addedPhrase(summary: string, material: string): string | null {
  const source = material.replace(/\s+/g, '')
  const text = summary.replace(/\s+/g, '')
  for (const phrase of WALKERPLUS_ADDED_PHRASES) {
    if (text.includes(phrase) && !source.includes(phrase)) return phrase
  }
  return null
}

function sharesLongQuote(summary: string, material: string): boolean {
  const stripNames = (value: string) => value.replace(/[ァ-ヶー・]{8,}/g, '').replace(/\s+/g, '')
  const left = stripNames(summary)
  const right = stripNames(material)
  const size = 24
  if (left.length < size) return false
  for (let index = 0; index + size <= left.length; index += 8) {
    if (right.includes(left.slice(index, index + size))) return true
  }
  return false
}
