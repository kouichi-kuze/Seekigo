-- 2026-09-29 時点の終了済み published のうち、料金文で安全に確定した 31件だけ。
-- rerun-safe: status=published かつ price_type IS NULL の対象 ID のみ。
-- is_free / price_text / price_min / price_max など他列は更新しない。
-- NULL維持: 2, 4, 24, 26, 29, 31, 33, 35, 36, 51, 52, 53, 56, 57, 62, 63, 71, 74, 79, 83, 84, 85, 89

UPDATE public.events
SET price_type = 'free'
WHERE status = 'published'
  AND price_type IS NULL
  AND id IN (3, 19, 25, 27, 30, 34, 37, 55, 61, 73);

UPDATE public.events
SET price_type = 'partially_paid'
WHERE status = 'published'
  AND price_type IS NULL
  AND id IN (11, 22, 23, 32);

UPDATE public.events
SET price_type = 'paid'
WHERE status = 'published'
  AND price_type IS NULL
  AND id IN (5, 6, 7, 12, 13, 14, 15, 16, 20, 46, 58, 59, 65, 66, 67, 70);

UPDATE public.events
SET price_type = 'varies'
WHERE status = 'published'
  AND price_type IS NULL
  AND id = 28;
