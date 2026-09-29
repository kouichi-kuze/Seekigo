/**
 * Optional OpenAI assist: interpret already-extracted text only.
 * Must cite evidence_text that appears in the provided excerpt.
 */
import OpenAI from 'openai'
import type { VisitFieldName, VisitFieldProposal } from './types'
import { clipEvidence } from './html-text'

const MODEL =
  process.env.OPENAI_VISIT_ENRICH_MODEL?.trim() ||
  process.env.OPENAI_MODEL?.trim() ||
  'gpt-4.1-nano'

const TARGET_FIELDS: VisitFieldName[] = [
  'price_type',
  'reservation_status',
  'venue_type',
  'family_friendly',
  'parking_status',
  'age_note',
]

export type VisitAiAssistResult = {
  proposals: VisitFieldProposal[]
  model: string
  inputChars: number
  estimatedCostUsd: number | null
  skippedReason?: string
}

function estimateCostUsd(model: string, inputChars: number): number | null {
  // rough: ~4 chars/token; nano/mini cheap rates — log only
  const tokens = Math.ceil(inputChars / 4) + 400
  if (/nano/i.test(model)) return (tokens / 1_000_000) * 0.1
  if (/mini/i.test(model)) return (tokens / 1_000_000) * 0.15
  return (tokens / 1_000_000) * 0.5
}

function evidenceInExcerpt(evidence: string, excerpt: string): boolean {
  const e = evidence.replace(/\s+/g, '').slice(0, 40)
  const ex = excerpt.replace(/\s+/g, '')
  if (e.length < 2) return false
  return ex.includes(e)
}

export async function assistVisitAttrsWithAi(opts: {
  title: string
  sourceUrl: string | null
  excerpt: string
  deterministicSummary: string
}): Promise<VisitAiAssistResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    return {
      proposals: [],
      model: MODEL,
      inputChars: 0,
      estimatedCostUsd: null,
      skippedReason: 'no_openai_key',
    }
  }
  if (process.env.AI_DRY_RUN_NO_API === 'true') {
    return {
      proposals: [],
      model: MODEL,
      inputChars: 0,
      estimatedCostUsd: null,
      skippedReason: 'AI_DRY_RUN_NO_API',
    }
  }
  if (!opts.excerpt.trim()) {
    return {
      proposals: [],
      model: MODEL,
      inputChars: 0,
      estimatedCostUsd: null,
      skippedReason: 'empty_excerpt',
    }
  }

  const client = new OpenAI({ apiKey })
  const system = `You assist extraction of Japanese event visit attributes.
Rules:
- Only use facts present in evidence_excerpt.
- Never invent evidence_text; it must be a short substring of evidence_excerpt.
- If unsure, omit the field or set proposed_value null with confidence low.
- Do NOT mark family_friendly=yes from character/brand names alone.
- Do NOT set rain_friendly=yes from indoor alone.
- Prefer null over guessing.
Return JSON only.`

  const user = JSON.stringify(
    {
      title: opts.title,
      source_url: opts.sourceUrl,
      deterministic_summary: opts.deterministicSummary,
      evidence_excerpt: opts.excerpt.slice(0, 3500),
      fields: TARGET_FIELDS,
      allowed: {
        reservation_status: [
          'required',
          'recommended',
          'not_required',
          'unknown',
          null,
        ],
        venue_type: ['indoor', 'outdoor', 'mixed', 'unknown', null],
        family_friendly: ['yes', 'no', 'unknown', null],
        parking_status: [
          'available',
          'not_available',
          'nearby',
          'unknown',
          null,
        ],
        price_type: ['free', 'partially_paid', 'paid', 'varies', null],
      },
    },
    null,
    0,
  )

  const inputChars = system.length + user.length

  const completion = await client.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  })

  const raw = completion.choices[0]?.message?.content ?? '{}'
  let parsed: {
    items?: Array<{
      field?: string
      proposed_value?: unknown
      confidence?: string
      reason?: string
      evidence_text?: string
    }>
  }
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    return {
      proposals: [],
      model: MODEL,
      inputChars,
      estimatedCostUsd: estimateCostUsd(MODEL, inputChars),
      skippedReason: 'invalid_json',
    }
  }

  const proposals: VisitFieldProposal[] = []
  for (const item of parsed.items ?? []) {
    const field = item.field as VisitFieldName | undefined
    if (!field || !TARGET_FIELDS.includes(field)) continue
    const evidence = String(item.evidence_text ?? '').trim()
    if (!evidence || !evidenceInExcerpt(evidence, opts.excerpt)) continue

    let confidence: VisitFieldProposal['confidence'] = 'low'
    if (item.confidence === 'medium') confidence = 'medium'
    if (item.confidence === 'high') confidence = 'medium' // AI never high

    if (item.proposed_value === null || item.proposed_value === undefined) continue
    if (item.proposed_value === 'unknown') continue

    proposals.push({
      field,
      proposed_value: item.proposed_value as VisitFieldProposal['proposed_value'],
      confidence,
      reason: String(item.reason ?? 'AI assist on excerpt').slice(0, 200),
      evidence_text: clipEvidence(evidence),
      source_url: opts.sourceUrl,
      method: 'ai_assist',
    })
  }

  return {
    proposals,
    model: MODEL,
    inputChars,
    estimatedCostUsd: estimateCostUsd(MODEL, inputChars),
  }
}
