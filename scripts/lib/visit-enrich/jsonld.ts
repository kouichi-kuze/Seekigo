/**
 * schema.org Event / Offer / Place extraction from JSON-LD.
 */
import type { VisitFieldProposal } from './types'
import { clipEvidence } from './html-text'

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>
  }
  return null
}

function typeList(node: Record<string, unknown>): string[] {
  const t = node['@type']
  if (typeof t === 'string') return [t]
  if (Array.isArray(t)) return t.map(String)
  return []
}

function flattenNodes(nodes: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const walk = (n: unknown) => {
    const r = asRecord(n)
    if (!r) return
    if (Array.isArray(r['@graph'])) {
      for (const g of r['@graph']) walk(g)
      return
    }
    out.push(r)
  }
  for (const n of nodes) walk(n)
  return out
}

function parsePriceNumber(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.round(raw)
  }
  if (typeof raw === 'string') {
    const digits = raw.replace(/[^\d.]/g, '')
    if (!digits) return null
    const n = Number(digits)
    return Number.isFinite(n) ? Math.round(n) : null
  }
  return null
}

function offerNodes(eventNode: Record<string, unknown>): Record<string, unknown>[] {
  const offers = eventNode.offers
  if (!offers) return []
  if (Array.isArray(offers)) {
    return offers.map(asRecord).filter(Boolean) as Record<string, unknown>[]
  }
  const one = asRecord(offers)
  return one ? [one] : []
}

function locationAddress(eventNode: Record<string, unknown>): string | null {
  const loc = asRecord(eventNode.location)
  if (!loc) return null
  const addr = loc.address
  if (typeof addr === 'string' && addr.trim()) return addr.trim()
  const addrObj = asRecord(addr)
  if (!addrObj) return null
  const parts = [
    addrObj.streetAddress,
    addrObj.addressLocality,
    addrObj.addressRegion,
    addrObj.postalCode,
  ]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
  return parts.length ? parts.join(' ') : null
}

/** Extract visit proposals from JSON-LD graph */
export function extractFromJsonLd(
  nodes: unknown[],
  sourceUrl: string | null,
): VisitFieldProposal[] {
  const proposals: VisitFieldProposal[] = []
  const flat = flattenNodes(nodes)
  const events = flat.filter((n) =>
    typeList(n).some((t) => /Event/i.test(t) && !/EventSeries/i.test(t)),
  )
  const targets = events.length > 0 ? events : flat

  for (const node of targets) {
    const offers = offerNodes(node)
    const prices: number[] = []
    let freeOffer = false
    let paidOffer = false
    let offerUrl: string | null = null

    for (const offer of offers) {
      const price = parsePriceNumber(offer.price)
      const currency =
        typeof offer.priceCurrency === 'string'
          ? offer.priceCurrency.toUpperCase()
          : null
      if (currency && currency !== 'JPY' && currency !== 'YEN') continue

      if (price === 0) freeOffer = true
      if (price != null && price > 0) {
        paidOffer = true
        prices.push(price)
      }
      if (typeof offer.url === 'string' && offer.url.startsWith('http')) {
        offerUrl = offer.url.trim()
      }
      const availability = String(offer.availability ?? '')
      if (/Free/i.test(availability) && price == null) freeOffer = true
    }

    if (freeOffer && !paidOffer) {
      proposals.push({
        field: 'price_type',
        proposed_value: 'free',
        confidence: 'high',
        reason: 'JSON-LD Offer price=0 / Free',
        evidence_text: clipEvidence('Offer indicates free admission'),
        source_url: sourceUrl,
        method: 'jsonld',
      })
      proposals.push({
        field: 'price_min',
        proposed_value: 0,
        confidence: 'high',
        reason: 'JSON-LD free offer',
        evidence_text: 'price=0',
        source_url: sourceUrl,
        method: 'jsonld',
      })
      proposals.push({
        field: 'price_max',
        proposed_value: 0,
        confidence: 'high',
        reason: 'JSON-LD free offer',
        evidence_text: 'price=0',
        source_url: sourceUrl,
        method: 'jsonld',
      })
    } else if (prices.length > 0) {
      const min = Math.min(...prices)
      const max = Math.max(...prices)
      proposals.push({
        field: 'price_type',
        proposed_value: 'paid',
        confidence: 'high',
        reason: 'JSON-LD Offer price > 0',
        evidence_text: clipEvidence(`price ${min}${min !== max ? `-${max}` : ''}`),
        source_url: sourceUrl,
        method: 'jsonld',
      })
      proposals.push({
        field: 'price_min',
        proposed_value: min,
        confidence: 'high',
        reason: 'JSON-LD Offer.price',
        evidence_text: String(min),
        source_url: sourceUrl,
        method: 'jsonld',
      })
      proposals.push({
        field: 'price_max',
        proposed_value: max,
        confidence: 'high',
        reason: 'JSON-LD Offer.price',
        evidence_text: String(max),
        source_url: sourceUrl,
        method: 'jsonld',
      })
    }

    if (offerUrl) {
      proposals.push({
        field: 'reservation_url',
        proposed_value: offerUrl,
        confidence: 'medium',
        reason: 'JSON-LD Offer.url',
        evidence_text: clipEvidence(offerUrl),
        source_url: sourceUrl,
        method: 'jsonld',
      })
    }

    const addr = locationAddress(node)
    if (addr) {
      // address is not in visit enrich target list for overwrite; skip storing as visit field
      void addr
    }
  }

  return proposals
}
