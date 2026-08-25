/**
 * 複数情報源向けのイベント重複判定（ルールベース、AI不使用）。
 *
 * 段階:
 * 1. exact  — official_url / source_url / (正規化 title + start_date)
 * 2. likely — タイトル類似 + 日付一致or期間重なり + 会場一致or類似
 * 3. ambiguous — タイトルのみ似ている / 会場のみ同じ 等（自動統合しない）
 * 4. none
 */

export type DuplicateStatus = 'exact' | 'likely' | 'none' | 'ambiguous'

export type DedupeCandidate = {
  title: string | null
  start_date: string | null
  end_date: string | null
  venue: string | null
  official_url: string | null
  source_url: string | null
}

export type DedupeExisting = DedupeCandidate & {
  slug: string
  id?: string | null
  status?: string | null
}

export type DuplicateMatchResult = {
  duplicate_status: DuplicateStatus
  matched_event_slug: string | null
  duplicate_reason: string
  confidence: number
  matched_title?: string | null
  scores?: {
    title_similarity: number
    date_overlap_ratio: number
    venue_similarity: number
  }
}

const TITLE_SIM_HIGH = 0.82
const TITLE_SIM_AMBIGUOUS = 0.72
const VENUE_SIM_HIGH = 0.75
const VENUE_SIM_AMBIGUOUS = 0.85
const DATE_OVERLAP_STRONG = 0.5

/** 全角英数・記号を半角へ（NFKC）し、空白を正規化 */
export function normalizeText(value: string | null | undefined): string {
  if (!value) return ''
  return value
    .normalize('NFKC')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** URL 比較用（末尾スラッシュ・トラッキング除去） */
export function normalizeUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const trimmed = url.trim()
  if (!trimmed) return null
  try {
    const u = new URL(trimmed)
    u.hash = ''
    for (const key of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(key) || key === 'fbclid' || key === 'gclid') {
        u.searchParams.delete(key)
      }
    }
    let path = u.pathname.replace(/\/+$/, '')
    if (path === '') path = '/'
    const qs = u.searchParams.toString()
    return `${u.protocol}//${u.host.toLowerCase()}${path}${qs ? `?${qs}` : ''}`
  } catch {
    return normalizeText(trimmed).replace(/\/+$/, '') || null
  }
}

/**
 * タイトル完全一致比較用。
 * 空白・記号を落とし、年・回数は残す（「2026」付き同士の一致を優先）。
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
 * 年（4桁）と「第N回」は別フィールドでも扱えるよう除去して比較する。
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

  // 短い側が長い側に含まれる場合は高めに評価
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
  const total = [...A.values()].reduce((s, n) => s + n, 0) +
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

  // 回数が両方あり不一致なら減点
  if (coreA.edition && coreB.edition && coreA.edition !== coreB.edition) {
    score *= 0.85
  }
  // 年が両方あり不一致なら減点
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
 * 日付が欠ける場合は 0。start のみなら1日イベントとして扱う。
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

function urlsEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = normalizeUrl(a)
  const nb = normalizeUrl(b)
  return Boolean(na && nb && na === nb)
}

function round3(n: number): number {
  return Number(n.toFixed(3))
}

function scoreBundle(
  candidate: DedupeCandidate,
  ex: DedupeExisting,
  titleOverride?: number,
): DuplicateMatchResult['scores'] {
  return {
    title_similarity: round3(
      titleOverride ?? titleSimilarity(candidate.title, ex.title),
    ),
    date_overlap_ratio: round3(dateOverlapRatio(candidate, ex).ratio),
    venue_similarity: round3(venueSimilarity(candidate.venue, ex.venue)),
  }
}

/**
 * 候補イベント1件と既存イベント群を比較し、最良の判定を返す。
 */
