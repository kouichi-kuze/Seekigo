/**
 * X Post read cost estimate (PoC). Official pricing may change — verify on X docs.
 * https://docs.x.com / developer portal pricing
 */
export const X_POST_READ_COST_USD = 0.005

export function estimatePostReadCostUsd(postCount: number): {
  posts: number
  unit_usd: number
  estimated_usd: number
  estimated_display: string
} {
  const posts = Math.max(0, Math.floor(postCount))
  const estimated = posts * X_POST_READ_COST_USD
  return {
    posts,
    unit_usd: X_POST_READ_COST_USD,
    estimated_usd: estimated,
    estimated_display: `$${estimated.toFixed(3)}`,
  }
}
