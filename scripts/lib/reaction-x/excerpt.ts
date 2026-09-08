/** Internal-only excerpt from X post text (never for public display). */
const EXCERPT_MAX = 320

export function buildInternalExcerpt(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= EXCERPT_MAX) return cleaned
  return `${cleaned.slice(0, EXCERPT_MAX - 1)}…`
}

export function previewExcerpt(text: string, max = 40): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= max) return cleaned
  return `${cleaned.slice(0, max)}…`
}
