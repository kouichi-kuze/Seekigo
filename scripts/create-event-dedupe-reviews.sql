-- Seekigo: public.event_dedupe_reviews
-- likely / ambiguous の人間レビュー用キュー。
--
-- 実行: Supabase SQL Editor に貼り付けて実行（このファイル自体は自動実行しない）
-- 前提: public.events.id は bigint
--
-- 注意:
-- - exact は本テーブルに入れない（自動 attach）
-- - published 本体は review 操作でも変更しない
-- - 書き込みは service_role のみ（RLS 有効）

CREATE TABLE IF NOT EXISTS public.event_dedupe_reviews (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'linked', 'created', 'rejected', 'expired')),

  incoming_source_name text NOT NULL
    CHECK (incoming_source_name IN ('gotokyo', 'enjoytokyo')),
  incoming_source_url text NOT NULL,

  incoming_payload jsonb NOT NULL,

  candidate_event_id bigint
    REFERENCES public.events (id)
    ON DELETE SET NULL,

  duplicate_status text NOT NULL
    CHECK (duplicate_status IN ('likely', 'ambiguous')),

  reason text,
  scores jsonb,

  review_action text
    CHECK (
      review_action IS NULL
      OR review_action IN ('link_existing', 'create_new', 'reject')
    ),

  resolved_event_id bigint
    REFERENCES public.events (id)
    ON DELETE SET NULL,

  decided_by text,
  decided_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT event_dedupe_reviews_incoming_candidate_unique
    UNIQUE (incoming_source_name, incoming_source_url, candidate_event_id)
);

CREATE INDEX IF NOT EXISTS event_dedupe_reviews_status_idx
  ON public.event_dedupe_reviews (status);

CREATE INDEX IF NOT EXISTS event_dedupe_reviews_candidate_event_id_idx
  ON public.event_dedupe_reviews (candidate_event_id);

CREATE INDEX IF NOT EXISTS event_dedupe_reviews_source_url_idx
  ON public.event_dedupe_reviews (incoming_source_name, incoming_source_url);

COMMENT ON TABLE public.event_dedupe_reviews IS
  'Human review queue for likely/ambiguous dedupe matches. Writes via service_role only.';

COMMENT ON COLUMN public.event_dedupe_reviews.incoming_payload IS
  'Snapshot of incoming event fields for comparison and draft creation';

COMMENT ON COLUMN public.event_dedupe_reviews.status IS
  'pending | linked | created | rejected | expired';

-- updated_at 自動更新
CREATE OR REPLACE FUNCTION public.set_event_dedupe_reviews_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_event_dedupe_reviews_updated_at
  ON public.event_dedupe_reviews;
CREATE TRIGGER trg_event_dedupe_reviews_updated_at
  BEFORE UPDATE ON public.event_dedupe_reviews
  FOR EACH ROW
  EXECUTE FUNCTION public.set_event_dedupe_reviews_updated_at();

-- RLS: anon / authenticated は読み書き不可。service_role のみ利用。
ALTER TABLE public.event_dedupe_reviews ENABLE ROW LEVEL SECURITY;

-- 公開ロールへはポリシーを付けない（= RLS 下で拒否）
REVOKE ALL ON public.event_dedupe_reviews FROM anon, authenticated;
GRANT ALL ON public.event_dedupe_reviews TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.event_dedupe_reviews_id_seq TO service_role;
