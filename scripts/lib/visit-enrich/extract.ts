/**
 * Deterministic Japanese text extractors for visit attrs.
 * Explicit wording only — no content-name guesses.
 */
import type {
  FriendlyValue,
  ParkingStatus,
  ReservationStatus,
  VenueType,
} from '../../../src/lib/event-visit-attrs'
import type { VisitFieldProposal } from './types'
import { clipEvidence } from './html-text'

function push(
  out: VisitFieldProposal[],
  p: Omit<VisitFieldProposal, 'method'> & { method?: VisitFieldProposal['method'] },
) {
  out.push({ method: 'deterministic', ...p })
}

export function extractPriceFromText(
  text: string,
  sourceUrl: string | null,
): VisitFieldProposal[] {
  const out: VisitFieldProposal[] = []
  const freeHit = text.match(
    /(?:入場|参加|観覧)?無料|料金\s*[:：]?\s*無料|チケット\s*[:：]?\s*無料/,
  )
  const yenMatches = [
    ...text.matchAll(
      /(?:一般|大人|高校生|大学生|中学生|小学生|小人|前売|当日)?[^\d]{0,6}(\d{1,3}(?:,\d{3})+|\d{3,6})\s*円/g,
    ),
  ]
  const amounts = yenMatches
    .map((m) => Number(String(m[1]).replace(/,/g, '')))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 100_000)

  if (freeHit && amounts.length === 0) {
    push(out, {
      field: 'is_free',
      proposed_value: true,
      confidence: 'high',
      reason: '本文に無料の明示',
      evidence_text: clipEvidence(freeHit[0]),
      source_url: sourceUrl,
    })
    push(out, {
      field: 'price_min',
      proposed_value: 0,
      confidence: 'high',
      reason: '無料明示',
      evidence_text: clipEvidence(freeHit[0]),
      source_url: sourceUrl,
    })
    push(out, {
      field: 'price_max',
      proposed_value: 0,
      confidence: 'high',
      reason: '無料明示',
      evidence_text: clipEvidence(freeHit[0]),
      source_url: sourceUrl,
    })
  } else if (amounts.length > 0) {
    const min = Math.min(...amounts)
    const max = Math.max(...amounts)
    push(out, {
      field: 'is_free',
      proposed_value: false,
      confidence: 'high',
      reason: '本文に有料金額の明示',
      evidence_text: clipEvidence(yenMatches[0]?.[0] ?? `${min}円`),
      source_url: sourceUrl,
    })
    push(out, {
      field: 'price_min',
      proposed_value: min,
      confidence: 'medium',
      reason: '本文の金額表記から最小値',
      evidence_text: clipEvidence(`${min.toLocaleString('ja-JP')}円`),
      source_url: sourceUrl,
    })
    push(out, {
      field: 'price_max',
      proposed_value: max,
      confidence: 'medium',
      reason: '本文の金額表記から最大値',
      evidence_text: clipEvidence(`${max.toLocaleString('ja-JP')}円`),
      source_url: sourceUrl,
    })
  }

  const priceLine = text.match(
    /(?:料金|入場料|チケット|参加費)[^。\n]{0,100}(?:円|無料)/,
  )
  if (priceLine && priceLine[0].trim().length >= 6) {
    push(out, {
      field: 'price_text',
      proposed_value: priceLine[0].replace(/\s+/g, ' ').trim().slice(0, 200),
      confidence: 'medium',
      reason: '料金関連の一文',
      evidence_text: clipEvidence(priceLine[0]),
      source_url: sourceUrl,
    })
  }

  return out
}

export function extractReservationFromText(
  text: string,
  sourceUrl: string | null,
): VisitFieldProposal[] {
  const out: VisitFieldProposal[] = []
  let status: ReservationStatus | null = null
  let evidence = ''
  let confidence: VisitFieldProposal['confidence'] = 'medium'

  if (/予約必須|要予約|事前申込(?:必須)?|事前申し込み(?:必須)?/.test(text)) {
    status = 'required'
    evidence = (text.match(/予約必須|要予約|事前申込(?:必須)?|事前申し込み(?:必須)?/) ?? [
      '要予約',
    ])[0]
    confidence = 'high'
  } else if (/予約推奨|事前予約推奨|予約優先|事前予約がおすすめ/.test(text)) {
    status = 'recommended'
    evidence = (text.match(/予約推奨|事前予約推奨|予約優先|事前予約がおすすめ/) ?? [
      '予約推奨',
    ])[0]
    confidence = 'high'
  } else if (/予約不要|当日参加(?:可|OK)?|当日受付|予約なしで/.test(text)) {
    status = 'not_required'
    evidence = (text.match(/予約不要|当日参加(?:可|OK)?|当日受付|予約なしで/) ?? [
      '予約不要',
    ])[0]
    confidence = 'high'
  }

  if (status) {
    push(out, {
      field: 'reservation_status',
      proposed_value: status,
      confidence,
      reason: '予約に関する明示文言',
      evidence_text: clipEvidence(evidence),
      source_url: sourceUrl,
    })
  }

  const urlHit = text.match(
    /https?:\/\/[^\s"'<>]+(?:reserve|reservation|ticket|entry|apply|booking)[^\s"'<>]*/i,
  )
  if (urlHit) {
    push(out, {
      field: 'reservation_url',
      proposed_value: urlHit[0].replace(/[),.;]+$/, ''),
      confidence: 'medium',
      reason: '申込・チケット系URLの明示',
      evidence_text: clipEvidence(urlHit[0]),
      source_url: sourceUrl,
    })
  }

  return out
}

