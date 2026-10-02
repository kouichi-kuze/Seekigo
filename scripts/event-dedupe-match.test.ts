import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  matchAgainstExisting,
  type DedupeCandidate,
  type DedupeExisting,
} from '../src/lib/event-dedupe'

function existing(partial: Partial<DedupeExisting> & Pick<DedupeExisting, 'slug'>): DedupeExisting {
  return {
    id: 1,
    title: '既存イベント',
    start_date: '2026-10-03',
    end_date: '2026-10-03',
    venue: '介護予防総合センター',
    official_url: 'https://example.com/existing',
    source_url: 'https://example.com/source/existing',
    area: 'minato',
    status: 'published',
    ...partial,
  }
}

function incoming(partial: Partial<DedupeCandidate>): DedupeCandidate {
  return {
    title: '別の催し',
    start_date: '2026-11-12',
    end_date: '2026-11-12',
    venue: '介護予防総合センター',
    official_url: 'https://example.com/incoming',
    source_url: 'https://example.com/source/incoming',
    area: 'minato',
    ...partial,
  }
}

test('same venue with different title and date is not a review candidate', () => {
  const match = matchAgainstExisting(
    incoming({
      title: '第37回フランス料理昼食会',
      start_date: '2026-11-12',
      end_date: '2026-11-12',
      venue: '介護予防総合センター（みなとパーク芝浦2階）',
      official_url: 'https://example.com/french-lunch',
      source_url: 'https://example.com/source/french-lunch',
    }),
    [
      existing({
        title: '「ユマニチュード®」家族介護者向け講座',
        start_date: '2026-10-03',
        end_date: '2026-10-03',
        venue: '介護予防総合センター（みなとパーク芝浦2階）',
        official_url: 'https://www.city.minato.tokyo.jp/kouhou/event/261003-humanitude.html',
        source_url: 'https://www.city.minato.tokyo.jp/kouhou/event/261003-humanitude.html',
      }),
    ],
  )
  assert.equal(match.duplicate_status, 'none')
  assert.equal(match.duplicate_reason.includes('venue similar only'), false)
})

test('venue match alone is not a review candidate', () => {
  const match = matchAgainstExisting(
    incoming({
      title: 'スマホ講座',
      start_date: '2026-10-01',
      venue: '芝区民協働スペース',
      area: 'minato',
    }),
    [
      existing({
        title: '語り部ガイド養成講座',
        start_date: '2026-09-27',
        venue: '芝区民協働スペース',
        area: 'shibuya',
      }),
    ],
  )
  assert.equal(match.duplicate_status, 'none')
})

test('area match alone is not a review candidate', () => {
  const match = matchAgainstExisting(
    incoming({
      title: '音楽会',
      start_date: '2026-12-01',
      venue: 'ホールA',
      area: 'minato',
    }),
    [
      existing({
        title: '展覧会',
        start_date: '2026-08-01',
        venue: 'ホールB',
        area: 'minato',
      }),
    ],
  )
  assert.equal(match.duplicate_status, 'none')
})

test('an identical title and start date stays exact', () => {
  const match = matchAgainstExisting(
    incoming({
      title: 'オクトーバーフェストin東京スカイツリータウン 2026',
      start_date: '2026-09-19',
      end_date: '2026-10-26',
      venue: '東京スカイツリータウン',
      area: 'sumida',
    }),
    [
      existing({
        title: 'オクトーバーフェストin東京スカイツリータウン 2026',
        start_date: '2026-09-19',
        end_date: '2026-10-26',
        venue: '東京スカイツリータウン',
        area: 'sumida',
      }),
    ],
  )
  assert.equal(match.duplicate_status, 'exact')
})

test('high title similarity with overlapping dates and the same venue stays likely', () => {
  const match = matchAgainstExisting(
    incoming({
      title: 'コスモスまつり2026 秋の特別版',
      start_date: '2026-09-12',
      end_date: '2026-10-26',
      venue: '国営昭和記念公園',
    }),
    [
      existing({
        title: 'コスモスまつり2026',
        start_date: '2026-09-12',
        end_date: '2026-10-26',
        venue: '国営昭和記念公園',
      }),
    ],
  )
  assert.ok(match.duplicate_status === 'likely' || match.duplicate_status === 'exact')
})

test('high title similarity with a different date stays ambiguous and is not auto-merged', () => {
  const match = matchAgainstExisting(
    incoming({
      title: 'コスモスまつり2026',
      start_date: '2026-11-01',
      end_date: '2026-11-03',
      venue: '国営昭和記念公園',
    }),
    [
      existing({
        title: 'コスモスまつり2026',
        start_date: '2026-09-12',
        end_date: '2026-10-26',
        venue: '国営昭和記念公園',
      }),
    ],
  )
  assert.equal(match.duplicate_status, 'ambiguous')
  assert.equal(match.recommended_action, 'review_required')
})

test('the same normalized title and start date stays exact', () => {
  const match = matchAgainstExisting(
    incoming({
      title: 'コスモスまつり2026',
      start_date: '2026-09-12',
      end_date: '2026-10-26',
      venue: '別の公園',
    }),
    [
      existing({
        title: 'コスモスまつり2026',
        start_date: '2026-09-12',
        end_date: '2026-10-26',
        venue: '国営昭和記念公園',
      }),
    ],
  )
  assert.equal(match.duplicate_status, 'exact')
})

test('a similar title with overlapping dates and a different venue stays a review', () => {
  const match = matchAgainstExisting(
    incoming({
      title: 'コスモスまつり2026 秋の特別版',
      start_date: '2026-09-12',
      end_date: '2026-10-26',
      venue: '別の公園',
    }),
    [
      existing({
        title: 'コスモスまつり2026',
        start_date: '2026-09-12',
        end_date: '2026-10-26',
        venue: '国営昭和記念公園',
      }),
    ],
  )
  assert.ok(
    match.duplicate_status === 'likely' || match.duplicate_status === 'ambiguous',
  )
})
