-- Seekigo Phase 4A: SNS・Web 反応要約
--
-- 実行: Supabase SQL Editor に貼り付けて実行（このファイル自体は自動実行しない）
-- 前提: public.events.id は bigint
--
-- 方針:
-- - 公開画面は published の要約のみ（第三者投稿本文は転載しない）
-- - excerpt_for_internal_review は管理画面確認用。anon からは読めない
-- - AI 生成後は status=draft。自動公開しない
-- - イベントあたり要約は1行（UNIQUE event_id）。履歴が必要になったら Phase 4B 以降で拡張

-- ─── event_reaction_summaries ─────────────────────────────────

CREATE TABLE IF NOT EXISTS public.event_reaction_summaries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  event_id bigint NOT NULL
    REFERENCES public.events (id)
    ON DELETE CASCADE,

  -- 公開用の短い傾向文（配列）。断定せず「〜という反応 / 傾向」表現を想定
  summary_bullets jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- 例: {
  --   "crowd_level": "high"|"medium"|"low"|null,
  --   "family": true|false|null,
  --   "date": true|false|null,
  --   "solo": true|false|null,
  --   "photo": true|false|null,
  --   "rain": true|false|null,
  --   "wait_time": "long"|"medium"|"short"|null,
  --   "recommended_time": "夕方"|null
  -- }
  signals jsonb NOT NULL DEFAULT '{}'::jsonb,

  source_count integer NOT NULL DEFAULT 0
    CHECK (source_count >= 0),

  confidence text NOT NULL DEFAULT 'low'
    CHECK (confidence IN ('low', 'medium', 'high')),

  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'reviewed', 'published', 'hidden')),

  generated_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT event_reaction_summaries_event_unique
    UNIQUE (event_id),

  CONSTRAINT event_reaction_summaries_bullets_is_array
    CHECK (jsonb_typeof(summary_bullets) = 'array'),

  CONSTRAINT event_reaction_summaries_signals_is_object
    CHECK (jsonb_typeof(signals) = 'object')
);

CREATE INDEX IF NOT EXISTS event_reaction_summaries_status_idx
  ON public.event_reaction_summaries (status);

CREATE INDEX IF NOT EXISTS event_reaction_summaries_published_event_idx
  ON public.event_reaction_summaries (event_id)
  WHERE status = 'published';

COMMENT ON TABLE public.event_reaction_summaries IS
  'Seekigo tendency summary of public SNS/Web reactions per event. Not a dump of third-party posts. Human review before publish.';

COMMENT ON COLUMN public.event_reaction_summaries.summary_bullets IS
  'JSON array of short tendency phrases for public display.';

COMMENT ON COLUMN public.event_reaction_summaries.signals IS
  'JSON object of soft signals (crowd/family/date/solo/photo/rain/wait/recommended_time).';

COMMENT ON COLUMN public.event_reaction_summaries.status IS
  'draft | reviewed | published | hidden. AI output starts as draft; never auto-publish.';

CREATE OR REPLACE FUNCTION public.set_event_reaction_summaries_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_event_reaction_summaries_updated_at
  ON public.event_reaction_summaries;
CREATE TRIGGER trg_event_reaction_summaries_updated_at
  BEFORE UPDATE ON public.event_reaction_summaries
  FOR EACH ROW
  EXECUTE FUNCTION public.set_event_reaction_summaries_updated_at();

-- ─── event_reaction_sources ───────────────────────────────────

CREATE TABLE IF NOT EXISTS public.event_reaction_sources (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  event_id bigint NOT NULL
    REFERENCES public.events (id)
    ON DELETE CASCADE,

  summary_id bigint NOT NULL
    REFERENCES public.event_reaction_summaries (id)
    ON DELETE CASCADE,

  source_type text NOT NULL
    CHECK (
      source_type IN (
        'x',
        'instagram',
        'web',
        'blog',
        'news',
        'other',
        'official_web',
        'rss',
        'press_release',
        'other_web'
      )
    ),

  source_url text,
  source_name text,

  observed_at timestamptz,

  -- 管理画面の根拠確認用のみ。公開ページでは出さない
  excerpt_for_internal_review text,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_reaction_sources_summary_id_idx
  ON public.event_reaction_sources (summary_id);

CREATE INDEX IF NOT EXISTS event_reaction_sources_event_id_idx
  ON public.event_reaction_sources (event_id);

COMMENT ON TABLE public.event_reaction_sources IS
  'Provenance for reaction summaries. Excerpts are admin-only; never render raw posts on the public site.';

COMMENT ON COLUMN public.event_reaction_sources.excerpt_for_internal_review IS
  'Short internal snippet for human review. Do not expose to anon or public UI.';

-- ─── RLS / grants ─────────────────────────────────────────────

ALTER TABLE public.event_reaction_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_reaction_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "event_reaction_summaries_select_published"
  ON public.event_reaction_summaries;
CREATE POLICY "event_reaction_summaries_select_published"
  ON public.event_reaction_summaries
  FOR SELECT
  TO anon, authenticated
  USING (status = 'published');

-- sources: 公開ロールは読めない（excerpt 保護）
DROP POLICY IF EXISTS "event_reaction_sources_no_select_public"
  ON public.event_reaction_sources;

REVOKE ALL ON public.event_reaction_summaries FROM anon, authenticated;
REVOKE ALL ON public.event_reaction_sources FROM anon, authenticated;

GRANT SELECT ON public.event_reaction_summaries TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_reaction_summaries TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.event_reaction_summaries_id_seq TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_reaction_sources TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.event_reaction_sources_id_seq TO service_role;