export function matchAgainstExisting(
  candidate: DedupeCandidate,
  existingEvents: DedupeExisting[],
): DuplicateMatchResult {
  if (existingEvents.length === 0) {
    return {
      duplicate_status: 'none',
      matched_event_slug: null,
      duplicate_reason: 'no existing events to compare',
      confidence: 0,
    }
  }

  // --- 1. exact: URL ---
  for (const ex of existingEvents) {
    if (
      candidate.official_url &&
      ex.official_url &&
      urlsEqual(candidate.official_url, ex.official_url)
    ) {
      return {
        duplicate_status: 'exact',
        matched_event_slug: ex.slug,
        matched_title: ex.title,
        duplicate_reason: 'exact: official_url match',
        confidence: 1,
        scores: scoreBundle(candidate, ex),
      }
    }
  }

  for (const ex of existingEvents) {
    if (
      candidate.source_url &&
      ex.source_url &&
      urlsEqual(candidate.source_url, ex.source_url)
    ) {
      return {
        duplicate_status: 'exact',
        matched_event_slug: ex.slug,
        matched_title: ex.title,
        duplicate_reason: 'exact: source_url match',
        confidence: 1,
        scores: scoreBundle(candidate, ex),
      }
    }
  }

  // --- 1. exact: 正規化 title + start_date ---
  const candTitleExact = normalizeTitleForExact(candidate.title)
  if (candTitleExact && candidate.start_date) {
    for (const ex of existingEvents) {
      if (!ex.start_date) continue
      if (candidate.start_date !== ex.start_date) continue
      const exTitleExact = normalizeTitleForExact(ex.title)
      if (exTitleExact && candTitleExact === exTitleExact) {
        return {
          duplicate_status: 'exact',
          matched_event_slug: ex.slug,
          matched_title: ex.title,
          duplicate_reason: 'exact: normalized title + start_date match',
          confidence: 0.98,
          scores: scoreBundle(candidate, ex, 1),
        }
      }
    }
  }

  // スコア付きで全件評価（likely / ambiguous）
  type Scored = {
    ex: DedupeExisting
    titleSim: number
    venueSim: number
    date: ReturnType<typeof dateOverlapRatio>
    dateStrong: boolean
    venueStrong: boolean
    titleStrong: boolean
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
    }
  })

  // --- 2. strong / likely: title + date + venue ---
  const likely = scored
    .filter((s) => s.titleStrong && s.dateStrong && s.venueStrong)
    .sort((a, b) => {
      const score = (x: Scored) =>
        x.titleSim * 0.45 + x.date.ratio * 0.3 + x.venueSim * 0.25
      return score(b) - score(a)
    })

  if (likely.length > 0) {
    const best = likely[0]
    const confidence = Math.min(
      0.95,
      0.55 +
        best.titleSim * 0.2 +
        best.date.ratio * 0.12 +
        best.venueSim * 0.1,
    )
    return {
      duplicate_status: 'likely',
      matched_event_slug: best.ex.slug,
      matched_title: best.ex.title,
      duplicate_reason:
        `likely: high title similarity (${best.titleSim.toFixed(2)})` +
        ` + date overlap (${best.date.ratio.toFixed(2)}; sameStart=${best.date.sameStart})` +
        ` + venue similarity (${best.venueSim.toFixed(2)})`,
      confidence: Number(confidence.toFixed(3)),
      scores: {
        title_similarity: Number(best.titleSim.toFixed(3)),
        date_overlap_ratio: Number(best.date.ratio.toFixed(3)),
        venue_similarity: Number(best.venueSim.toFixed(3)),
      },
    }
  }

  // title コア一致 + 日付強い + venue 欠落でも likely 寄り（会場未取得への緩和）
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
    // venue 両方ありで類似が低いなら ambiguous 扱いへ回す
    if (
      candidate.venue &&
      best.ex.venue &&
      best.venueSim < 0.55
    ) {
      // fall through
    } else {
      const venueNote =
        !candidate.venue || !best.ex.venue
          ? 'venue missing on one side'
          : `venue similarity (${best.venueSim.toFixed(2)})`
      return {
        duplicate_status: 'likely',
        matched_event_slug: best.ex.slug,
        matched_title: best.ex.title,
        duplicate_reason:
          `likely: high title similarity (${best.titleSim.toFixed(2)})` +
          ` + date overlap (${best.date.ratio.toFixed(2)})` +
          ` + ${venueNote}`,
        confidence: Number(
          Math.min(0.9, 0.5 + best.titleSim * 0.25 + best.date.ratio * 0.1).toFixed(
            3,
          ),
        ),
        scores: {
          title_similarity: Number(best.titleSim.toFixed(3)),
          date_overlap_ratio: Number(best.date.ratio.toFixed(3)),
          venue_similarity: Number(best.venueSim.toFixed(3)),
        },
      }
    }
  }

  // --- 3. ambiguous ---
  const titleOnly = scored
    .filter((s) => s.titleSim >= TITLE_SIM_AMBIGUOUS)
    .sort((a, b) => b.titleSim - a.titleSim)

  const venueOnly = scored
    .filter(
      (s) =>
        s.venueSim >= VENUE_SIM_AMBIGUOUS &&
        s.titleSim < TITLE_SIM_HIGH,
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
    return {
      duplicate_status: 'ambiguous',
      matched_event_slug: best.ex.slug,
      matched_title: best.ex.title,
      duplicate_reason:
        `ambiguous: title + date match but venues differ` +
        ` (title=${best.titleSim.toFixed(2)}, venue=${best.venueSim.toFixed(2)})`,
      confidence: Number((0.45 + best.titleSim * 0.2).toFixed(3)),
      scores: {
        title_similarity: Number(best.titleSim.toFixed(3)),
        date_overlap_ratio: Number(best.date.ratio.toFixed(3)),
        venue_similarity: Number(best.venueSim.toFixed(3)),
      },
    }
  }

  if (titleOnly.length > 0 && !titleOnly[0].dateStrong) {
    const best = titleOnly[0]
    return {
      duplicate_status: 'ambiguous',
      matched_event_slug: best.ex.slug,
      matched_title: best.ex.title,
      duplicate_reason: `ambiguous: title similar only (${best.titleSim.toFixed(2)}); dates/venue not strong`,
      confidence: Number((0.35 + best.titleSim * 0.2).toFixed(3)),
      scores: {
        title_similarity: Number(best.titleSim.toFixed(3)),
        date_overlap_ratio: Number(best.date.ratio.toFixed(3)),
        venue_similarity: Number(best.venueSim.toFixed(3)),
      },
    }
  }

  if (venueOnly.length > 0) {
    const best = venueOnly[0]
    return {
      duplicate_status: 'ambiguous',
      matched_event_slug: best.ex.slug,
      matched_title: best.ex.title,
      duplicate_reason: `ambiguous: venue similar only (${best.venueSim.toFixed(2)})`,
      confidence: Number((0.3 + best.venueSim * 0.15).toFixed(3)),
      scores: {
        title_similarity: Number(best.titleSim.toFixed(3)),
        date_overlap_ratio: Number(best.date.ratio.toFixed(3)),
        venue_similarity: Number(best.venueSim.toFixed(3)),
      },
    }
  }

  // title 似ていて日付も強いが上の likely に入らなかった残り
  if (titleOnly.length > 0 && titleOnly[0].dateStrong) {
    const best = titleOnly[0]
    return {
      duplicate_status: 'ambiguous',
      matched_event_slug: best.ex.slug,
      matched_title: best.ex.title,
      duplicate_reason:
        `ambiguous: title + date related but not enough for auto-merge` +
        ` (title=${best.titleSim.toFixed(2)}, venue=${best.venueSim.toFixed(2)})`,
      confidence: Number((0.4 + best.titleSim * 0.2).toFixed(3)),
      scores: {
        title_similarity: Number(best.titleSim.toFixed(3)),
        date_overlap_ratio: Number(best.date.ratio.toFixed(3)),
        venue_similarity: Number(best.venueSim.toFixed(3)),
      },
    }
  }

  return {
    duplicate_status: 'none',
    matched_event_slug: null,
    duplicate_reason: 'no sufficient match',
    confidence: 0,
  }
}
