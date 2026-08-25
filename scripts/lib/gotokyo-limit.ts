/** GOTOKYO_LIMIT を解釈する。デフォルト・上限は当面 10 件。 */
export function getGotokyoLimit(): number {
  const DEFAULT_LIMIT = 10
  const HARD_MAX = 10
  const raw = process.env.GOTOKYO_LIMIT?.trim()
  if (!raw) return DEFAULT_LIMIT

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_LIMIT
  }

  return Math.min(parsed, HARD_MAX)
}
