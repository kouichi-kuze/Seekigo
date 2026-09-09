/**
 * Admin イベント編集 UI 用の日本語ラベル（表示のみ）。
 * DB / POST / 保存ロジックのキー名は変更しない。
 */

export const ADMIN_EVENT_FIELD_LABELS = {
  title: 'イベント名',
  start_date: '開始日',
  end_date: '終了日',
  start_time: '開始時間',
  end_time: '終了時間',
  venue: '会場',
  area: 'エリア',
  address: '住所',
  is_free: '入場料',
  price_min: '最低料金',
  price_max: '最高料金',
  price_text: '料金詳細',
  reservation_status: '予約',
  reservation_url: '予約URL',
  nearest_station: '最寄駅',
  walk_minutes: '駅から徒歩',
  access_text: 'アクセス詳細',
  latitude: '緯度',
  longitude: '経度',
  parking_status: '駐車場',
  parking_text: '駐車場詳細',
  venue_type: '会場タイプ',
  family_friendly: '子ども向け',
  date_friendly: 'デート向け',
  solo_friendly: '一人向け',
  rain_friendly: '雨の日向け',
  age_note: '年齢・対象',
  duration_minutes_min: '所要時間（最短）',
  duration_minutes_max: '所要時間（最長）',
  category: 'カテゴリ',
  official_url: '公式サイトURL',
  summary: '概要',
  image_url: '画像URL',
  image_usage_status: '画像利用状態',
  image_credit: '画像クレジット',
} as const

export type AdminEventFieldKey = keyof typeof ADMIN_EVENT_FIELD_LABELS

export const RESERVATION_STATUS_LABELS: Record<string, string> = {
  required: '予約必須',
  recommended: '事前予約推奨',
  not_required: '予約不要',
  unknown: '不明',
}

export const VENUE_TYPE_LABELS: Record<string, string> = {
  indoor: '屋内',
  outdoor: '屋外',
  mixed: '屋内・屋外',
  unknown: '不明',
}

export const FRIENDLY_VALUE_LABELS: Record<string, string> = {
  yes: 'はい',
  no: 'いいえ',
  unknown: '不明',
}

export const PARKING_STATUS_LABELS: Record<string, string> = {
  available: '駐車場あり',
  not_available: '駐車場なし',
  nearby: '周辺駐車場あり',
  unknown: '不明',
}

export const IS_FREE_LABELS = {
  unset: '未設定',
  free: '無料',
  paid: '有料',
} as const

export const IMAGE_USAGE_STATUS_LABELS: Record<string, string> = {
  unknown: '不明',
  licensed: 'ライセンス取得済',
  organizer_granted: '主催者許可',
  own: '自社素材',
  forbidden: '利用不可',
}

export const ADMIN_ENUM_UNSET_LABEL = '未設定'
