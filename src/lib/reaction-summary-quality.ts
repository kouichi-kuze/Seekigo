/**
 * Phase 4B-3.1 / 4B-3.2: reaction summary quality guards.
 * Theme selection + signal consistency + phrase safety (TypeScript, not prompt-only).
 */
import type { ReactionConfidence } from './event-reaction-summary'
import type {
  ReactionSignalPolarity,
  ReactionSummaryAiJson,
  ReactionSummaryAiPayload,
  ReactionSummaryAiSourceItem,
} from './reaction-summary-ai'

export const REACTION_BULLET_THEMES = [
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
] as const

export type ReactionBulletTheme = (typeof REACTION_BULLET_THEMES)[number]

/** Priority for summary bullets (1 = highest). */
export const THEME_PRIORITY: ReactionBulletTheme[] = [
  'enjoyment',
  'crowd',
  'wait_time',
  'family',
  'photo',
  'rain',
  'solo',
  'date',
  'recommended_time',
]

export type BulletDebug = {
  text: string
  theme: ReactionBulletTheme
  evidence_count: number
}

export type QualityGuardMeta = {
  sourceCount: number
  experienceCount: number
  actions: string[]
  bullets_debug: BulletDebug[]
}

export type ClassEvidence = {
  experience: number
  official: number
  media: number
  other: number
}

export type ThemeEvidenceMap = Record<
  Exclude<ReactionBulletTheme, 'other'> | 'recommended_time',
  ClassEvidence
>

const THEME_RES: Record<Exclude<ReactionBulletTheme, 'other'>, RegExp> = {
  enjoyment:
    /楽し(かった|めた|んだ|む)|面白(かった|い)|満足|最高だった|見応え|また行きたい|展示を?楽|行ってよかった|見てよかった/,
  crowd: /混雑|混んで|人が多|人多|ガラガラ|空いて|すいて|閑散|ゆったり見|少人数/,
  wait_time: /待ち時間|待った|並ん|行列|列が|待機/,
  family: /子ども|子供|子連れ|家族|親子|キッズ/,
  photo: /写真|フォト|映え|撮っ|撮影/,
  rain: /雨|雨天|レイン|大雨|傘/,
  solo: /一人で|ひとりで|ソロ|単独/,
  date: /デート|カップル|恋人|彼氏|彼女/,
  recommended_time:
    /午前|午後|夕方|朝イチ|朝一|夜(が|は)?|平日|土日|週末|開場直後|閉館前|おすすめ.*時間|行きやすい時間/,
}

/** Event-body experience cues (enjoyment must have at least one). */
const EVENT_BODY_ENJOYMENT_RE =
  /楽し(かった|めた|んだ|む)|面白(かった|い)|満足|最高だった|見応え|また行きたい|展示を?楽|会場で楽し|イベントを?楽し|行ってよかった|見てよかった|行ってきた|見てきた|入場.*(楽|面白)/

/**
 * Peripheral / off-event travel & neighborhood talk.
 * Drop from summary unless OTHER_KEEP_RE (visit-critical) matches.
 */
const PERIPHERAL_RE =
  /最寄り駅|駅員|駅スタッフ|電車|乗り換え|乗換|遅延|運休|運行状況|帰宅|帰り道|帰り|アクセスが(良い|いい|よい|良く|よく)|アクセス良好|駐車場スタッフ|周辺店舗|コンビニ|レストラン|ランチ|ディナー|買い物|グッズ屋|移動が楽|駅が便利|周辺が便利/

/** Exclude from summary unless clearly visit-decision relevant (handled separately). */
const EXCLUDED_TOPIC_RE =
  /スタッフ対応|チケット(販売|発売|受付)|開催(中です|のお知らせ|決定)|詳細はこちら|公式サイト|プレスリリース|割引コード|求人|募集|宣伝|コラボカフェ(?!.*楽し)|グッズ売/

const VAGUE_IRRELEVANT_RE =
  /外出できなかった|外出は難し|もう一度訪れたい|日常|関係ない|ついでの話/

/** other theme may keep only these visit-relevant topics */
const OTHER_KEEP_RE =
  /入退場|入場導線|退場|会場設備|会場入口|バリアフリー|アクセス(注意|難|が悪|が大変)|徒歩が.*(長い|遠い)|持ち物|ロッカー|雨天実施|中止/

