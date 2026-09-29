-- 2026-09-29 時点の未終了 published 71件だけを、公式source前の保存データ監査の仮分類どおりに入れる。
-- 終了済み・draft は対象外。is_free / price_text / price_min / price_max は変えない。
-- free 8 / partially_paid 5 / paid 38 / varies 1 / NULL 19

UPDATE public.events
SET price_type = 'free'
WHERE status = 'published'
  AND id IN (39, 69, 95, 112, 115, 116, 123, 126);

UPDATE public.events
SET price_type = 'partially_paid'
WHERE status = 'published'
  AND id IN (93, 94, 98, 100, 131);

UPDATE public.events
SET price_type = 'paid'
WHERE status = 'published'
  AND id IN (
    8, 9, 17, 18, 21, 38, 40, 41, 42, 44, 45, 47,
    72, 86, 90, 91, 92, 96, 99, 101, 104, 105, 106, 107,
    108, 110, 111, 117, 118, 119, 120, 121, 122, 125,
    127, 128, 129, 130
  );

UPDATE public.events
SET price_type = 'varies'
WHERE status = 'published'
  AND id = 124;

UPDATE public.events
SET price_type = NULL
WHERE status = 'published'
  AND id IN (
    43, 54, 60, 64, 68, 75, 76, 77, 80, 81, 82,
    87, 88, 97, 102, 103, 109, 113, 114
  );
