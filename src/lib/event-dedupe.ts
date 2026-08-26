/**
 * 複数情報源向けのイベント重複判定（ルールベース、AI不使用）。
 *
 * 優先順位:
 * 1. exact  — official_url / source_url / (正規化 title + start_date)
 * 2. likely — タイトル類似 + 日付 + 会場（+ area）
 * 3. ambiguous — タイトルのみ似ている等（自動統合しない）
 * 4. none
 *
 * 安全性: exact でも本体マージは呼び出し側で禁止すること。
 */

export type DuplicateStatus = 'exact' | 'likely' | 'none' | 'ambiguous'

/** 将来の review UI / import 向け推奨アクション */
export type DedupeRecommendedAction =
  | 'attach_source_only'
  | 'review_required'
  | 'create_draft'

export type DedupeCandidate = {
  title: string | null
  start_date: string | null
  end_date: string | null
  venue: string | null
  official_url: string | null
  source_url: string | null
  area?: string | null
}

export type DedupeExisting = DedupeCandidate & {
  slug: string
  id?: string | number | null
  status?: string | null
  /**
   * event_sources 等に紐付く追加 source_url。
   * 比較時は source_url と合わせて使う。
   */
  alternate_source_urls?: string[] | null
}

export type DuplicateMatchScores = {
  title_similarity: number
  date_overlap_ratio: number
  venue_similarity: number
  area_match?: boolean | null
}

export type DuplicateMatchResult = {
  duplicate_status: DuplicateStatus
  matched_event_slug: string | null
  matched_event_id: string | number | null
  duplicate_reason: string
  confidence: number
  matched_title?: string | null
  matched_status?: string | null
  recommended_action: DedupeRecommendedAction
  scores?: DuplicateMatchScores
  /**
   * 将来の管理画面レビュー用（schema なしでログ/JSON に載せられる構造）
   */
  review_payload?: {
    incoming: DedupeCandidate
    candidate: {
      id: string | number | null
      slug: string
      title: string | null
      status: string | null
      start_date: string | null
      end_date: string | null
      venue: string | null
      area: string | null
      official_url: string | null
      source_url: string | null
    } | null
    reason: string
    scores?: DuplicateMatchScores
  }
}

const TITLE_SIM_HIGH = 0.82
const TITLE_SIM_AMBIGUOUS = 0.72
const VENUE_SIM_HIGH = 0.75
const VENUE_SIM_AMBIGUOUS = 0.85
const DATE_OVERLAP_STRONG = 0.5

/**
 * タイトル比較用の限定的な旧字体・異体字マップ（明示的・小規模）。
 * 広い置換はしない。
 */
export const TITLE_KANJI_VARIANTS: ReadonlyArray<readonly [string, string]> = [
  ['元氣', '元気'],
  ['氣', '気'],
  ['龍神', '竜神'],
]

const TRACKING_QUERY_KEYS = new Set([
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'si',
])

function applyKanjiVariants(value: string): string {
  let s = value
  for (const [from, to] of TITLE_KANJI_VARIANTS) {
    if (s.includes(from)) s = s.split(from).join(to)
  }
  return s
}

/** 全角英数・記号を半角へ（NFKC）し、空白を正規化。タイトル用に異体字も吸収 */
export function normalizeText(value: string | null | undefined): string {
  if (!value) return ''
  return applyKanjiVariants(
    value
      .normalize('NFKC')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase(),
  )
}

/**
 * URL 比較用正規化。
 * - http/https 差を吸収（比較キーは https 固定）
 * - www. 有無を吸収
 * - 末尾スラッシュ除去
 * - fragment 無視
 * - utm_* / fbclid / gclid 等のトラッキング query のみ除去（イベント固有 query は保持）
 */
export function normalizeUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const trimmed = url.trim()
  if (!trimmed) return null
  try {
    const u = new URL(trimmed)
    u.hash = ''

    for (const key of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(key) || TRACKING_QUERY_KEYS.has(key.toLowerCase())) {
        u.searchParams.delete(key)
      }
    }

    let host = u.hostname.toLowerCase()
    if (host.startsWith('www.')) host = host.slice(4)

    let path = u.pathname.replace(/\/+$/, '')
    if (path === '') path = '/'

    const qs = u.searchParams.toString()
    // protocol 差は吸収（常に https で比較キー化）
    return `https://${host}${path}${qs ? `?${qs}` : ''}`
  } catch {
    return normalizeText(trimmed).replace(/\/+$/, '') || null
  }
}

