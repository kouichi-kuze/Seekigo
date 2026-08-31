/**
 * 画像利用ポリシー（表示可否）。
 * image_url 取得 ≠ 公開表示可。
 * AI 判定はしない。人間が admin で status を付ける。
 */

import {
  GENERIC_IMAGE_CATEGORY_SLUG,
  getCategoryImagePath,
  resolveImageCategorySlug,
} from './event-category-images'

export {
  GENERIC_IMAGE_CATEGORY_SLUG,
  getCategoryImagePath,
  mapCategoryToImageSlug,
  normalizeCategories,
  resolveImageCategorySlug,
} from './event-category-images'

export const IMAGE_USAGE_STATUSES = [
  'unknown',
  'licensed',
  'organizer_granted',
  'own',
  'forbidden',
] as const

export type ImageUsageStatus = (typeof IMAGE_USAGE_STATUSES)[number]

export const DISPLAYABLE_IMAGE_USAGE_STATUSES = [
  'licensed',
  'organizer_granted',
  'own',
] as const

export type ImageSourceName =
  | 'gotokyo'
  | 'enjoytokyo'
  | 'organizer'
  | 'seekigo'
  | 'other'

export function isImageUsageStatus(value: unknown): value is ImageUsageStatus {
  return (
    typeof value === 'string' &&
    (IMAGE_USAGE_STATUSES as readonly string[]).includes(value)
  )
}

/** 公開画面・CSS に外部画像を出してよいか */
export function canDisplayEventImage(
  status: string | null | undefined,
): boolean {
  return (
    typeof status === 'string' &&
    (DISPLAYABLE_IMAGE_USAGE_STATUSES as readonly string[]).includes(status)
  )
}

/**
 * 公開用の image URL。許可ステータス以外は null。
 * unknown / forbidden / null では hotlink しない。
 */
export function resolvePublicImageUrl(event: {
  image_url?: string | null
  image_usage_status?: string | null
}): string | null {
  if (!canDisplayEventImage(event.image_usage_status)) return null
  const url = event.image_url?.trim()
  return url ? url : null
}

export type EventDisplayImage =
  | {
      kind: 'external'
      src: string
      showCredit: boolean
    }
  | {
      kind: 'category'
      src: string
      categorySlug: string
    }
  | {
      kind: 'generic'
      src: string
      categorySlug: typeof GENERIC_IMAGE_CATEGORY_SLUG
    }

/**
 * 公開画面用の表示画像を決定。
 * A. 許可ステータス + image_url → external
 * B. それ以外 → category フォールバック
 * C. カテゴリ不明 → generic
 */
export function resolveEventDisplayImage(event: {
  image_url?: string | null
  image_usage_status?: string | null
  image_credit?: string | null
  category?: string | string[] | null
}): EventDisplayImage {
  const externalUrl = resolvePublicImageUrl(event)
  if (externalUrl) {
    return {
      kind: 'external',
      src: externalUrl,
      showCredit: Boolean(event.image_credit?.trim()),
    }
  }

  const categorySlug = resolveImageCategorySlug(event.category)
  if (categorySlug === GENERIC_IMAGE_CATEGORY_SLUG) {
    return {
      kind: 'generic',
      src: getCategoryImagePath(GENERIC_IMAGE_CATEGORY_SLUG),
      categorySlug: GENERIC_IMAGE_CATEGORY_SLUG,
    }
  }

  return {
    kind: 'category',
    src: getCategoryImagePath(categorySlug),
    categorySlug,
  }
}

export function defaultImageMetaForSource(source: ImageSourceName): {
  image_usage_status: ImageUsageStatus
  image_source: ImageSourceName
  image_credit: null
} {
  return {
    image_usage_status: 'unknown',
    image_source: source,
    image_credit: null,
  }
}
