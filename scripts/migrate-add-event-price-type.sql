-- Seekigo: events.price_type（料金区分）を追加する。第1段階。
--
-- 許可値: free / partially_paid / paid / varies / NULL
-- unknown は持たない。未監査・未設定は NULL。
-- 既存の is_free / price_text / price_min / price_max は変更しない。
-- バックフィルは scripts/backfill-event-price-type.sql（監査した未終了 published 71件のみ）。

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS price_type text;

ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_price_type_check;

ALTER TABLE public.events
  ADD CONSTRAINT events_price_type_check
  CHECK (
    price_type IS NULL
    OR price_type IN ('free', 'partially_paid', 'paid', 'varies')
  );

COMMENT ON COLUMN public.events.price_type IS
  'Price class: free, partially_paid, paid, varies. NULL means unset or not yet classified. Not synced from is_free.';
