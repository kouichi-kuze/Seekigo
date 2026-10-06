/**
 * Walkerplus 第4バッチの event ID。
 * 2026-10-05 の import で入った draft 50件（456〜505）。
 * 画像生成はこの配列だけを ID 指定で読む。draft 全件は走査しない。
 */
export const WALKERPLUS_BATCH4_EVENT_IDS = Array.from(
  { length: 50 },
  (_, index) => 456 + index,
) as readonly number[]
