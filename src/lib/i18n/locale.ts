/** Public site locale for event pages */
export type SiteLocale = 'ja' | 'en'

export function isSiteLocale(value: unknown): value is SiteLocale {
  return value === 'ja' || value === 'en'
}

/** Normalize slug segment (no leading/trailing slashes). */
export function normalizeEventSlug(slug: string): string {
  return slug.trim().replace(/^\/+|\/+$/g, '')
}

/**
 * Localized public event detail path.
 * JA: /tokyo/event/[slug]/
 * EN: /en/tokyo/event/[slug]/
 */
export function getLocalizedEventPath(
  slug: string,
  locale: SiteLocale,
): string {
  const s = normalizeEventSlug(slug)
  if (!s) return locale === 'en' ? '/en/tokyo/' : '/tokyo/'
  return locale === 'en'
    ? `/en/tokyo/event/${s}/`
    : `/tokyo/event/${s}/`
}

export type EventLanguageSwitcherInput = {
  slug: string | null | undefined
  /** When false, hide switcher (future: EN page not generated). Default true. */
  enPageAvailable?: boolean
  jaPageAvailable?: boolean
}

/**
 * Whether to show JP|EN switcher on an event detail page.
 * Today EN pages are generated for all published events (4C-5), so default true.
 */
export function shouldShowEventLanguageSwitcher(
  input: EventLanguageSwitcherInput,
): boolean {
  const slug = input.slug?.trim()
  if (!slug) return false
  if (input.jaPageAvailable === false) return false
  if (input.enPageAvailable === false) return false
  return true
}

export function getEventLanguageSwitcherLinks(
  slug: string,
  currentLocale: SiteLocale,
): {
  jaHref: string
  enHref: string
  currentLocale: SiteLocale
} {
  return {
    jaHref: getLocalizedEventPath(slug, 'ja'),
    enHref: getLocalizedEventPath(slug, 'en'),
    currentLocale,
  }
}
