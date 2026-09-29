/**
 * イベントカテゴリ → カテゴリ画像スラグ変換
 * public/images/event-categories/{slug}.webp に対応。
 * 複数枚あるカテゴリは {slug}.webp, {slug}-2.webp, {slug}-3.webp ...
 * 追加ファイルが無い番号は {slug}.webp に戻す。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const GENERIC_IMAGE_CATEGORY_SLUG = 'generic' as const

/** カテゴリ文字列 → 画像スラグ (alias 含む) */
const CATEGORY_SLUG_MAP: Record<string, string> = {
  // festival
  festival: 'festival',
  matsuri: 'festival',
  fireworks: 'festival',
  hanabi: 'festival',
  // exhibition
  exhibition: 'exhibition',
  art: 'exhibition',
  museum: 'exhibition',
  gallery: 'exhibition',
  expo: 'exhibition',
  // food
  food: 'food',
  gourmet: 'food',
  dining: 'food',
  // kids
  kids: 'kids',
  children: 'kids',
  family: 'kids',
  // nightlife
  nightlife: 'nightlife',
  night: 'nightlife',
  bar: 'nightlife',
  club: 'nightlife',
  // sports
  sports: 'sports',
  fitness: 'sports',
  run: 'sports',
  running: 'sports',
  yoga: 'sports',
  // market
  market: 'market',
  flea: 'market',
  bazaar: 'market',
  // seasonal
  seasonal: 'seasonal',
  sakura: 'seasonal',
  illumination: 'seasonal',
  nature: 'seasonal',
  // workshop
  workshop: 'workshop',
  craft: 'workshop',
  diy: 'workshop',
  // music
  music: 'music',
  concert: 'music',
  live: 'music',
  jazz: 'music',
}

/** 優先順位つきで画像スラグを1つ決定する */
const PRIORITY_ORDER: string[] = [
  'kids', 'nightlife', 'festival', 'music',
  'sports', 'workshop', 'market', 'seasonal',
  'exhibition', 'food',
]

/** string | string[] | null → string[] に正規化 */
export function normalizeCategories(
  category: string | string[] | null | undefined
): string[] {
  if (!category) return []
  return Array.isArray(category) ? category : [category]
}

/** 1カテゴリ文字列 → 画像スラグ */
export function mapCategoryToImageSlug(cat: string): string | null {
  return CATEGORY_SLUG_MAP[cat.toLowerCase().trim()] ?? null
}

/**
 * categories 配列から優先順位で1つスラグを決定。
 * マッチなければ boolean フラグで補完、それも無ければ 'generic'
 */
export function resolveImageCategorySlug(
  categories: string | string[] | null | undefined,
  flags?: {
    is_kids?: boolean
    is_night?: boolean
    is_indoor?: boolean
  }
): string {
  const cats = normalizeCategories(categories)

  // PRIORITY_ORDER に従って最初にマッチしたスラグを返す
  for (const priority of PRIORITY_ORDER) {
    for (const cat of cats) {
      if (mapCategoryToImageSlug(cat) === priority) return priority
    }
  }

  // category が未設定の場合は boolean フラグで補完
  if (flags?.is_kids) return 'kids'
  if (flags?.is_night) return 'nightlife'

  // 生の category がひとつでもマッチすれば返す
  for (const cat of cats) {
    const slug = mapCategoryToImageSlug(cat)
    if (slug) return slug
  }

  return GENERIC_IMAGE_CATEGORY_SLUG
}

/**
 * 代替画像の枚数。未記載のカテゴリと generic は 1 枚。
 * 0 は {slug}.webp、1 は {slug}-2.webp、2 は {slug}-3.webp。
 */
export const CATEGORY_IMAGE_VARIANT_COUNTS: Record<string, number> = {
  festival: 5,
  exhibition: 5,
  kids: 5,
  workshop: 4,
}

const categoryImageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../public/images/event-categories',
)

/** event.id から 0 以上 variantCount 未満の番号。id が取れなければ 0。 */
export function categoryImageVariantIndex(
  eventId: number | string | null | undefined,
  variantCount: number,
): number {
  if (variantCount <= 1) return 0
  const id = typeof eventId === 'number' ? eventId : Number(eventId)
  if (!Number.isFinite(id)) return 0
  const index = Math.trunc(Math.abs(id)) % variantCount
  return index
}

function categoryImageFileName(slug: string, index: number): string {
  if (index <= 0) return `${slug}.webp`
  return `${slug}-${index + 1}.webp`
}

/** スラグ → public/ の画像パス。無ければ {slug}.webp。 */
export function getCategoryImagePath(
  slug: string,
  eventId?: number | string | null,
): string {
  const count = CATEGORY_IMAGE_VARIANT_COUNTS[slug] ?? 1
  const index = categoryImageVariantIndex(eventId, count)
  const base = `/images/event-categories/${slug}.webp`
  if (index <= 0) return base
  const fileName = categoryImageFileName(slug, index)
  if (!existsSync(path.join(categoryImageDir, fileName))) return base
  return `/images/event-categories/${fileName}`
}
