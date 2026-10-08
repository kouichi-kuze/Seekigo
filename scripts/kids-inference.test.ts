import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inferKidsFromAudienceText } from './lib/kids-inference'
import {
  inferKidsFromWalkerplusCategories,
  mapWalkerplusCategories,
} from './lib/walkerplus-category-map'

test('a companion tag does not become the kids category', () => {
  assert.deepEqual(mapWalkerplusCategories(['子供と']).mapped, ['other'])
  assert.deepEqual(mapWalkerplusCategories(['恋人と・夫婦で / 子供と']).mapped, ['other'])
  assert.deepEqual(mapWalkerplusCategories(['ライブ・音楽イベント', '子供と']).mapped, ['music'])
  assert.deepEqual(mapWalkerplusCategories(['フリーマーケット', '子供と', '恋人と・夫婦で']).mapped, ['market'])
  assert.deepEqual(mapWalkerplusCategories(['祭り', 'グルメ・フードフェス', '子供と']).mapped, ['festival', 'food'])
  assert.deepEqual(mapWalkerplusCategories(['美術展・博物展']).mapped, ['exhibition'])
  assert.deepEqual(mapWalkerplusCategories(['体験イベント・アクティビティ']).mapped, ['workshop'])
  assert.deepEqual(mapWalkerplusCategories(['キッズ']).mapped, ['kids'])
  assert.deepEqual(mapWalkerplusCategories(['舞台・演劇', '子供と']).mapped, ['other'])
})

test('a Walkerplus companion tag is not a kids event', () => {
  assert.equal(inferKidsFromWalkerplusCategories(['子供と']), null)
  assert.equal(inferKidsFromWalkerplusCategories(['恋人と・夫婦で / 子供と']), null)
  assert.equal(inferKidsFromWalkerplusCategories(['恋人と', '夫婦で', '子供と']), null)
})

test('Walkerplus examples that were marked kids only by 子供と stay unset', () => {
  const companionOnly = ['子供と']
  for (const title of [
    '没後70年 映画監督 溝口健二',
    '企画展「絵画に見る大田区海辺の情景」',
    'THE WORLD OF BIOHAZARD 30周年展',
    '第13回酒屋角打ちフェス',
  ]) {
    assert.equal(inferKidsFromWalkerplusCategories(companionOnly), null, title)
    assert.equal(inferKidsFromAudienceText(title), null, title)
  }
  assert.notEqual(inferKidsFromAudienceText('未就学児入場不可'), true)
  assert.equal(inferKidsFromAudienceText('邦楽フレッシュコンサート 未就学児入場不可'), false)
})

test('audience text does not treat prices or admission notes as kids events', () => {
  assert.equal(inferKidsFromAudienceText('子供と'), null)
  assert.equal(inferKidsFromAudienceText('恋人と・夫婦で / 子供と'), null)
  assert.equal(inferKidsFromAudienceText('高校生以下300円'), null)
  assert.equal(inferKidsFromAudienceText('小学生以下無料'), null)
  assert.equal(inferKidsFromAudienceText('18歳未満300円'), null)
  assert.equal(inferKidsFromAudienceText('子どもも入場できます'), null)
  assert.equal(inferKidsFromAudienceText('子ども'), null)
  assert.equal(inferKidsFromAudienceText('学生料金'), null)
  assert.notEqual(inferKidsFromAudienceText('未就学児入場不可'), true)
})

test('explicit child, family, and school audiences are kids events', () => {
  assert.equal(inferKidsFromAudienceText('親子で参加できるワークショップ'), true)
  assert.equal(inferKidsFromAudienceText('子ども向けワークショップ'), true)
  assert.equal(inferKidsFromAudienceText('ファミリー向けイベント'), true)
  assert.equal(inferKidsFromAudienceText('小学生を対象とした体験教室'), true)
  assert.equal(inferKidsFromAudienceText('0歳から楽しめる親子コンサート'), true)
  assert.equal(
    inferKidsFromWalkerplusCategories(['子ども向けワークショップ']),
    true,
  )
  assert.equal(inferKidsFromWalkerplusCategories(['子供と', 'キッズ']), true)
  assert.equal(
    inferKidsFromWalkerplusCategories(['子供と'], '0歳から楽しめる親子コンサート'),
    true,
  )
  assert.notEqual(
    inferKidsFromWalkerplusCategories(['子供と'], '邦楽フレッシュコンサート 未就学児入場不可'),
    true,
  )
})
