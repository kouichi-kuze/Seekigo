export type GeneratedImageReviewRow = {
  id: number
  generated_image_status: string | null
  generated_image_url: string | null
}

/**
 * 画面から渡された ID だけを見る。
 * pending かつ画像 URL がある行だけを採用対象にする。
 */
export function classifyDisplayedApprovals(
  requestedIds: number[],
  rows: GeneratedImageReviewRow[],
): { approveIds: number[]; failedIds: number[] } {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const approveIds: number[] = []
  const failedIds: number[] = []

  for (const id of requestedIds) {
    const row = byId.get(id)
    const status = row?.generated_image_status?.trim() || 'none'
    const url = row?.generated_image_url?.trim() ?? ''
    if (row && status === 'pending' && url) {
      approveIds.push(id)
    } else {
      failedIds.push(id)
    }
  }

  return { approveIds, failedIds }
}
