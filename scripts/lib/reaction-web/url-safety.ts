/**
 * URL validation + SSRF guards for reaction web collector.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
])

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map((p) => Number(p))
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null
  }
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
}

function isPrivateOrReservedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip)
  if (n == null) return true
  // 0.0.0.0/8
  if (n >= 0x00000000 && n <= 0x00ffffff) return true
  // 10.0.0.0/8
  if (n >= 0x0a000000 && n <= 0x0affffff) return true
  // 127.0.0.0/8
  if (n >= 0x7f000000 && n <= 0x7fffffff) return true
  // 169.254.0.0/16 link-local + metadata
  if (n >= 0xa9fe0000 && n <= 0xa9feffff) return true
  // 172.16.0.0/12
  if (n >= 0xac100000 && n <= 0xac1fffff) return true
  // 192.168.0.0/16
  if (n >= 0xc0a80000 && n <= 0xc0a8ffff) return true
  // 100.64.0.0/10 CGNAT
  if (n >= 0x64400000 && n <= 0x647fffff) return true
  // 192.0.0.0/24, 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 docs
  if (n >= 0xc0000000 && n <= 0xc00000ff) return true
  if (n >= 0xc0000200 && n <= 0xc00002ff) return true
  if (n >= 0xc6336400 && n <= 0xc63364ff) return true
  if (n >= 0xcb007100 && n <= 0xcb0071ff) return true
  // 224.0.0.0/4 multicast, 240.0.0.0/4
  if (n >= 0xe0000000) return true
  return false
}

function isPrivateOrReservedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '::1' || lower === '::') return true
  // Unique local fc00::/7, link-local fe80::/10
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true
  if (/^fe[89ab]/.test(lower)) return true
  // IPv4-mapped
  if (lower.includes('.')) {
    const mapped = lower.split(':').pop()
    if (mapped && isIP(mapped) === 4) return isPrivateOrReservedIpv4(mapped)
  }
  return false
}

export function isBlockedIpAddress(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) return isPrivateOrReservedIpv4(ip)
  if (v === 6) return isPrivateOrReservedIpv6(ip)
  return true
}

export type UrlSafetyResult =
  | { ok: true; url: URL }
  | { ok: false; reason: string }

export function validatePublicHttpUrl(raw: string): UrlSafetyResult {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, reason: 'empty_url' }

  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'invalid_url' }
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: 'scheme_not_http(s)' }
  }
  if (u.username || u.password) {
    return { ok: false, reason: 'userinfo_not_allowed' }
  }

  const host = u.hostname.toLowerCase()
  if (!host) return { ok: false, reason: 'missing_host' }
  if (BLOCKED_HOSTNAMES.has(host)) {
    return { ok: false, reason: 'blocked_hostname' }
  }
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    return { ok: false, reason: 'blocked_hostname_tld' }
  }

  if (isIP(host)) {
    if (isBlockedIpAddress(host)) {
      return { ok: false, reason: 'blocked_literal_ip' }
    }
  }

  return { ok: true, url: u }
}

/** Resolve hostname and reject private/reserved A/AAAA. */
export async function assertResolvesToPublicIp(hostname: string): Promise<UrlSafetyResult> {
  const host = hostname.toLowerCase()
  if (isIP(host)) {
    if (isBlockedIpAddress(host)) return { ok: false, reason: 'blocked_literal_ip' }
    return { ok: true, url: new URL(`https://${host}/`) }
  }

  try {
    const records = await lookup(host, { all: true, verbatim: true })
    if (!records.length) return { ok: false, reason: 'dns_empty' }
    for (const r of records) {
      if (isBlockedIpAddress(r.address)) {
        return { ok: false, reason: `blocked_resolved_ip:${r.address}` }
      }
    }
  } catch {
    return { ok: false, reason: 'dns_lookup_failed' }
  }

  return { ok: true, url: new URL(`https://${host}/`) }
}

export async function assertSafeFetchUrl(raw: string): Promise<UrlSafetyResult> {
  const basic = validatePublicHttpUrl(raw)
  if (!basic.ok) return basic
  const dns = await assertResolvesToPublicIp(basic.url.hostname)
  if (!dns.ok) return dns
  return basic
}