type StationHit = { station: string; walk: number | null; evidence: string }

export function extractAccessFromText(
  text: string,
  sourceUrl: string | null,
): VisitFieldProposal[] {
  const out: VisitFieldProposal[] = []
  const hits: StationHit[] = []

  const patterns = [
    /最寄(?:り)?駅[:：]?\s*([^\s、。／/]{2,20}?駅)\s*(?:から)?\s*徒歩\s*約?\s*(\d{1,2})\s*分/g,
    /([^\s、。／/]{2,20}?駅)\s*(?:から)?\s*徒歩\s*約?\s*(\d{1,2})\s*分/g,
    /([^\s、。／/]{2,20}?駅)\s*[／/・]\s*徒歩\s*約?\s*(\d{1,2})\s*分/g,
  ]

  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const station = m[1]?.trim()
      const walk = m[2] ? Number(m[2]) : null
      if (!station || !station.endsWith('駅')) continue
      if (walk != null && (!Number.isFinite(walk) || walk < 0 || walk > 90)) continue
      hits.push({ station, walk, evidence: m[0] })
    }
  }

  const uniqueStations = [...new Set(hits.map((h) => h.station))]
  const nearestExplicit = text.match(
    /最寄(?:り)?駅[:：]?\s*([^\s、。／/]{2,20}?駅)/,
  )

  let chosen: StationHit | null = null
  if (nearestExplicit) {
    const name = nearestExplicit[1].trim()
    chosen =
      hits.find((h) => h.station === name) ??
      ({ station: name, walk: null, evidence: nearestExplicit[0] } as StationHit)
  } else if (uniqueStations.length === 1 && hits[0]) {
    const withWalk = hits.filter((h) => h.walk != null)
    chosen =
      withWalk.sort((a, b) => (a.walk ?? 99) - (b.walk ?? 99))[0] ?? hits[0]
  } else if (uniqueStations.length > 1) {
    // 複数駅 → 代表駅は断定しない。十分な access 文のみ
    const accessLine = text.match(
      /(?:アクセス|交通|最寄)[^。\n]{8,160}駅[^。\n]{0,40}/,
    )
    if (accessLine && /駅|徒歩/.test(accessLine[0])) {
      push(out, {
        field: 'access_text',
        proposed_value: accessLine[0].replace(/\s+/g, ' ').trim().slice(0, 200),
        confidence: 'medium',
        reason: '複数駅のため代表駅は断定せず access_text のみ',
        evidence_text: clipEvidence(accessLine[0]),
        source_url: sourceUrl,
      })
    }
    return out
  }

  if (chosen) {
    push(out, {
      field: 'nearest_station',
      proposed_value: chosen.station,
      confidence: nearestExplicit ? 'high' : 'medium',
      reason: nearestExplicit
        ? '最寄駅の明示'
        : '単一駅の徒歩表記',
      evidence_text: clipEvidence(chosen.evidence),
      source_url: sourceUrl,
    })
    if (chosen.walk != null) {
      push(out, {
        field: 'walk_minutes',
        proposed_value: chosen.walk,
        confidence: 'high',
        reason: '徒歩分数の明示',
        evidence_text: clipEvidence(chosen.evidence),
        source_url: sourceUrl,
      })
      push(out, {
        field: 'access_text',
        proposed_value: `${chosen.station}から徒歩約${chosen.walk}分`,
        confidence: 'medium',
        reason: '駅+徒歩から整形',
        evidence_text: clipEvidence(chosen.evidence),
        source_url: sourceUrl,
      })
    }
  }

  return out
}

