/**
 * Walkerplus カテゴリ → Seekigo CATEGORY_VALUES への決定論的マッピング。
 * anime 専用 enum は Phase 1A では追加しない。
 */
import type { CategoryValue } from './ai-enrichment'
import { inferKidsFromAudienceText } from './kids-inference'

export type WalkerplusCategoryMapping = {
  mapped: CategoryValue[]
  raw: string[]
}

const ANIME_GAME_RE = /アニメ・ゲーム|アニメ|ゲーム/
const COMMERCIAL_RE = /商業施設/
const EXPERIENCE_RE = /体験イベント|アクティビティ|体験型/
const FESTIVAL_RE = /^祭り$|フェスティバル|パレード/
const FOOD_RE = /グルメ|フード|物産|ビアガーデン|グルメ・フード/
const KIDS_RE = /子供|子ども|キッズ|ファミリー|親子/
const EXHIBITION_RE = /美術展|博物|展覧会|特別展|企画展|展示会/
const MUSIC_RE = /ライブ|音楽|コンサート/
const SPORTS_RE = /スポーツ/
const SEASONAL_RE = /花火|紅葉|イルミ|クリスマス|花見|季節|夏祭|ハロウィン|ライトアップ/
const MARKET_RE = /フリーマーケット|物産展/
const WORKSHOP_RE = /ワークショップ|講演|トーク/

function mapSingleWalkerplusCategory(raw: string): CategoryValue | null {
  const t = raw.trim()
  if (!t) return null
  if (isCompanionOnlyCategory(t)) return null

  if (EXHIBITION_RE.test(t)) return 'exhibition'
  if (ANIME_GAME_RE.test(t)) return 'exhibition'
  // 商業施設だけではカテゴリを足さない。他に対応が無いときだけ末尾で other になる。
  if (COMMERCIAL_RE.test(t)) return null
  if (EXPERIENCE_RE.test(t)) return 'workshop'
  if (FESTIVAL_RE.test(t)) return 'festival'
  if (FOOD_RE.test(t)) return 'food'
  if (KIDS_RE.test(t)) return 'kids'
  if (MUSIC_RE.test(t)) return 'music'
  if (SPORTS_RE.test(t)) return 'sports'
  if (SEASONAL_RE.test(t)) return 'seasonal'
  if (MARKET_RE.test(t)) return 'market'
  if (WORKSHOP_RE.test(t)) return 'workshop'

  return null
}

export function mapWalkerplusCategories(
  rawCategories: string[] | null | undefined,
): WalkerplusCategoryMapping {
  const raw = [...new Set((rawCategories ?? []).map((c) => c.trim()).filter(Boolean))]
  const mappedSet = new Set<CategoryValue>()

  for (const cat of raw) {
    const mapped = mapSingleWalkerplusCategory(cat)
    if (mapped) mappedSet.add(mapped)
  }

  if (mappedSet.size === 0) mappedSet.add('other')

  return {
    mapped: [...mappedSet],
    raw,
  }
}

const COMPANION_TOKEN =
  /^(?:子供と|子どもと|こどもと|お子様と|お子さまと|恋人と|夫婦で|友達と|友人と|一人で|両親と|家族で|仲間と)$/

/** 「誰と行く」の同行者タグ。イベントの対象者ではない。 */
function isCompanionOnlyCategory(label: string): boolean {
  const parts = label
    .split(/[/／・,、\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
  return parts.length > 0 && parts.every((part) => COMPANION_TOKEN.test(part))
}

export function inferKidsFromWalkerplusCategories(
  rawCategories: string[] | null | undefined,
  audienceText?: string | null,
): boolean | null {
  let sawExclusion = false
  for (const category of rawCategories ?? []) {
    const label = category.trim()
    if (!label || isCompanionOnlyCategory(label)) continue
    const judged = inferKidsFromAudienceText(label)
    if (judged === true) return true
    if (judged === false) sawExclusion = true
  }
  const fromText = inferKidsFromAudienceText(audienceText)
  if (fromText === true) return true
  if (sawExclusion || fromText === false) return false
  return null
}