/** True when text is mostly station/commute/neighborhood, not the event itself. */
export function isPeripheralText(text: string): boolean {
  if (!PERIPHERAL_RE.test(text)) return false
  // Rare visit-critical access issues may keep
  if (OTHER_KEEP_RE.test(text)) return false
  return true
}

/** Enjoyment requires clear event-body experience words; not travel comfort alone. */
export function isValidEnjoymentText(text: string): boolean {
  if (!EVENT_BODY_ENJOYMENT_RE.test(text)) return false
  if (!isPeripheralText(text)) return true
  // Peripheral + enjoyment: keep only if event-body cue remains after stripping travel phrases
  const stripped = text
    .replace(/最寄り駅[^、。]*/g, '')
    .replace(/駅員[^、。]*/g, '')
    .replace(/駅スタッフ[^、。]*/g, '')
    .replace(/電車[^、。]*/g, '')
    .replace(/帰宅[^、。]*/g, '')
    .replace(/帰り道[^、。]*/g, '')
    .replace(/アクセスが(良い|いい|よい|良く|よく)[^、。]*/g, '')
    .replace(/気持ちよく帰宅[^、。]*/g, '')
  return EVENT_BODY_ENJOYMENT_RE.test(stripped)
}

const STRONG_GENERALIZATION_RES: Array<{ re: RegExp; label: string }> = [
  { re: /全体的に/, label: '全体的に' },
  { re: /評判が良い|評判がいい|評判の良い|評判のいい/, label: '評判が良い' },
  { re: /好評/, label: '好評' },
  { re: /人気(が高い|がある|No\.?1|ナンバーワン)?/, label: '人気' },
  { re: /混雑している|混雑は少なめ|混雑は少ない|空いている/, label: '混雑/空き断定' },
  { re: /する人が多い|人が多い|来場者が多い|投稿が多い/, label: '〜が多い' },
  {
    re: /という傾向がある|という傾向が見られる|傾向が見られます|傾向があります/,
    label: '傾向がある',
  },
  { re: /多くの人(が|は)/, label: '多くの人が' },
  { re: /みんな(が|は)?/, label: 'みんな' },
  { re: /必ず|絶対(に)?/, label: '必ず/絶対' },
  { re: /推測される|はずです|に違いない/, label: '推測' },
  { re: /満足度が高い/, label: '満足度が高い' },
]

const SUMMARY_WRAPUP_RE =
  /全体的に(は)?好意的|評判が良い|人気が高い|多くの人が楽し|好意的な反応が多い|参考情報として|満足度が高い/

const INDOOR_OUTDOOR_RE = /室内|屋内|屋外|野外/

const LOW_SOURCE_NOTE =
  '投稿数がまだ限られているため、参考情報としてご覧ください。'

const SIGNAL_KEYS = [
  'crowd',
  'family',
  'date',
  'solo',
  'photo',
  'rain',
  'wait_time',
] as const

type SignalKey = (typeof SIGNAL_KEYS)[number]

function emptyClassEvidence(): ClassEvidence {
  return { experience: 0, official: 0, media: 0, other: 0 }
}

function emptyThemeEvidence(): ThemeEvidenceMap {
  return {
    enjoyment: emptyClassEvidence(),
    crowd: emptyClassEvidence(),
    wait_time: emptyClassEvidence(),
    family: emptyClassEvidence(),
    photo: emptyClassEvidence(),
    rain: emptyClassEvidence(),
    solo: emptyClassEvidence(),
    date: emptyClassEvidence(),
    recommended_time: emptyClassEvidence(),
  }
}

export function computeThemeEvidence(
  sources: ReactionSummaryAiSourceItem[],
): ThemeEvidenceMap {
  const map = emptyThemeEvidence()
  for (const s of sources) {
    const text = s.excerpt_for_internal_review
    const cls = s.classification
    for (const theme of Object.keys(THEME_RES) as Array<keyof typeof THEME_RES>) {
      if (theme === 'enjoyment') {
        // Do not count station/commute-only posts as enjoyment evidence
        if (!isValidEnjoymentText(text)) continue
      } else if (isPeripheralText(text) && !THEME_RES[theme].test(text)) {
        continue
      }
      if (THEME_RES[theme].test(text)) {
        map[theme][cls] += 1
      }
    }
  }
  return map
}

