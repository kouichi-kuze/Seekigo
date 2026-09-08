/**
 * Rule-based X post classification (experience / official / media / other).
 * No AI. Classification is for selection only (not persisted in Phase 4B-2.1).
 */
import type { XPost } from './types'

export type XPostClass = 'experience' | 'official' | 'media' | 'other'

const EXPERIENCE_RE =
  /行ってきた|行ってき|見てきた|見て来|来たよ|行ってきた|楽し(かった|めた)|面白(かった|い)|混んで|混雑|空いて|すいて|子どもと|子供と|子連れ|雨(だった|で)|待った|待ち時間|並んだ|列が|写真(撮|を撮)|撮った|おすすめ|オススメ|体験|入場(した|して)|会場(に|で)|現地|行ってみた|行ってよ|行こうと思|行ったら|行ったよ|最高だった|良かった|よかった|寒かった|暑かった|感動/

const OFFICIAL_RE =
  /公式(アカウント|情報|サイト|発表|HP)?|主催(者|より)?|オフィシャル|チケット(販売|発売)(中|開始)?|本日(より|から)開催|開催(決定|のお知らせ|します)|ご来場お待ち|詳細は(こちら|公式)|プレスリリース/

const MEDIA_RE =
  /ニュース|報道|イベント情報|まとめ|ウォーカー|walkerplus|gotokyo|enjoytokyo|ぴあ|timeout|タイムアウト|情報サイト|メディア/

const MEDIA_HOST_RE =
  /walkerplus\.|gotokyo\.|enjoytokyo\.|pia\.co\.jp|timeout\.com|asahi\.|yomiuri\.|mainichi\.|nhk\.or\.jp|natalie\.|moviewalker\./i

const ANNOUNCE_RE =
  /開催(中|します|のお知らせ|決定)|チケット(発売|販売|受付)|詳細はこちら|公式サイト(へ|は|で)|お知らせ|入場無料(?!で行った)|本日オープン|期間限定開催|好評開催中|ぜひ(お越し|ご来場)/

export function classifyXPost(post: XPost): XPostClass {
  const text = post.text || ''
  const user = (post.username || '').toLowerCase()

  if (EXPERIENCE_RE.test(text)) return 'experience'

  if (
    OFFICIAL_RE.test(text) ||
    /official|公式|staff|主催/.test(user) ||
    /_pr$|_info$|official/.test(user)
  ) {
    return 'official'
  }

  if (MEDIA_RE.test(text) || post.urls.some((u) => MEDIA_HOST_RE.test(u))) {
    return 'media'
  }

  return 'other'
}

/** 告知中心で体験表現が弱い投稿 */
export function isAnnouncementHeavy(post: XPost): boolean {
  const text = post.text || ''
  if (EXPERIENCE_RE.test(text)) return false
  return ANNOUNCE_RE.test(text)
}
