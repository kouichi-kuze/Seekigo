-- 旧 area 設計で残った自治体スラッグを area から外す。
-- 街の補完はしない。area 以外は変えない。
-- 再実行しても、対象が残っていなければ更新件数は 0。
--
-- 実行前の確認:
-- SELECT id, title, municipality, area
-- FROM public.events
-- WHERE status = 'published'
--   AND area IS NOT NULL
--   AND municipality IS NOT NULL
--   AND area = municipality
-- ORDER BY id;

UPDATE public.events
SET area = NULL
WHERE status = 'published'
  AND area IS NOT NULL
  AND municipality IS NOT NULL
  AND area = municipality;