/** Experience-first count used for signals. */
export function experienceEvidence(
  map: ThemeEvidenceMap,
  theme: keyof ThemeEvidenceMap,
): number {
  return map[theme].experience
}

/**
 * Infer bullet theme from text (fallback when AI omits/mislabels).
 */
export function classifyBulletTheme(text: string): ReactionBulletTheme {
  if (isPeripheralText(text) && !OTHER_KEEP_RE.test(text)) {
    return 'other'
  }
  if (EXCLUDED_TOPIC_RE.test(text) && !OTHER_KEEP_RE.test(text)) {
    return 'other'
  }
  // Prefer specific visit signals over broad enjoyment when both match
  const specificFirst: ReactionBulletTheme[] = [
    'crowd',
    'wait_time',
    'family',
    'photo',
    'rain',
    'solo',
    'date',
    'recommended_time',
    'enjoyment',
  ]
  for (const theme of specificFirst) {
    if (theme === 'enjoyment') {
      if (isValidEnjoymentText(text)) return 'enjoyment'
      continue
    }
    if (THEME_RES[theme].test(text)) return theme
  }
  return 'other'
}

export function confidenceUpperBound(meta: {
  sourceCount: number
  experienceCount: number
}): ReactionConfidence {
  const { sourceCount, experienceCount } = meta
  if (sourceCount < 5 || experienceCount < 3) return 'low'
  if (sourceCount < 10 || experienceCount < 5) return 'medium'
  return 'high'
}

export function applyConfidenceCap(
  ai: ReactionConfidence,
  meta: { sourceCount: number; experienceCount: number },
): ReactionConfidence {
  const max = confidenceUpperBound(meta)
  const rank = { low: 0, medium: 1, high: 2 } as const
  return rank[ai] <= rank[max] ? ai : max
}

function softenStrongPhrases(text: string, sourceCount: number): string {
  if (sourceCount >= 10) return text
  let t = text
  t = t.replace(/全体的に(は)?/g, '一部の投稿では')
  t = t.replace(/評判が良い|評判がいい|評判の良い|評判のいい/g, '好意的な声もある')
  t = t.replace(/好評(だ|です|との)?/g, '好意的な声がある')
  t = t.replace(/人気(が高い|がある)?/g, '関心する声がある')
  t = t.replace(/満足度が高い/g, '満足したという声がある')
  t = t.replace(/混雑している/g, '混雑に触れた投稿がある')
  t = t.replace(/混雑は少なめ|混雑は少ない/g, '混雑について触れた投稿がある')
  t = t.replace(/空いている/g, '空いていたという投稿がある')
  t = t.replace(/(する)?人が多い|来場者が多い|投稿が多い/g, 'という投稿がある')
  t = t.replace(/多くの人(が|は)/g, '一部の投稿では')
  t = t.replace(/みんな(が|は)?/g, '一部では')
  t = t.replace(
    /という傾向がある|という傾向が見られる|傾向が見られます|傾向があります/g,
    'という声が見られます',
  )
  t = t.replace(/推測される|はずです|に違いない/g, 'という声があります')
  t = t.replace(/多い/g, 'ある')
  t = t.replace(/というという/g, 'という')
  return t.trim()
}

export function rewriteBulletForEvidence(
  text: string,
  evidenceCount: number,
  sourceCount: number,
  theme?: ReactionBulletTheme,
): string {
  let t = softenStrongPhrases(text, sourceCount)

  if (theme === 'enjoyment' && sourceCount < 10) {
    t = t
      .replace(/好評|評判が良い|全体的に満足/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (evidenceCount <= 1 && !/投稿があります|声が見られます|体験談/.test(t)) {
      if (/楽し|面白|満足/.test(t)) {
        t = 'イベントを楽しめたという投稿があります。'
      }
    } else if (evidenceCount >= 2 && /楽し|面白|満足/.test(t) && /多い|全体/.test(text)) {
      t = 'イベントを楽しんだという声が複数見られます。'
    }
  }

  if (evidenceCount <= 1) {
    if (/声が複数|傾向|が多い|多く/.test(t)) {
      t = t
        .replace(/声が複数見られます/g, '投稿があります')
        .replace(/傾向が見られます/g, '投稿があります')
        .replace(/が多い/g, 'がある')
    }
  } else if (evidenceCount <= 4 || sourceCount < 10) {
    if (/傾向が見られます|傾向がある/.test(t) && sourceCount < 10) {
      t = t.replace(/傾向が見られます|傾向がある/g, '声が複数見られます')
    }
    if (evidenceCount >= 2 && /投稿があります/.test(t) && !/複数/.test(t)) {
      t = t.replace(/という投稿があります/g, 'という声が複数見られます')
    }
  }

  return t.slice(0, 120)
}

function normalizeForDedupe(text: string): string {
  return text
    .toLowerCase()
    .replace(/[、。．！？!?\s　・「」『』（）()]/g, '')
    .replace(/雨天(時|でも|にも関わらず)?|大雨|天気に関係なく|にも関わらず/g, '雨')
    .replace(/楽しめた|楽しんでいる|楽しん|楽しむ|楽しみ/g, '楽')
    .replace(/見られ|あります|ある|です|との|意見|体験談/g, '')
    .replace(/という|一部の|投稿|声|複数/g, '')
}

function bigramSet(s: string): Set<string> {
  const set = new Set<string>()
  const t = s.length < 2 ? s + '_' : s
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2))
  return set
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter += 1
  return inter / (a.size + b.size - inter)
}

