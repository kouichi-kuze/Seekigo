/**
 * Minimal robots.txt check (User-agent: * / SeekigoFetch).
 * Fail-open only when robots.txt is missing/unreadable after a safe fetch attempt;
 * fail-closed when Disallow clearly matches.
 */
import { assertSafeFetchUrl } from './url-safety'

export const REACTION_WEB_USER_AGENT =
  'SeekigoFetch/0.1 (+https://seekigo.com; reaction-source research; respects robots.txt)'

type RobotsRules = {
  disallow: string[]
  allow: string[]
}

const cache = new Map<string, RobotsRules | null>()

function parseRobots(text: string): RobotsRules {
  const lines = text.split(/\r?\n/)
  const groups: Array<{ agents: string[]; disallow: string[]; allow: string[] }> = []
  let current: { agents: string[]; disallow: string[]; allow: string[] } | null = null

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()

    if (key === 'user-agent') {
      const agent = value.toLowerCase()
      if (!current || current.disallow.length || current.allow.length) {
        current = { agents: [agent], disallow: [], allow: [] }
        groups.push(current)
      } else {
        current.agents.push(agent)
      }
      continue
    }
    if (!current) continue
    if (key === 'disallow') current.disallow.push(value)
    if (key === 'allow') current.allow.push(value)
  }

  const ua = REACTION_WEB_USER_AGENT.toLowerCase()
  const matched =
    groups.find((g) => g.agents.some((a) => a !== '*' && ua.includes(a))) ??
    groups.find((g) => g.agents.includes('*'))

  return {
    disallow: matched?.disallow ?? [],
    allow: matched?.allow ?? [],
  }
}

function pathAllowed(pathname: string, rules: RobotsRules): boolean {
  const path = pathname || '/'
  let bestAllow = -1
  let bestDisallow = -1

  for (const a of rules.allow) {
    if (!a) continue
    if (path.startsWith(a)) bestAllow = Math.max(bestAllow, a.length)
  }
  for (const d of rules.disallow) {
    if (d === '') continue // empty Disallow = allow all
    if (path.startsWith(d)) bestDisallow = Math.max(bestDisallow, d.length)
  }

  if (bestDisallow < 0) return true
  if (bestAllow > bestDisallow) return true
  return false
}

async function loadRobots(origin: string, fetchImpl: typeof fetch): Promise<RobotsRules | null> {
  if (cache.has(origin)) return cache.get(origin) ?? null

  const robotsUrl = `${origin}/robots.txt`
  const safe = await assertSafeFetchUrl(robotsUrl)
  if (!safe.ok) {
    cache.set(origin, null)
    return null
  }

  try {
    const res = await fetchImpl(robotsUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'user-agent': REACTION_WEB_USER_AGENT, accept: 'text/plain,*/*' },
      signal: AbortSignal.timeout(8000),
    })
    if (res.status >= 300 && res.status < 400) {
      cache.set(origin, null)
      return null
    }
    if (!res.ok) {
      cache.set(origin, null)
      return null
    }
    const text = await res.text()
    const rules = parseRobots(text)
    cache.set(origin, rules)
    return rules
  } catch {
    cache.set(origin, null)
    return null
  }
}

export async function isUrlAllowedByRobots(
  targetUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ allowed: boolean; reason: string }> {
  let u: URL
  try {
    u = new URL(targetUrl)
  } catch {
    return { allowed: false, reason: 'invalid_url' }
  }

  const rules = await loadRobots(u.origin, fetchImpl)
  if (!rules) {
    // robots 取得不可 → 保守的に許可（公開ページ想定）。ブロックは Disallow 明確時のみ。
    return { allowed: true, reason: 'robots_unavailable_fail_open' }
  }
  if (!pathAllowed(u.pathname, rules)) {
    return { allowed: false, reason: 'robots_disallow' }
  }
  return { allowed: true, reason: 'robots_allow' }
}

export function clearRobotsCache(): void {
  cache.clear()
}