/**
 * タイトル完全一致比較用。
 * 空白・記号を落とし、年・回数は残す。異体字は normalizeText 経由で吸収。
 */
export function normalizeTitleForExact(title: string | null | undefined): string {
  const base = normalizeText(title)
  if (!base) return ''
  return base
    .replace(/["""'']/g, '')
    .replace(/[・･·]/g, '')
    .replace(/[（）()【】\[\]「」『』〈〉<>]/g, '')
    .replace(/[!！?？:：;；,，.。\/／\\|〜~－—–_-]/g, '')
    .replace(/\s+/g, '')
}

/**
 * 類似度比較用コアタイトル。
 * 年（4桁）と「第N回」は除去して比較する。
 */
export function normalizeTitleCore(title: string | null | undefined): {
  core: string
  year: string | null
  edition: string | null
} {
  let s = normalizeText(title)
  const yearMatch = s.match(/(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)/)
  const year = yearMatch?.[1] ?? null
  const editionMatch = s.match(/第\s*(\d+)\s*回/)
  const edition = editionMatch?.[1] ?? null

  s = s
    .replace(/第\s*\d+\s*回/g, ' ')
    .replace(/(?:19|20)\d{2}/g, ' ')
    .replace(/["""'']/g, '')
    .replace(/[・･·]/g, '')
    .replace(/[（）()【】\[\]「」『』〈〉<>]/g, '')
    .replace(/[!！?？:：;；,，.。\/／\\|〜~－—–_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return { core: s.replace(/\s+/g, ''), year, edition }
}

export function normalizeVenue(venue: string | null | undefined): string {
  const base = normalizeText(venue)
  if (!base) return ''
  return base
    .replace(/[（）()【】\[\]]/g, ' ')
    .replace(
      /(周辺|付近|一帯|エリア|会場|駅前|駅周辺|jr|地下鉄|徒歩\d+分)/gi,
      ' ',
    )
    .replace(/[・･·\/／、,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+/g, '')
}

/** 文字 bigram の Dice 係数（日本語向きの簡易類似度） */
export function stringSimilarity(a: string, b: string): number {
  if (!a && !b) return 1
  if (!a || !b) return 0
  if (a === b) return 1

  const shorter = a.length <= b.length ? a : b
  const longer = a.length <= b.length ? b : a
  if (shorter.length >= 4 && longer.includes(shorter)) {
    return Math.min(1, 0.88 + (shorter.length / longer.length) * 0.12)
  }

  if (a.length < 2 || b.length < 2) {
    return a === b ? 1 : 0
  }

  const bigrams = (s: string): Map<string, number> => {
    const map = new Map<string, number>()
    const chars = [...s]
    for (let i = 0; i < chars.length - 1; i++) {
      const g = chars[i] + chars[i + 1]
      map.set(g, (map.get(g) ?? 0) + 1)
    }
    return map
  }

  const A = bigrams(a)
  const B = bigrams(b)
  let intersection = 0
  for (const [g, count] of A) {
    const other = B.get(g)
    if (other) intersection += Math.min(count, other)
  }
  const total =
    [...A.values()].reduce((s, n) => s + n, 0) +
    [...B.values()].reduce((s, n) => s + n, 0)
  return total === 0 ? 0 : (2 * intersection) / total
}

export function titleSimilarity(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const exactA = normalizeTitleForExact(a)
  const exactB = normalizeTitleForExact(b)
  if (exactA && exactA === exactB) return 1

  const coreA = normalizeTitleCore(a)
  const coreB = normalizeTitleCore(b)
  if (!coreA.core || !coreB.core) {
    return stringSimilarity(exactA, exactB)
  }

  let score = stringSimilarity(coreA.core, coreB.core)

  if (coreA.edition && coreB.edition && coreA.edition !== coreB.edition) {
    score *= 0.85
  }
  if (coreA.year && coreB.year && coreA.year !== coreB.year) {
    score *= 0.9
  }

  return Math.min(1, score)
}

export function venueSimilarity(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const na = normalizeVenue(a)
  const nb = normalizeVenue(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  return stringSimilarity(na, nb)
}

function parseYmd(value: string | null | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const t = Date.parse(`${value}T12:00:00Z`)
  return Number.isNaN(t) ? null : t
}

function daySpan(startMs: number, endMs: number): number {
  const msPerDay = 86_400_000
  return Math.max(1, Math.floor((endMs - startMs) / msPerDay) + 1)
}

/**
 * 開催期間の重なり比率（短い方の期間に対する重なり日数）。
 */
export function dateOverlapRatio(
  a: Pick<DedupeCandidate, 'start_date' | 'end_date'>,
  b: Pick<DedupeCandidate, 'start_date' | 'end_date'>,
): { ratio: number; sameStart: boolean; overlaps: boolean } {
  const aStart = parseYmd(a.start_date)
  const bStart = parseYmd(b.start_date)
  if (aStart === null || bStart === null) {
    return { ratio: 0, sameStart: false, overlaps: false }
  }

  const aEnd = parseYmd(a.end_date) ?? aStart
  const bEnd = parseYmd(b.end_date) ?? bStart
  const sameStart = a.start_date === b.start_date

  const overlapStart = Math.max(aStart, bStart)
  const overlapEnd = Math.min(aEnd, bEnd)
  if (overlapStart > overlapEnd) {
    return { ratio: 0, sameStart, overlaps: false }
  }

  const overlapDays = daySpan(overlapStart, overlapEnd)
  const shorter = Math.min(daySpan(aStart, aEnd), daySpan(bStart, bEnd))
  return {
    ratio: shorter === 0 ? 0 : overlapDays / shorter,
    sameStart,
    overlaps: true,
  }
}

export function urlsEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = normalizeUrl(a)
  const nb = normalizeUrl(b)
  return Boolean(na && nb && na === nb)
}

function areasEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean | null {
  const na = (a ?? '').trim().toLowerCase()
  const nb = (b ?? '').trim().toLowerCase()
  if (!na || !nb) return null
  return na === nb
}

function round3(n: number): number {
  return Number(n.toFixed(3))
}

function existingSourceUrls(ex: DedupeExisting): string[] {
  const urls: string[] = []
  if (ex.source_url) urls.push(ex.source_url)
  for (const u of ex.alternate_source_urls ?? []) {
    if (u) urls.push(u)
  }
  return urls
}

function scoreBundle(
  candidate: DedupeCandidate,
  ex: DedupeExisting,
  titleOverride?: number,
): DuplicateMatchScores {
  return {
    title_similarity: round3(
      titleOverride ?? titleSimilarity(candidate.title, ex.title),
    ),
    date_overlap_ratio: round3(dateOverlapRatio(candidate, ex).ratio),
    venue_similarity: round3(venueSimilarity(candidate.venue, ex.venue)),
    area_match: areasEqual(candidate.area, ex.area),
  }
}

function buildReviewPayload(
  candidate: DedupeCandidate,
  ex: DedupeExisting | null,
  reason: string,
  scores?: DuplicateMatchScores,
): DuplicateMatchResult['review_payload'] {
  return {
    incoming: {
      title: candidate.title,
      start_date: candidate.start_date,
      end_date: candidate.end_date,
      venue: candidate.venue,
      official_url: candidate.official_url,
      source_url: candidate.source_url,
      area: candidate.area ?? null,
    },
    candidate: ex
      ? {
          id: ex.id ?? null,
          slug: ex.slug,
          title: ex.title,
          status: ex.status ?? null,
          start_date: ex.start_date,
          end_date: ex.end_date,
          venue: ex.venue,
          area: ex.area ?? null,
          official_url: ex.official_url,
          source_url: ex.source_url,
        }
      : null,
    reason,
    scores,
  }
}

function resultExact(
  candidate: DedupeCandidate,
  ex: DedupeExisting,
  reason: string,
  confidence: number,
  titleOverride?: number,
): DuplicateMatchResult {
  const scores = scoreBundle(candidate, ex, titleOverride)
  return {
    duplicate_status: 'exact',
    matched_event_slug: ex.slug,
    matched_event_id: ex.id ?? null,
    matched_title: ex.title,
    matched_status: ex.status ?? null,
    duplicate_reason: reason,
    confidence,
    recommended_action: 'attach_source_only',
    scores,
    review_payload: buildReviewPayload(candidate, ex, reason, scores),
  }
}

function resultLikely(
  candidate: DedupeCandidate,
  ex: DedupeExisting,
  reason: string,
  confidence: number,
  scores: DuplicateMatchScores,
): DuplicateMatchResult {
  return {
    duplicate_status: 'likely',
    matched_event_slug: ex.slug,
    matched_event_id: ex.id ?? null,
    matched_title: ex.title,
    matched_status: ex.status ?? null,
    duplicate_reason: reason,
    confidence,
    recommended_action: 'review_required',
    scores,
    review_payload: buildReviewPayload(candidate, ex, reason, scores),
  }
}

function resultAmbiguous(
  candidate: DedupeCandidate,
  ex: DedupeExisting,
  reason: string,
  confidence: number,
  scores: DuplicateMatchScores,
): DuplicateMatchResult {
  return {
    duplicate_status: 'ambiguous',
    matched_event_slug: ex.slug,
    matched_event_id: ex.id ?? null,
    matched_title: ex.title,
    matched_status: ex.status ?? null,
    duplicate_reason: reason,
    confidence,
    recommended_action: 'review_required',
    scores,
    review_payload: buildReviewPayload(candidate, ex, reason, scores),
  }
}

function resultNone(candidate: DedupeCandidate, reason: string): DuplicateMatchResult {
  return {
    duplicate_status: 'none',
    matched_event_slug: null,
    matched_event_id: null,
    duplicate_reason: reason,
    confidence: 0,
    recommended_action: 'create_draft',
    review_payload: buildReviewPayload(candidate, null, reason),
  }
}

/**
 * sync ログ用の統一フォーマット。
 */
export function formatDedupeLog(opts: {
  status: DuplicateStatus
  incomingTitle: string | null | undefined
  match: DuplicateMatchResult
  action?: string
}): string[] {
  const { status, incomingTitle, match } = opts
  const action = opts.action ?? match.recommended_action
  const lines = [
    `[dedupe] ${status}`,
    `incoming: ${incomingTitle ?? '(no title)'}`,
  ]

  if (match.matched_event_id != null) {
    lines.push(
      status === 'exact'
        ? `matched_event_id: ${match.matched_event_id}`
        : `candidate_event_id: ${match.matched_event_id}`,
    )
  }
  if (match.matched_event_slug) {
    lines.push(`matched_event_slug: ${match.matched_event_slug}`)
  }
  if (match.matched_title) {
    lines.push(`matched_title: ${match.matched_title}`)
  }
  if (match.matched_status) {
    lines.push(`matched_status: ${match.matched_status}`)
  }
  lines.push(`reason: ${match.duplicate_reason}`)
  if (match.scores) {
    lines.push(
      `title_score: ${match.scores.title_similarity}`,
      `venue_score: ${match.scores.venue_similarity}`,
      `date_overlap: ${match.scores.date_overlap_ratio}`,
    )
    if (match.scores.area_match != null) {
      lines.push(`area_match: ${match.scores.area_match}`)
    }
  }
  lines.push(`action: ${action}`)
  return lines
}

/**
 * 候補イベント1件と既存イベント群を比較し、最良の判定を返す。
 */
export function matchAgainstExisting(
  candidate: DedupeCandidate,
  existingEvents: DedupeExisting[],
): DuplicateMatchResult {
  if (existingEvents.length === 0) {
    return resultNone(candidate, 'no existing events to compare')
  }

  // --- 1. exact: official_url ---
  for (const ex of existingEvents) {
    if (
      candidate.official_url &&
      ex.official_url &&
      urlsEqual(candidate.official_url, ex.official_url)
    ) {
      return resultExact(
        candidate,
        ex,
        'exact: official_url match',
        1,
      )
    }
  }

  // --- 1. exact: source_url（本体 + event_sources 代替） ---
  for (const ex of existingEvents) {
    if (!candidate.source_url) continue
    for (const url of existingSourceUrls(ex)) {
      if (urlsEqual(candidate.source_url, url)) {
        return resultExact(
          candidate,
          ex,
          'exact: source_url match',
          1,
        )
      }
    }
  }

  // --- 1. exact: 正規化 title + start_date（title のみでは exact にしない） ---
  const candTitleExact = normalizeTitleForExact(candidate.title)
  if (candTitleExact && candidate.start_date) {
    for (const ex of existingEvents) {
      if (!ex.start_date) continue
      if (candidate.start_date !== ex.start_date) continue
      const exTitleExact = normalizeTitleForExact(ex.title)
      if (exTitleExact && candTitleExact === exTitleExact) {
        return resultExact(
          candidate,
          ex,
          'exact: normalized_title + start_date',
          0.98,
          1,
        )
      }
    }
  }

  type Scored = {
    ex: DedupeExisting
    titleSim: number
    venueSim: number
    date: ReturnType<typeof dateOverlapRatio>
    dateStrong: boolean
    venueStrong: boolean
    titleStrong: boolean
    areaMatch: boolean | null
  }

  const scored: Scored[] = existingEvents.map((ex) => {
    const titleSim = titleSimilarity(candidate.title, ex.title)
    const venueSim = venueSimilarity(candidate.venue, ex.venue)
    const date = dateOverlapRatio(candidate, ex)
    const dateStrong =
      date.sameStart || (date.overlaps && date.ratio >= DATE_OVERLAP_STRONG)
    return {
      ex,
      titleSim,
      venueSim,
      date,
      dateStrong,
      venueStrong: venueSim >= VENUE_SIM_HIGH,
      titleStrong: titleSim >= TITLE_SIM_HIGH,
      areaMatch: areasEqual(candidate.area, ex.area),
    }
  })

  // --- 2. likely: title + date + venue（area 一致は加点） ---
  const likely = scored
    .filter((s) => s.titleStrong && s.dateStrong && s.venueStrong)
    .sort((a, b) => {
      const score = (x: Scored) =>
        x.titleSim * 0.4 +
        x.date.ratio * 0.28 +
        x.venueSim * 0.22 +
        (x.areaMatch === true ? 0.1 : 0)
      return score(b) - score(a)
    })

  if (likely.length > 0) {
    const best = likely[0]
    const confidence = Math.min(
      0.95,
      0.55 +
        best.titleSim * 0.2 +
        best.date.ratio * 0.12 +
        best.venueSim * 0.1 +
        (best.areaMatch === true ? 0.03 : 0),
    )
    const scores: DuplicateMatchScores = {
      title_similarity: Number(best.titleSim.toFixed(3)),
      date_overlap_ratio: Number(best.date.ratio.toFixed(3)),
      venue_similarity: Number(best.venueSim.toFixed(3)),
      area_match: best.areaMatch,
    }
    return resultLikely(
      candidate,
      best.ex,
      `likely: high title similarity (${best.titleSim.toFixed(2)})` +
        ` + date overlap (${best.date.ratio.toFixed(2)}; sameStart=${best.date.sameStart})` +
        ` + venue similarity (${best.venueSim.toFixed(2)})` +
        (best.areaMatch === true ? ' + area match' : ''),
      Number(confidence.toFixed(3)),
      scores,
    )
  }

  // title + date 強い + venue 欠落/中程度 → likely（両方あり低類似は ambiguous）
  const likelyRelaxed = scored
    .filter(
      (s) =>
        s.titleStrong &&
        s.dateStrong &&
        (!candidate.venue || !s.ex.venue || s.venueSim >= 0.55),
    )
    .sort((a, b) => b.titleSim - a.titleSim || b.date.ratio - a.date.ratio)

  if (likelyRelaxed.length > 0) {
    const best = likelyRelaxed[0]
    if (!(candidate.venue && best.ex.venue && best.venueSim < 0.55)) {
      const venueNote =
        !candidate.venue || !best.ex.venue
          ? 'venue missing on one side'
          : `venue similarity (${best.venueSim.toFixed(2)})`
      const scores: DuplicateMatchScores = {
        title_similarity: Number(best.titleSim.toFixed(3)),
        date_overlap_ratio: Number(best.date.ratio.toFixed(3)),
        venue_similarity: Number(best.venueSim.toFixed(3)),
        area_match: best.areaMatch,
      }
      return resultLikely(
        candidate,
        best.ex,
        `likely: high title similarity (${best.titleSim.toFixed(2)})` +
          ` + date overlap (${best.date.ratio.toFixed(2)})` +
          ` + ${venueNote}` +
          (best.areaMatch === true ? ' + area match' : ''),
        Number(
          Math.min(
            0.9,
            0.5 + best.titleSim * 0.25 + best.date.ratio * 0.1,
          ).toFixed(3),
        ),
        scores,
      )
    }
  }

  // --- 3. ambiguous ---
  const titleOnly = scored
    .filter((s) => s.titleSim >= TITLE_SIM_AMBIGUOUS)
    .sort((a, b) => b.titleSim - a.titleSim)

  const venueOnly = scored
    .filter(
      (s) => s.venueSim >= VENUE_SIM_AMBIGUOUS && s.titleSim < TITLE_SIM_HIGH,
    )
    .sort((a, b) => b.venueSim - a.venueSim)

  const titleAndDateNoVenue = scored
    .filter(
      (s) =>
        s.titleStrong &&
        s.dateStrong &&
        candidate.venue &&
        s.ex.venue &&
        s.venueSim < 0.55,
    )
    .sort((a, b) => b.titleSim - a.titleSim)

  if (titleAndDateNoVenue.length > 0) {
    const best = titleAndDateNoVenue[0]
    const scores: DuplicateMatchScores = {
      title_similarity: Number(best.titleSim.toFixed(3)),
      date_overlap_ratio: Number(best.date.ratio.toFixed(3)),
      venue_similarity: Number(best.venueSim.toFixed(3)),
      area_match: best.areaMatch,
    }
    return resultAmbiguous(
      candidate,
      best.ex,
      `ambiguous: title + date match but venues differ` +
        ` (title=${best.titleSim.toFixed(2)}, venue=${best.venueSim.toFixed(2)})`,
      Number((0.45 + best.titleSim * 0.2).toFixed(3)),
      scores,
    )
  }

  if (titleOnly.length > 0 && !titleOnly[0].dateStrong) {
    const best = titleOnly[0]
    const scores: DuplicateMatchScores = {
      title_similarity: Number(best.titleSim.toFixed(3)),
      date_overlap_ratio: Number(best.date.ratio.toFixed(3)),
      venue_similarity: Number(best.venueSim.toFixed(3)),
      area_match: best.areaMatch,
    }
    return resultAmbiguous(
      candidate,
      best.ex,
      `ambiguous: title similar only (${best.titleSim.toFixed(2)}); dates/venue not strong`,
      Number((0.35 + best.titleSim * 0.2).toFixed(3)),
      scores,
    )
  }

  if (venueOnly.length > 0) {
    const best = venueOnly[0]
    const scores: DuplicateMatchScores = {
      title_similarity: Number(best.titleSim.toFixed(3)),
      date_overlap_ratio: Number(best.date.ratio.toFixed(3)),
      venue_similarity: Number(best.venueSim.toFixed(3)),
      area_match: best.areaMatch,
    }
    return resultAmbiguous(
      candidate,
      best.ex,
      `ambiguous: venue similar only (${best.venueSim.toFixed(2)})`,
      Number((0.3 + best.venueSim * 0.15).toFixed(3)),
      scores,
    )
  }

  if (titleOnly.length > 0 && titleOnly[0].dateStrong) {
    const best = titleOnly[0]
    const scores: DuplicateMatchScores = {
      title_similarity: Number(best.titleSim.toFixed(3)),
      date_overlap_ratio: Number(best.date.ratio.toFixed(3)),
      venue_similarity: Number(best.venueSim.toFixed(3)),
      area_match: best.areaMatch,
    }
    return resultAmbiguous(
      candidate,
      best.ex,
      `ambiguous: title + date related but not enough for auto-merge` +
        ` (title=${best.titleSim.toFixed(2)}, venue=${best.venueSim.toFixed(2)})`,
      Number((0.4 + best.titleSim * 0.2).toFixed(3)),
      scores,
    )
  }

  return resultNone(candidate, 'no sufficient match')
}