type ParsedBullet = {
  text: string
  theme: ReactionBulletTheme
  evidence_count: number
  evidence_source_indexes: number[]
}

function parseEvidenceIndexes(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .map((n) => Math.floor(n))
    .slice(0, 20)
}

function parseBulletsWithTheme(raw: unknown): ParsedBullet[] {
  if (!Array.isArray(raw)) return []
  const out: ParsedBullet[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const text = item.trim()
      if (!text) continue
      out.push({
        text: text.slice(0, 120),
        theme: classifyBulletTheme(text),
        evidence_count: 1,
        evidence_source_indexes: [],
      })
      continue
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const o = item as Record<string, unknown>
      const text = String(o.text ?? o.bullet ?? '').trim()
      if (!text) continue
      const ev = Number(o.evidence_count ?? 1)
      const themeRaw = String(o.theme ?? '')
      const theme = (REACTION_BULLET_THEMES as readonly string[]).includes(themeRaw)
        ? (themeRaw as ReactionBulletTheme)
        : classifyBulletTheme(text)
      out.push({
        text: text.slice(0, 120),
        theme,
        evidence_count: Number.isFinite(ev) && ev > 0 ? Math.floor(ev) : 1,
        evidence_source_indexes: parseEvidenceIndexes(o.evidence_source_indexes),
      })
    }
  }
  return out.slice(0, 10)
}

function evidenceExcerptsArePeripheral(
  b: ParsedBullet,
  sources: ReactionSummaryAiSourceItem[],
): boolean {
  if (!b.evidence_source_indexes.length) return false
  const texts = b.evidence_source_indexes
    .map((i) => sources[i]?.excerpt_for_internal_review)
    .filter((t): t is string => Boolean(t))
  if (!texts.length) return false
  // All cited excerpts peripheral → drop
  return texts.every((t) => isPeripheralText(t))
}

function isExcludedBullet(
  b: ParsedBullet,
  sources: ReactionSummaryAiSourceItem[],
): { drop: boolean; reason: string | null } {
  if (VAGUE_IRRELEVANT_RE.test(b.text)) {
    return { drop: true, reason: 'drop_excluded_peripheral' }
  }
  if (isPeripheralText(b.text)) {
    return { drop: true, reason: 'drop_excluded_peripheral' }
  }
  if (EXCLUDED_TOPIC_RE.test(b.text) && !OTHER_KEEP_RE.test(b.text)) {
    return { drop: true, reason: `drop_excluded_theme_${b.theme}` }
  }
  if (b.theme === 'enjoyment' && !isValidEnjoymentText(b.text)) {
    return { drop: true, reason: 'drop_excluded_peripheral' }
  }
  if (evidenceExcerptsArePeripheral(b, sources)) {
    return { drop: true, reason: 'drop_excluded_peripheral' }
  }
  if (b.theme === 'other') {
    return {
      drop: !OTHER_KEEP_RE.test(b.text),
      reason: OTHER_KEEP_RE.test(b.text) ? null : 'drop_excluded_theme_other',
    }
  }
  return { drop: false, reason: null }
}

function stillHasStrongPhrase(text: string): boolean {
  return STRONG_GENERALIZATION_RES.some(({ re }) => re.test(text))
}

