/**
 * X API v2 Recent Search client (Bearer only, server-side).
 * Never log the bearer token or sensitive headers.
 */
import type { XPost } from './types'

const ENDPOINT = 'https://api.x.com/2/tweets/search/recent'
const TIMEOUT_MS = 20_000

export type XSearchOk = {
  ok: true
  status: number
  posts: XPost[]
  resultCount: number
  metaResultCount: number
  nextToken: string | null
}

export type XSearchErr = {
  ok: false
  status: number | null
  reason: string
}

export type XSearchResult = XSearchOk | XSearchErr

type ApiTweet = {
  id: string
  text?: string
  created_at?: string
  lang?: string
  author_id?: string
  entities?: { urls?: Array<{ expanded_url?: string; display_url?: string }> }
}

type ApiUser = { id: string; username?: string }

function mapPosts(
  tweets: ApiTweet[],
  usersById: Map<string, ApiUser>,
): XPost[] {
  return tweets.map((t) => {
    const urls = (t.entities?.urls ?? [])
      .map((u) => u.expanded_url || u.display_url || '')
      .filter(Boolean)
    const user = t.author_id ? usersById.get(t.author_id) : undefined
    return {
      id: t.id,
      text: String(t.text ?? ''),
      created_at: t.created_at ?? null,
      lang: t.lang ?? null,
      author_id: t.author_id ?? null,
      username: user?.username ?? null,
      urls,
    }
  })
}

function safeApiErrorMessage(status: number, bodyText: string): string {
  let title = ''
  try {
    const j = JSON.parse(bodyText) as {
      title?: string
      detail?: string
      errors?: Array<{ message?: string }>
    }
    title = j.title || j.detail || j.errors?.[0]?.message || ''
  } catch {
    title = ''
  }
  const short = title.replace(/\s+/g, ' ').trim().slice(0, 120)
  if (status === 401) return `unauthorized${short ? `:${short}` : ''}`
  if (status === 403) return `forbidden${short ? `:${short}` : ''}`
  if (status === 429) return `rate_limited${short ? `:${short}` : ''}`
  if (status >= 500) return `server_error_${status}`
  return `http_${status}${short ? `:${short}` : ''}`
}

export async function searchRecentTweets(opts: {
  bearerToken: string
  query: string
  maxResults: number
  startTime: string
  nextToken?: string | null
}): Promise<XSearchResult> {
  // Recent Search: max_results typically 10–100; PoC uses 10–20
  const maxResults = Math.min(Math.max(opts.maxResults, 10), 20)
  const url = new URL(ENDPOINT)
  url.searchParams.set('query', opts.query)
  url.searchParams.set('max_results', String(maxResults))
  url.searchParams.set('start_time', opts.startTime)
  url.searchParams.set(
    'tweet.fields',
    'created_at,lang,public_metrics,author_id,entities',
  )
  url.searchParams.set('expansions', 'author_id')
  url.searchParams.set('user.fields', 'username')
  if (opts.nextToken) {
    url.searchParams.set('next_token', opts.nextToken)
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${opts.bearerToken}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    const name = e instanceof Error ? e.name : 'fetch_error'
    return { ok: false, status: null, reason: `network:${name}` }
  }

  const bodyText = await res.text()
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      reason: safeApiErrorMessage(res.status, bodyText),
    }
  }

  let json: {
    data?: ApiTweet[]
    includes?: { users?: ApiUser[] }
    meta?: { result_count?: number; next_token?: string }
  }
  try {
    json = JSON.parse(bodyText) as typeof json
  } catch {
    return { ok: false, status: res.status, reason: 'invalid_json' }
  }

  const usersById = new Map<string, ApiUser>()
  for (const u of json.includes?.users ?? []) {
    if (u.id) usersById.set(u.id, u)
  }

  const tweets = Array.isArray(json.data) ? json.data : []
  const posts = mapPosts(tweets, usersById)
  const metaResultCount = Number(json.meta?.result_count ?? posts.length)
  const nextToken = json.meta?.next_token?.trim() || null

  return {
    ok: true,
    status: res.status,
    posts,
    resultCount: posts.length,
    metaResultCount,
    nextToken,
  }
}

export function xPostUrl(postId: string): string {
  return `https://x.com/i/web/status/${postId}`
}
