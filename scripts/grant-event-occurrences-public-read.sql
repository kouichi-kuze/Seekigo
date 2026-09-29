-- Seekigo: 公開詳細ページが event_occurrences を読めるようにする。
--
-- 実行: Supabase SQL Editor に貼り付けて手動実行（このファイルは自動実行しない）
-- INSERT / UPDATE / DELETE は service_role のまま。anon には SELECT だけ。
-- published の親イベントに紐づく行だけ読める。

GRANT SELECT ON public.event_occurrences TO anon, authenticated;

DROP POLICY IF EXISTS "event_occurrences_select_published"
  ON public.event_occurrences;

CREATE POLICY "event_occurrences_select_published"
  ON public.event_occurrences
  FOR SELECT
  TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.events AS parent
      WHERE parent.id = event_occurrences.event_id
        AND parent.status = 'published'
    )
  );
