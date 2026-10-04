import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  inferMunicipalitySlug,
  resolveAreaSlug,
  resolveEventPlace,
} from '../src/lib/event-field-rules'

const ADDED = [
  ['あきる野市', 'akiruno'],
  ['中野区', 'nakano'],
  ['豊島区', 'toshima'],
  ['江東区', 'koto'],
  ['江戸川区', 'edogawa'],
  ['足立区', 'adachi'],
  ['八王子市', 'hachioji'],
  ['調布市', 'chofu'],
  ['武蔵野市', 'musashino'],
  ['三鷹市', 'mitaka'],
  ['板橋区', 'itabashi'],
  ['葛飾区', 'katsushika'],
  ['羽村市', 'hamura'],
  ['国分寺市', 'kokubunji'],
  ['府中市', 'fuchu'],
  ['国立市', 'kunitachi'],
] as const

for (const [label, slug] of ADDED) {
  test(`${label} in an address resolves to ${slug}`, () => {
    assert.equal(
      inferMunicipalitySlug({ address: `東京都${label}1-2-3` }),
      slug,
    )
  })
}

test('八王子市 is a municipality and not the Oji neighborhood', () => {
  const address = '八王子市高尾町'
  assert.equal(resolveAreaSlug({ address, venue: '高尾山' }), 'hachioji')
  assert.notEqual(resolveAreaSlug({ address }), 'oji')
  const place = resolveEventPlace({
    areaHint: '八王子市',
    address,
    venue: '高尾山',
  })
  assert.equal(place.municipality, 'hachioji')
  assert.notEqual(place.area, 'oji')
  assert.notEqual(place.legacyArea, 'oji')
})

test('王子 alone stays a neighborhood and not a municipality', () => {
  assert.equal(resolveAreaSlug({ address: '北区王子1-1' }), 'oji')
  assert.equal(
    inferMunicipalitySlug({ address: '北区王子1-1', venue: '王子' }),
    'kita',
  )
})

test('an explicit address municipality wins over the venue', () => {
  assert.equal(
    inferMunicipalitySlug({
      address: '中野区東中野1-59-14',
      venue: '港区の会場',
    }),
    'nakano',
  )
})

test('Batch 3 city addresses resolve without changing priority', () => {
  assert.equal(
    inferMunicipalitySlug({
      address: '羽村市緑ケ丘4丁目11',
      venue: 'Ｓ＆Ｄスポーツパーク富士見（羽村市富士見公園）',
    }),
    'hamura',
  )
  assert.equal(
    inferMunicipalitySlug({
      address: '国分寺市本町3-8-21井上ビル1階A号室',
      venue: 'カクテルフリークス',
    }),
    'kokubunji',
  )
  assert.equal(
    inferMunicipalitySlug({
      address: '府中市宮町1-100ル・シーニュ5F',
      venue: 'バルトホール',
    }),
    'fuchu',
  )
  assert.equal(
    inferMunicipalitySlug({
      address: '東京都府中市浅間町1-3-1',
      venue: '府中の森公園',
    }),
    'fuchu',
  )
  assert.equal(
    inferMunicipalitySlug({
      address: '国立市東1',
      venue: '国立駅前 大学通り',
    }),
    'kunitachi',
  )
  assert.equal(
    inferMunicipalitySlug({ venue: '羽村市富士見公園' }),
    'hamura',
  )
  assert.equal(inferMunicipalitySlug({ area: 'fuchu' }), 'fuchu')
})

test('Batch 2 Akiruno addresses resolve safely', () => {
  assert.equal(
    inferMunicipalitySlug({
      address: '東京都あきる野市引田 東京サマーランド第2駐車場',
      venue: '東京サマーランド第2駐車場',
    }),
    'akiruno',
  )
  assert.equal(
    inferMunicipalitySlug({
      address: 'あきる野市秋川1-16-1',
      venue: 'S&D秋川キララホール',
    }),
    'akiruno',
  )
})
