/**
 * Walkerplus カテゴリ → Seekigo CATEGORY_VALUES への決定論的マッピング。
 * anime 専用 enum は Phase 1A では追加しない。
 */
import type { CategoryValue } from './ai-enrichment'

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
const EXHIBITION_RE = /美術展|博物|展覧会|特別展|企画展/
const MUSIC_RE = /ライブ|音楽|コンサート/
const SPORTS_RE = /スポーツ/
const SEASONAL_RE = /花火|紅葉|イルミ|クリスマス|花見|季節|夏祭|ハロウィン|ライトアップ/
const MARKET_RE = /フリーマーケット|物産展/
const WORKSHOP_RE = /ワークショップ|講演|トーク/

function mapSingleWalkerplusCategory(raw: string): CategoryValue | null {
  const t = raw.trim()
  if (!t) return null

  if (EXHIBITION_RE.test(t)) return 'exhibition'
  if (ANIME_GAME_RE.test(t)) return 'exhibition'
  if (COMMERCIAL_RE.test(t)) return 'other'
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

export function inferKidsFromWalkerplusCategories(
  rawCategories: string[] | null | undefined,
): boolean | null {
  if (!rawCategories?.length) return null
  return rawCategories.some((c) => KIDS_RE.test(c)) ? true : null
}
