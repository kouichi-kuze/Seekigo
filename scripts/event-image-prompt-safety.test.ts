import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildConceptImagePrompt } from '../src/lib/event-generated-image-prompt'

const cases: Array<[string, { title: string; summary: string | null; category: string[] }, string[]]> = [
  [
    '154',
    {
      title: '古舘春一 ハイキュー!!展 挑戦者たち',
      summary: '漫画『ハイキュー!!』をテーマにした高校バレーボールの原画展。',
      category: ['exhibition'],
    },
    ['ハイキュー', '古舘', '漫画'],
  ],
  [
    '170',
    {
      title: 'アニマーシブライブ『竜とそばかすの姫』',
      summary: '映画『竜とそばかすの姫』の世界を舞台にした没入型ライブショーです。',
      category: ['other'],
    },
    ['竜とそばかす', '姫', '映画'],
  ],
  [
    '187',
    {
      title: 'THE WORLD OF BIOHAZARD 30周年展',
      summary: 'カプコンの人気ゲームシリーズ「バイオハザード」の展覧会である。',
      category: ['exhibition', 'kids'],
    },
    ['BIOHAZARD', 'バイオハザード', 'カプコン'],
  ],
  [
    '197',
    {
      title: '池袋ハロウィンコスプレフェス2026',
      summary: 'マンガ・アニメの聖地で、コスプレイヤーが参加します。',
      category: ['festival', 'kids'],
    },
    ['コスプレ', 'アニメ', 'マンガ'],
  ],
  [
    '206',
    {
      title: 'キッザニア東京20周年 限定アクティビティ',
      summary: '「キッザニア東京」が20周年を迎え、パビリオンでアクティビティを楽しめる。',
      category: ['workshop', 'kids'],
    },
    ['キッザニア', 'KidZania'],
  ],
]

for (const [id, event, banned] of cases) {
  test(`event ${id} prompt omits protected names and keeps a generic theme`, () => {
    const prompt = buildConceptImagePrompt(event, null)
    for (const word of banned) {
      assert.equal(prompt.includes(word), false, word)
    }
    assert.match(prompt, /Do not depict copyrighted characters/)
    assert.match(prompt, /Theme context:/)
  })
}

test('a non-sensitive title is left unchanged', () => {
  const prompt = buildConceptImagePrompt(
    {
      title: '秋のバラフェスティバル',
      summary: '旧古河庭園で秋バラの見頃に合わせて行われる。',
      category: ['seasonal'],
      venue: null,
      is_kids: null,
      is_indoor: null,
    },
    null,
  )
  assert.match(prompt, /秋のバラフェスティバル/)
  assert.match(prompt, /旧古河庭園/)
})
