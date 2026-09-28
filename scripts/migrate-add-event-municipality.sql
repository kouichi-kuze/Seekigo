-- Seekigo: events.municipality（区市町村スラッグ）を追加する。第1段階。
--
-- 実行: Supabase SQL Editor に貼り付けて手動実行（このファイルは自動実行しない）
-- 既存の area は UPDATE・削除・置換しない。
-- published の title / summary / 本文も変更しない。
-- CHECK 制約は付けない。値の調査とバックフィルを先にする。
-- バックフィルは scripts/backfill-event-municipality.ts（既定 DRY_RUN）。

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS municipality text;

COMMENT ON COLUMN public.events.municipality IS
  'Ward or city slug (minato, chuo, shinjuku). Null when unknown. Neighborhoods stay on area (roppongi, ginza).';