function sourcesMention(
  sources: ReactionSummaryAiSourceItem[],
  re: RegExp,
): boolean {
  return sources.some((s) => re.test(s.excerpt_for_internal_review))
}

/**
 * Derive polarity from experience excerpts for a theme.
 */
function derivePolarityFromSources(
  sources: ReactionSummaryAiSourceItem[],
  theme: SignalKey,
): ReactionSignalPolarity {
  const experience = sources.filter((s) => s.classification === 'experience')
  const matching = experience.filter((s) => THEME_RES[theme].test(s.excerpt_for_internal_review))
  if (matching.length < 2) return 'unknown'

  const posRe: Record<SignalKey, RegExp> = {
    crowd: /空いて|すいて|閑散|ゆったり|少人数|混んでいなかった/,
    wait_time: /待ち(が)?短|すぐ入れ|並ばず|スムーズ/,
    rain: /雨.*(楽し|大丈夫|問題ない)|雨天でも楽し|濡れず/,
    family: /子ども|子供|子連れ|家族.*(楽し|おすすめ)|親子/,
    photo: /写真.*(楽|撮|映)|撮れた|映え|撮影.*楽/,
    solo: /一人で.*(楽し|行け)|ソロ.*(楽し|おすすめ)|ひとりで.*(楽し)/,
    date: /デート.*(楽し|おすすめ)|カップル.*(楽し)/,
  }
  const negRe: Record<SignalKey, RegExp> = {
    crowd: /混雑|混んで|人が多|人多|狭い|押し/,
    wait_time: /待ち(が)?長|長蛇|並んだ|行列|待った/,
    rain: /雨.*(残念|中止|厳し|濡れ)|雨で/,
    family: /子ども.*(向かない|厳しい)|子連れ.*(厳しい|難しい)/,
    photo: /撮れない|撮影禁止|写真.*(ダメ|禁止)/,
    solo: /一人.*(寂しい|向かない)/,
    date: /デート.*(向かない|微妙)/,
  }

  let pos = 0
  let neg = 0
  for (const s of matching) {
    const t = s.excerpt_for_internal_review
    if (posRe[theme].test(t)) pos += 1
    if (negRe[theme].test(t)) neg += 1
  }
  if (pos >= 1 && neg >= 1) return 'mixed'
  if (pos >= 2) return 'positive'
  if (neg >= 2) return 'negative'
  if (pos >= 1 && matching.length >= 2) return 'positive'
  if (neg >= 1 && matching.length >= 2) return 'negative'
  // Mentions exist but polarity unclear
  return 'neutral'
}

function alignSignals(opts: {
  aiSignals: ReactionSummaryAiJson['signals']
  themeEvidence: ThemeEvidenceMap
  keptBullets: ParsedBullet[]
  sources: ReactionSummaryAiSourceItem[]
  actions: string[]
}): ReactionSummaryAiJson['signals'] {
  const { aiSignals, themeEvidence, keptBullets, sources, actions } = opts
  const next = { ...aiSignals }

  for (const key of SIGNAL_KEYS) {
    const expEv = experienceEvidence(themeEvidence, key)
    const bulletHit = keptBullets.find(
      (b) => b.theme === key && b.evidence_count >= 2,
    )
    const derived = derivePolarityFromSources(sources, key)

    // No experience evidence → force unknown (official/media don't count)
    if (expEv < 2) {
      if (next[key] !== 'unknown' && next[key] !== 'neutral') {
        actions.push(`signal_${key}_cleared_low_experience_${expEv}`)
      }
      // Keep neutral only if somehow useful? Spec: 1件 → unknown. <2 → unknown for pos/neg/mixed
      if (next[key] === 'positive' || next[key] === 'negative' || next[key] === 'mixed') {
        next[key] = 'unknown'
      } else if (expEv < 1) {
        next[key] = 'unknown'
      }
      // If bullet claims theme with evidence_count from AI but our expEv < 2, still unknown
      continue
    }

    // Have ≥2 experience evidence
    if (
      next[key] === 'unknown' ||
      (bulletHit && next[key] === 'unknown')
    ) {
      next[key] = derived === 'unknown' ? 'neutral' : derived
      actions.push(`signal_${key}_aligned_from_evidence`)
    } else if (
      (next[key] === 'positive' ||
        next[key] === 'negative' ||
        next[key] === 'mixed') &&
      derived !== 'unknown' &&
      derived !== next[key]
    ) {
      // Prefer mixed when conflict, else derived from sources
      if (
        (next[key] === 'positive' && derived === 'negative') ||
        (next[key] === 'negative' && derived === 'positive')
      ) {
        next[key] = 'mixed'
        actions.push(`signal_${key}_conflict_mixed`)
      } else if (derived === 'mixed') {
        next[key] = 'mixed'
        actions.push(`signal_${key}_aligned_mixed`)
      }
    }

    // Bullet with evidence >= 2 must not leave unknown
    if (bulletHit && next[key] === 'unknown') {
      next[key] = derived === 'unknown' ? 'neutral' : derived
      actions.push(`signal_${key}_from_bullet`)
    }
  }

  return next
}

