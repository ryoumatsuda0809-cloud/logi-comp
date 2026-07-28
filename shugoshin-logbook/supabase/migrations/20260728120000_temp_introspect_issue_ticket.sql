-- =============================================================================
-- 一時的な調査用関数: issue_ticket の定義を読み取る
--
-- 【目的】
--   issue_ticket はマイグレーション管理外（Supabaseコンソール上）で作成されており、
--   リポジトリ内にソースが存在しない。一方で本番では wait_logs への INSERT が
--   enforce_gps_not_null トリガーに拒否され、到着打刻が機能していない
--   （issue_ticket が latitude / longitude を書き込んでいないため）。
--
--   修正にあたり整理券番号の採番ロジックを壊さないよう、既存定義を正確に取得する。
--
-- 【安全性】
--   - 対象を issue_ticket に限定し、任意の関数定義を読み出せないようにする。
--   - 次のマイグレーション（issue_ticket 本修正）で必ず DROP する。
-- =============================================================================

CREATE OR REPLACE FUNCTION public.__introspect_issue_ticket()
RETURNS TABLE (definition TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pg_get_functiondef(p.oid)
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'issue_ticket';
$$;

COMMENT ON FUNCTION public.__introspect_issue_ticket() IS
  '一時的な調査用。issue_ticket の定義取得のみを目的とし、後続マイグレーションで削除する。';
