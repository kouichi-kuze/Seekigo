import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  inferMunicipalitySlug,
  resolveAreaSlug,
  resolveEventPlace,
} from '../src/lib/event-field-rules'

const ADDED = [
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
