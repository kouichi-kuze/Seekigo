-- Seekigo Phase 4C-6: event free-text translations + reaction summary translations
--
-- 実行: Supabase SQL Editor に貼り付けて実行（このファイル自体は自動実行しない）
-- 方針:
-- - 日本語 events 本体カラムは変更しない
-- - 英訳は別テーブル。AI 生成は draft。自動 Publish しない
-- - 公開 SELECT は published のみ

-- ─── event_translations ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.event_translations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  event_id bigint NOT NULL
    REFERENCES public.events (id)
    ON DELETE CASCADE,

  locale text NOT NULL
    CHECK (char_length(locale) >= 2 AND char_length(locale) <= 8),

  title text,
  summary text,
  access_text text,
  price_text text,
  age_note text,
  parking_text text,

  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'hidden')),

  generated_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT event_translations_event_locale_unique
    UNIQUE (event_id, locale)
);

CREATE INDEX IF NOT EXISTS event_translations_status_idx
  ON public.event_translations (status);

CREATE INDEX IF NOT EXISTS event_translations_published_event_idx
  ON public.event_translations (event_id)
  WHERE status = 'published';

COMMENT ON TABLE public.event_translations IS
  'Localized free-text fields for events (e.g. en). Separate from JA events columns. Human review before publish.';

COMMENT ON COLUMN public.event_translations.locale IS
  'BCP47-ish locale code. v1 uses en; zh/ko possible later.';

COMMENT ON COLUMN public.event_translations.status IS
  'draft | published | hidden. AI output starts as draft; never auto-publish.';

CREATE OR REPLACE FUNCTION public.set_event_translations_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_event_translations_updated_at
  ON public.event_translations;
CREATE TRIGGER trg_event_translations_updated_at
  BEFORE UPDATE ON public.event_translations
  FOR EACH ROW
  EXECUTE FUNCTION public.set_event_translations_updated_at();

-- ─── event_reaction_summary_translations ──────────────────────

CREATE TABLE IF NOT EXISTS public.event_reaction_summary_translations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  summary_id bigint NOT NULL
    REFERENCES public.event_reaction_summaries (id)
    ON DELETE CASCADE,

  locale text NOT NULL
    CHECK (char_length(locale) >= 2 AND char_length(locale) <= 8),

  summary_bullets jsonb NOT NULL DEFAULT '[]'::jsonb,

  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'hidden')),

  generated_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT event_reaction_summary_translations_unique
    UNIQUE (summary_id, locale),

  CONSTRAINT event_reaction_summary_translations_bullets_is_array
    CHECK (jsonb_typeof(summary_bullets) = 'array')
);

CREATE INDEX IF NOT EXISTS event_reaction_summary_translations_status_idx
  ON public.event_reaction_summary_translations (status);

CREATE INDEX IF NOT EXISTS event_reaction_summary_translations_published_idx
  ON public.event_reaction_summary_translations (summary_id)
  WHERE status = 'published';

COMMENT ON TABLE public.event_reaction_summary_translations IS
  'Localized reaction summary bullets. Translate reviewed JA bullets; do not re-summarize raw sources.';

CREATE OR REPLACE FUNCTION public.set_event_reaction_summary_translations_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_event_reaction_summary_translations_updated_at
  ON public.event_reaction_summary_translations;
CREATE TRIGGER trg_event_reaction_summary_translations_updated_at
  BEFORE UPDATE ON public.event_reaction_summary_translations
  FOR EACH ROW
  EXECUTE FUNCTION public.set_event_reaction_summary_translations_updated_at();
