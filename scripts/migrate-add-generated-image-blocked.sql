-- generated_image_status に blocked を加える。
-- blocked: 安全ポリシーで画像を作れなかった。画像URLは持たない。
-- 通信エラーや rate limit では none のまま。再試行できる。
-- 適用: Supabase SQL Editor で手動実行する。CASCADE は使わない。

ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_generated_image_status_check;

ALTER TABLE public.events
  ADD CONSTRAINT events_generated_image_status_check
  CHECK (generated_image_status IN ('none', 'pending', 'approved', 'rejected', 'blocked'));

COMMENT ON COLUMN public.events.generated_image_status IS
  'none | pending | approved | rejected | blocked. blocked means a safety policy refusal with no image. Public pages show the image only when approved and no usable official image exists.';

-- event 92 は安全フィルタで画像を作れなかった。画像ファイルは作らない。
UPDATE public.events
SET
  generated_image_status = 'blocked',
  generated_image_url = NULL,
  generated_image_source = NULL,
  updated_at = now()
WHERE id = 92
  AND generated_image_status = 'none'
  AND generated_image_url IS NULL
  AND generated_image_source IS NULL;
