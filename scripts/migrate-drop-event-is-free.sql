-- events.is_free を削除する。料金の正データは price_type。
-- アプリからの読み書きが0になったあとに実行する。
-- CASCADE は使わない。依存があるときは実行しない。
-- 過去の Field Review 行は残す。

ALTER TABLE public.events
  DROP COLUMN is_free;
