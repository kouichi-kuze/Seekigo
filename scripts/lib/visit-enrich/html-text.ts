/**
 * HTML → plain text helpers for visit-attr extraction.
 */
import * as cheerio from 'cheerio'

const SCRIPT_STYLE = 'script, style, noscript, svg, iframe'

export function extractJsonLdBlocks(html: string): unknown[] {
  const $ = cheerio.load(html)
  const out: unknown[] = []
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text().trim()
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) out.push(...parsed)
      else out.push(parsed)
    } catch {
      /* ignore invalid JSON-LD */
    }
  })
  return out
}

export function htmlToPlainText(html: string): string {
  const $ = cheerio.load(html)
  $(SCRIPT_STYLE).remove()
  const text = $('body').text() || $.root().text()
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** Keep useful access / ticket / parking snippets for AI / logging */
export function buildEvidenceExcerpts(plain: string, maxChars = 4000): string {
  const lines = plain
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 4 && l.length <= 240)

  const keywords =
    /料金|入場|チケット|無料|予約|申込|申し込み|アクセス|最寄|徒歩|駅|屋内|屋外|室内|野外|子ども|子供|ファミリー|親子|キッズ|歳|年齢|所要|駐車場|雨天|天候/
  const hit = lines.filter((l) => keywords.test(l))
  const picked = (hit.length > 0 ? hit : lines).slice(0, 80)
  let out = picked.join('\n')
  if (out.length > maxChars) out = out.slice(0, maxChars)
  return out
}

export function clipEvidence(text: string, max = 120): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return `${t.slice(0, max - 1)}…`
}
