-- Seekigo: public.event_field_reviews
-- published イベントのフィールド変更候補（人間レビュー用）。
--
-- 実行: Supabase SQL Editor に貼り付けて実行（このファイル自体は自動実行しない）
-- 前提: public.events.id は bigint
--
-- 方針:
-- - sync は published 本体を変更しない（差分検知のみ）
-- - 採用時のみ admin が対象 field を更新
-- - jsonb の UNIQUE は環境差・表現差で不安定になり得るため proposal_hash を使う

CREATE TABLE IF NOT EXISTS public.event_field_reviews (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  event_id bigint NOT NULL
    REFERENCES public.events (id)
    ON DELETE CASCADE,

  source_name text NOT NULL,
  source_url text,

  field_name text NOT NULL,

  current_value jsonb,
  proposed_value jsonb,

  -- 正規化済み proposed_value の SHA-256（hex）。冪等・履歴スキップ用
  proposal_hash text NOT NULL,

  status text NOT NULL DEFAULT 'pending'
    CHECK (
      status IN (
        'pending',
        'accepted',
        'rejected',
        'expired'
      )
    ),

  reason text,

  decided_by text,
  decided_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- 同一 event / source / field / proposed は履歴含めて1行（reject 後の復活防止）
  CONSTRAINT event_field_reviews_proposal_unique
    UNIQUE (event_id, source_name, field_name, proposal_hash)
);

CREATE INDEX IF NOT EXISTS event_field_reviews_status_idx
  ON public.event_field_reviews (status);

CREATE INDEX IF NOT EXISTS event_field_reviews_event_id_idx
  ON public.event_field_reviews (event_id);

CREATE INDEX IF NOT EXISTS event_field_reviews_pending_event_idx
  ON public.event_field_reviews (event_id, status)
  WHERE status = 'pending';

COMMENT ON TABLE public.event_field_reviews IS
  'Human review queue for published field diffs. Writes via service_role only. Sync never auto-updates events body.';

COMMENT ON COLUMN public.event_field_reviews.proposal_hash IS
  'SHA-256 hex of canonical JSON of normalized proposed_value (avoids fragile jsonb UNIQUE).';

COMMENT ON COLUMN public.event_field_reviews.status IS
  'pending | accepted | rejected | expired';

-- updated_at 自動更新
CREATE OR REPLACE FUNCTION public.set_event_field_reviews_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_event_field_reviews_updated_at
  ON public.event_field_reviews;
CREATE TRIGGER trg_event_field_reviews_updated_at
  BEFORE UPDATE ON public.event_field_reviews
  FOR EACH ROW
  EXECUTE FUNCTION public.set_event_field_reviews_updated_at();

-- RLS: anon / authenticated は読み書き不可。service_role のみ利用。
ALTER TABLE public.event_field_reviews ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.event_field_reviews FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.event_field_reviews TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.event_field_reviews_id_seq TO service_role;