function selectByThemePriority(
  bullets: ParsedBullet[],
  actions: string[],
): ParsedBullet[] {
  const byTheme = new Map<ReactionBulletTheme, ParsedBullet>()

  // Prefer higher evidence within same theme; first occurrence after sort by evidence
  const sorted = [...bullets].sort(
    (a, b) => b.evidence_count - a.evidence_count,
  )

  for (const b of sorted) {
    if (b.theme === 'other') {
      // only if already filtered to keepable other
      if (!byTheme.has('other')) byTheme.set('other', b)
      else actions.push('drop_duplicate_theme_other')
      continue
    }
    if (byTheme.has(b.theme)) {
      actions.push(`drop_duplicate_theme_${b.theme}`)
      continue
    }
    byTheme.set(b.theme, b)
  }

  const selected: ParsedBullet[] = []
  for (const theme of THEME_PRIORITY) {
    const b = byTheme.get(theme)
    if (b) selected.push(b)
    if (selected.length >= 5) break
  }
  // optionally one other at end if room
  if (selected.length < 5 && byTheme.has('other')) {
    selected.push(byTheme.get('other')!)
  }
  return selected
}

/**
 * Apply all quality guards including theme selection (4B-3.2).
 */
export function applyReactionQualityGuards(
  rawAi: unknown,
  payload: ReactionSummaryAiPayload,
  classMeta: { experienceCount: number; sourceCount: number },
): { output: ReactionSummaryAiJson; guard: QualityGuardMeta } {
  const actions: string[] = []
  const sourceCount = classMeta.sourceCount
  const experienceCount = classMeta.experienceCount
  const themeEvidence = computeThemeEvidence(payload.sources)

  if (!rawAi || typeof rawAi !== 'object' || Array.isArray(rawAi)) {
    throw new Error('AI response is not an object')
  }
  const obj = rawAi as Record<string, unknown>

  let bullets = parseBulletsWithTheme(obj.summary_bullets)
  if (!bullets.length) {
    throw new Error('AI returned empty summary_bullets')
  }

  // Reconcile theme label with text + experience evidence
  bullets = bullets.map((b) => {
    const inferred = classifyBulletTheme(b.text)
    let theme = b.theme
    // If AI said priority theme but text is excluded → other/exclude later
    if (inferred !== 'other' && theme === 'other') theme = inferred
    if (theme !== inferred && inferred !== 'other' && theme === 'enjoyment' && inferred !== 'enjoyment') {
      // keep more specific inferred theme
      theme = inferred
      actions.push(`theme_reconcile_${b.theme}_to_${inferred}`)
    }
    // Cap evidence by experience evidence for that theme
    const themeKey = theme === 'other' ? null : (theme as keyof ThemeEvidenceMap)
    let ev = b.evidence_count
    if (themeKey) {
      const exp = experienceEvidence(themeEvidence, themeKey)
      if (exp > 0) {
        // Prefer experience-counted evidence for phrasing / signal alignment
        if (ev > exp) {
          ev = exp
          actions.push(`evidence_capped_${theme}`)
        } else if (ev < exp) {
          ev = exp
          actions.push(`evidence_raised_${theme}`)
        }
      }
      if (exp === 0 && theme !== 'enjoyment') {
        actions.push(`no_experience_evidence_${theme}`)
      }
    }
    return { ...b, theme, evidence_count: Math.max(1, ev) }
  })

  // Drop excluded / wrap-up / indoor inference / strong phrases
  bullets = bullets.filter((b) => {
    if (sourceCount < 10 && SUMMARY_WRAPUP_RE.test(b.text)) {
      actions.push('drop_wrapup_bullet')
      return false
    }
    const excluded = isExcludedBullet(b, payload.sources)
    if (excluded.drop) {
      actions.push(excluded.reason ?? `drop_excluded_theme_${b.theme}`)
      return false
    }
    if (
      INDOOR_OUTDOOR_RE.test(b.text) &&
      !sourcesMention(payload.sources, INDOOR_OUTDOOR_RE)
    ) {
      actions.push('drop_indoor_outdoor_inference')
      return false
    }
    // Signal-aligned themes need at least 1 experience hit (prefer 2 for keeping)
    if (
      b.theme !== 'enjoyment' &&
      b.theme !== 'other' &&
      b.theme !== 'recommended_time'
    ) {
      const exp = experienceEvidence(themeEvidence, b.theme)
      if (exp < 1) {
        actions.push(`drop_no_experience_${b.theme}`)
        return false
      }
    }
    if (b.theme === 'enjoyment') {
      const exp = experienceEvidence(themeEvidence, 'enjoyment')
      if (exp < 1 || !isValidEnjoymentText(b.text)) {
        actions.push(
          !isValidEnjoymentText(b.text)
            ? 'drop_excluded_peripheral'
            : 'drop_no_experience_enjoyment',
        )
        return false
      }
    }
    return true
  })

  bullets = bullets.map((b) => {
    const after = rewriteBulletForEvidence(
      b.text,
      b.evidence_count,
      sourceCount,
      b.theme,
    )
    if (after !== b.text) actions.push('soften_bullet')
    return { ...b, text: after }
  })

  // Split multi-theme mashups into a single clean line for the assigned theme
  bullets = bullets.map((b) => {
    if (b.theme === 'photo' && THEME_RES.rain.test(b.text)) {
      actions.push('normalize_photo_bullet')
      return {
        ...b,
        text:
          b.evidence_count >= 2
            ? '写真撮影を楽しんだという声が複数見られます。'
            : '写真撮影を楽しんだという投稿があります。',
      }
    }
    if (b.theme === 'rain' && THEME_RES.photo.test(b.text) && !THEME_RES.rain.test(b.text.replace(/写真|フォト|撮っ|撮影/g, ''))) {
      // keep rain text if rain keywords remain without photo — else template
      actions.push('normalize_rain_bullet')
      return {
        ...b,
        text:
          b.evidence_count >= 2
            ? '雨天でも楽しめたという体験談があります。'
            : '雨天の体験に触れた投稿があります。',
      }
    }
    return b
  })

  if (sourceCount < 10) {
    bullets = bullets.filter((b) => {
      if (stillHasStrongPhrase(b.text)) {
        actions.push('drop_strong_phrase_bullet')
        return false
      }
      return true
    })
  }

  // Ensure enjoyment appears when experience posts support it
  if (!bullets.some((b) => b.theme === 'enjoyment')) {
    const expJoy = experienceEvidence(themeEvidence, 'enjoyment')
    if (expJoy >= 2) {
      bullets.push({
        text:
          sourceCount < 10
            ? 'イベントを楽しんだという声が複数見られます。'
            : 'イベントを楽しめたという傾向が見られます。',
        theme: 'enjoyment',
        evidence_count: expJoy,
      })
      actions.push('inject_enjoyment_bullet')
    } else if (expJoy === 1) {
      bullets.push({
        text: 'イベントを楽しめたという投稿があります。',
        theme: 'enjoyment',
        evidence_count: 1,
      })
      actions.push('inject_enjoyment_bullet_single')
    }
  }

  // Inject clean rain / photo bullets when experience evidence exists but AI text was dropped
  if (!bullets.some((b) => b.theme === 'rain')) {
    const expRain = experienceEvidence(themeEvidence, 'rain')
    if (expRain >= 2) {
      const pol = derivePolarityFromSources(payload.sources, 'rain')
      bullets.push({
        text:
          pol === 'negative'
            ? '雨天の影響に触れた投稿が複数見られます。'
            : '雨天でも楽しめたという体験談があります。',
        theme: 'rain',
        evidence_count: expRain,
      })
      actions.push('inject_rain_bullet')
    }
  }
  if (!bullets.some((b) => b.theme === 'photo')) {
    const expPhoto = experienceEvidence(themeEvidence, 'photo')
    if (expPhoto >= 2) {
      bullets.push({
        text: '写真撮影を楽しんだという声が複数見られます。',
        theme: 'photo',
        evidence_count: expPhoto,
      })
      actions.push('inject_photo_bullet')
    } else if (expPhoto === 1) {
      bullets.push({
        text: '写真撮影を楽しんだという投稿があります。',
        theme: 'photo',
        evidence_count: 1,
      })
      actions.push('inject_photo_bullet_single')
    }
  }

  // 1 theme × 1 bullet, priority order, max 5
  bullets = selectByThemePriority(bullets, actions)

  // Near-duplicate text cleanup within selection
  const textsSeen: Set<string>[] = []
  const deduped: ParsedBullet[] = []
  for (const b of bullets) {
    const grams = bigramSet(normalizeForDedupe(b.text))
    if (textsSeen.some((prev) => jaccard(prev, grams) >= 0.48)) {
      actions.push('dedupe_bullets')
      continue
    }
    textsSeen.push(grams)
    deduped.push(b)
  }
  bullets = deduped.slice(0, 5)

  if (bullets.length === 0) {
    bullets = [
      {
        text: LOW_SOURCE_NOTE,
        theme: 'other',
        evidence_count: 0,
      },
    ]
    actions.push('fallback_low_source_note')
  }

  const polarity = (v: unknown): ReactionSignalPolarity => {
    const s = String(v ?? 'unknown')
    const allowed = [
      'positive',
      'negative',
      'mixed',
      'neutral',
      'unknown',
    ] as const
    return (allowed as readonly string[]).includes(s)
      ? (s as ReactionSignalPolarity)
      : 'unknown'
  }

  const sigRaw =
    obj.signals && typeof obj.signals === 'object' && !Array.isArray(obj.signals)
      ? (obj.signals as Record<string, unknown>)
      : {}

  let signals: ReactionSummaryAiJson['signals'] = {
    crowd: polarity(sigRaw.crowd),
    family: polarity(sigRaw.family),
    date: polarity(sigRaw.date),
    solo: polarity(sigRaw.solo),
    photo: polarity(sigRaw.photo),
    rain: polarity(sigRaw.rain),
    wait_time: polarity(sigRaw.wait_time),
  }

  signals = alignSignals({
    aiSignals: signals,
    themeEvidence,
    keptBullets: bullets,
    sources: payload.sources,
    actions,
  })

  let recommended: string | null = null
  if (typeof obj.recommended_time === 'string' && obj.recommended_time.trim()) {
    recommended = obj.recommended_time.trim().slice(0, 40)
  }
  const recExp = experienceEvidence(themeEvidence, 'recommended_time')
  const aiRecEv = Number(
    (obj as { recommended_time_evidence_count?: unknown })
      .recommended_time_evidence_count ?? NaN,
  )
  const recEv = Math.min(
    recExp,
    Number.isFinite(aiRecEv) ? aiRecEv : recExp,
  )
  if (recommended && recEv < 2) {
    recommended = null
    actions.push('recommended_time_cleared')
  }
  // Drop recommended_time bullets if we cleared recommended_time and thin evidence
  if (recEv < 2) {
    const before = bullets.length
    bullets = bullets.filter((b) => b.theme !== 'recommended_time')
    if (bullets.length < before) actions.push('drop_recommended_time_bullet')
  }

  let confidence: ReactionConfidence = 'low'
  if (
    obj.confidence === 'high' ||
    obj.confidence === 'medium' ||
    obj.confidence === 'low'
  ) {
    confidence = obj.confidence
  }
  const capped = applyConfidenceCap(confidence, {
    sourceCount,
    experienceCount,
  })
  if (capped !== confidence) {
    actions.push(`confidence_capped_${confidence}_to_${capped}`)
  }
  confidence = capped

  const bullets_debug: BulletDebug[] = bullets.map((b) => ({
    text: b.text,
    theme: b.theme,
    evidence_count: b.evidence_count,
  }))

  return {
    output: {
      summary_bullets: bullets.map((b) => b.text),
      signals,
      recommended_time: recommended,
      confidence,
    },
    guard: {
      sourceCount,
      experienceCount,
      actions: [...new Set(actions)],
      bullets_debug,
    },
  }
}
