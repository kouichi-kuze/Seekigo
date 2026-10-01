/** 管理画面の外部リンク。http/https 以外は開かない。 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  const text = value?.trim()
  if (!text) return null
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.href
  } catch {
    return null
  }
}

const SOURCE_LABELS: Record<string, string> = {
  walkerplus: 'Walkerplus',
  gotokyo: 'GO TOKYO',
  enjoytokyo: 'EnjoyTokyo',
  minato_opendata: '港区オープンデータ',
}

export function sourcePageLabel(sourceName: string | null | undefined): string {
  const key = sourceName?.trim() ?? ''
  return SOURCE_LABELS[key] ?? (key || '取得元')
}