export function extractVenueTypeFromText(
  text: string,
  sourceUrl: string | null,
): VisitFieldProposal[] {
  const out: VisitFieldProposal[] = []
  let value: VenueType | null = null
  let evidence = ''

  // 会場・開催文脈に近い明示のみ（単独の「屋外」ノイズを避ける）
  const mixed = text.match(
    /(?:会場|開催|イベント)?[^。\n]{0,12}(?:屋内外|一部屋外|屋内・屋外|屋内と屋外)/,
  )
  const indoor = text.match(
    /(?:会場|開催|イベント|展示|屋内会場)[^。\n]{0,20}(?:屋内|室内)|(?:屋内|室内)(?:会場|展示|イベント)/,
  )
  const outdoor = text.match(
    /(?:会場|開催|イベント|野外会場)[^。\n]{0,20}(?:屋外|野外)|(?:屋外|野外)(?:会場|イベント)/,
  )

  if (mixed) {
    value = 'mixed'
    evidence = mixed[0]
  } else if (indoor && outdoor) {
    value = 'mixed'
    evidence = `${indoor[0]} / ${outdoor[0]}`
  } else if (indoor) {
    value = 'indoor'
    evidence = indoor[0]
  } else if (outdoor) {
    value = 'outdoor'
    evidence = outdoor[0]
  }

  if (value) {
    push(out, {
      field: 'venue_type',
      proposed_value: value,
      confidence: 'high',
      reason: '会場環境の明示',
      evidence_text: clipEvidence(evidence),
      source_url: sourceUrl,
    })
  }
  return out
}

export function extractFamilyFriendlyFromText(
  text: string,
  sourceUrl: string | null,
  category: string[] | null,
): VisitFieldProposal[] {
  const out: VisitFieldProposal[] = []
  const hit = text.match(
    /子ども向け|子供向け|ファミリー向け|親子(?:向け|同伴)?|キッズ(?:向け)?|お子様向け/,
  )
  const ageHit = text.match(
    /\d{1,2}\s*歳(?:以上|未満|まで)|未就学児|小学生以下|幼児|乳幼児/,
  )
  const kidsCat = Array.isArray(category) && category.includes('kids')

  if (hit || ageHit) {
    push(out, {
      field: 'family_friendly',
      proposed_value: 'yes' as FriendlyValue,
      confidence: hit ? 'high' : 'medium',
      reason: hit
        ? '子ども/ファミリー向けの明示'
        : '対象年齢の明示',
      evidence_text: clipEvidence((hit ?? ageHit)![0]),
      source_url: sourceUrl,
    })
  } else if (kidsCat) {
    // category alone is not enough for yes — leave unknown via no proposal
  }

  if (ageHit) {
    const line = text.match(/[^\n。]{0,20}\d{1,2}\s*歳[^\n。]{0,30}/)
    push(out, {
      field: 'age_note',
      proposed_value: (line?.[0] ?? ageHit[0]).replace(/\s+/g, ' ').trim().slice(0, 120),
      confidence: 'high',
      reason: '年齢・対象の公式文言',
      evidence_text: clipEvidence(ageHit[0]),
      source_url: sourceUrl,
    })
  }

  return out
}

export function extractDateSoloFromText(
  text: string,
  sourceUrl: string | null,
): VisitFieldProposal[] {
  const out: VisitFieldProposal[] = []
  if (/デート向け|カップル向け|恋人同士/.test(text)) {
    const e = (text.match(/デート向け|カップル向け|恋人同士/) ?? ['デート向け'])[0]
    push(out, {
      field: 'date_friendly',
      proposed_value: 'yes',
      confidence: 'high',
      reason: 'デート向けの明示',
      evidence_text: clipEvidence(e),
      source_url: sourceUrl,
    })
  }
  if (/一人(?:でも)?(?:楽し|OK|歓迎)|おひとり様歓迎|ソロ向け/.test(text)) {
    const e = (text.match(
      /一人(?:でも)?(?:楽し|OK|歓迎)|おひとり様歓迎|ソロ向け/,
    ) ?? ['一人でも'])[0]
    push(out, {
      field: 'solo_friendly',
      proposed_value: 'yes',
      confidence: 'high',
      reason: '一人向けの明示',
      evidence_text: clipEvidence(e),
      source_url: sourceUrl,
    })
  }
  return out
}

export function extractRainFriendlyFromText(
  text: string,
  sourceUrl: string | null,
  venueType: VenueType | null,
): VisitFieldProposal[] {
  const out: VisitFieldProposal[] = []
  if (/雨天中止|荒天中止|天候により中止/.test(text)) {
    const e = (text.match(/雨天中止|荒天中止|天候により中止/) ?? ['雨天中止'])[0]
    push(out, {
      field: 'rain_friendly',
      proposed_value: 'no',
      confidence: 'high',
      reason: '雨天中止の明示',
      evidence_text: clipEvidence(e),
      source_url: sourceUrl,
    })
    return out
  }
  if (
    /雨天(?:開催|対応|決行)|雨の日でも|天候に左右されない|全天候/.test(text) &&
    venueType === 'indoor'
  ) {
    const e = (text.match(
      /雨天(?:開催|対応|決行)|雨の日でも|天候に左右されない|全天候/,
    ) ?? ['雨天対応'])[0]
    push(out, {
      field: 'rain_friendly',
      proposed_value: 'yes',
      confidence: 'medium',
      reason: '屋内かつ雨天対応の明示',
      evidence_text: clipEvidence(e),
      source_url: sourceUrl,
    })
  }
  return out
}

