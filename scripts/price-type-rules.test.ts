import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inferPriceTypeFromPriceText } from '../src/lib/event-field-rules'

const cases: Array<[string | null | undefined, string | null]> = [
  ['入場無料', 'free'],
  ['観覧無料', 'free'],
  ['料金: 入場無料。', 'free'],
  ['一般2,300円、高校生以下無料', 'paid'],
  ['入場無料、飲食は有料', 'partially_paid'],
  ['観覧無料、パレード参加500円', 'partially_paid'],
  ['一部有料', 'partially_paid'],
  ['店舗によって異なる', 'varies'],
  ['', null],
  [null, null],
  ['料金記載なし', null],
  [
    '入場料は無料。ラーメンは1杯1,100円。ラーメンはチケット制。 チケット1枚でラーメン1杯と引き換え。',
    'partially_paid',
  ],
  ['料金: 入場無料。飲食代は別途。200円刻みの食券制', 'partially_paid'],
  [
    '料金: 有料。3,300円（※街に姿を現すポケモンたちは、無料で鑑賞可能。）',
    'partially_paid',
  ],
  ['料金: 有料。カレー提供店によって異なる', 'varies'],
  [
    '観覧・来場の参加費は不要。パレード参加は猫まち旅券バッジが必要。【市民猫】500円（化け猫パレード参加権）',
    'partially_paid',
  ],
  ['入場料：無料', 'free'],
  ['入場料金：無料', 'free'],
  ['入場料: 無料', 'free'],
  ['入場料金 : 無料', 'free'],
  ['各種イベントによって異なります', 'varies'],
  ['2,000円 ※内容により異なるため最新情報は公式確認', null],
  ['サポーターズシートあり1口8,000円 公式HPの応募フォームから申し込み', null],
  ['屋台での飲食のみ有料', null],
  ['キッチンカー、テントでの飲食は有料', null],
]

for (const [input, expected] of cases) {
  test(JSON.stringify(input), () => {
    assert.equal(inferPriceTypeFromPriceText(input), expected)
  })
}