export function extractDurationFromText(
  text: string,
  sourceUrl: string | null,
): VisitFieldProposal[] {
  const out: VisitFieldProposal[] = []
  const range = text.match(
    /(?:所要時間|体験時間|滞在時間)\s*約?\s*(\d{1,3})\s*[〜~\-－]\s*(\d{1,3})\s*分/,
  )
  if (range) {
    const min = Number(range[1])
    const max = Number(range[2])
    push(out, {
      field: 'duration_minutes_min',
      proposed_value: min,
      confidence: 'high',
      reason: '所要時間レンジの明示',
      evidence_text: clipEvidence(range[0]),
      source_url: sourceUrl,
    })
    push(out, {
      field: 'duration_minutes_max',
      proposed_value: max,
      confidence: 'high',
      reason: '所要時間レンジの明示',
      evidence_text: clipEvidence(range[0]),
      source_url: sourceUrl,
    })
    return out
  }
  const single = text.match(
    /(?:所要時間|体験時間|滞在時間)\s*約?\s*(\d{1,3})\s*分/,
  )
  if (single) {
    const n = Number(single[1])
    push(out, {
      field: 'duration_minutes_min',
      proposed_value: n,
      confidence: 'high',
      reason: '所要時間の明示',
      evidence_text: clipEvidence(single[0]),
      source_url: sourceUrl,
    })
    push(out, {
      field: 'duration_minutes_max',
      proposed_value: n,
      confidence: 'high',
      reason: '所要時間の明示',
      evidence_text: clipEvidence(single[0]),
      source_url: sourceUrl,
    })
  }
  return out
}

export function extractParkingFromText(
  text: string,
  sourceUrl: string | null,
): VisitFieldProposal[] {
  const out: VisitFieldProposal[] = []
  let status: ParkingStatus | null = null
  let evidence = ''

  if (/専用駐車場なし|駐車場なし|駐車スペースなし/.test(text)) {
    status = 'not_available'
    evidence = (text.match(/専用駐車場なし|駐車場なし|駐車スペースなし/) ?? [
      '駐車場なし',
    ])[0]
  } else if (/近隣駐車場|周辺の駐車場|近隣の有料/.test(text)) {
    status = 'nearby'
    evidence = (text.match(/近隣駐車場|周辺の駐車場|近隣の有料/) ?? [
      '近隣駐車場',
    ])[0]
  } else if (/駐車場あり|駐車場完備|専用駐車場あり/.test(text)) {
    status = 'available'
    evidence = (text.match(/駐車場あり|駐車場完備|専用駐車場あり/) ?? [
      '駐車場あり',
    ])[0]
  }

  if (status) {
    push(out, {
      field: 'parking_status',
      proposed_value: status,
      confidence: 'high',
      reason: '駐車場の明示',
      evidence_text: clipEvidence(evidence),
      source_url: sourceUrl,
    })
  }

  const line = text.match(/(?:駐車|パーキング)[^\n]{0,80}/)
  if (line) {
    push(out, {
      field: 'parking_text',
      proposed_value: line[0].replace(/\s+/g, ' ').trim().slice(0, 200),
      confidence: 'medium',
      reason: '駐車場の補足文',
      evidence_text: clipEvidence(line[0]),
      source_url: sourceUrl,
    })
  }
  return out
}

export function extractAllDeterministic(opts: {
  text: string
  sourceUrl: string | null
  category: string[] | null
}): VisitFieldProposal[] {
  const { text, sourceUrl, category } = opts
  const venue = extractVenueTypeFromText(text, sourceUrl)
  const venueType =
    (venue.find((p) => p.field === 'venue_type')?.proposed_value as VenueType | null) ??
    null

  return [
    ...extractPriceFromText(text, sourceUrl),
    ...extractReservationFromText(text, sourceUrl),
    ...extractAccessFromText(text, sourceUrl),
    ...venue,
    ...extractFamilyFriendlyFromText(text, sourceUrl, category),
    ...extractDateSoloFromText(text, sourceUrl),
    ...extractRainFriendlyFromText(text, sourceUrl, venueType),
    ...extractDurationFromText(text, sourceUrl),
    ...extractParkingFromText(text, sourceUrl),
  ]
}
