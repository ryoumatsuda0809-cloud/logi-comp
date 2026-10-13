-- =============================================================================
-- API ロール（anon / authenticated）から TRUNCATE 権限を外す
--
-- なぜ:
--   Supabase は public のテーブルに anon / authenticated へ TRUNCATE を含む権限を
--   既定で付ける。TRUNCATE は行トリガーも RLS も通らないため、`transport_orders` には
--   これを止めるものが無かった（STATUS.md 2026-10-10 の点検）。
--   `submitted_reports` と `waiting_evidence` には文単位の BEFORE TRUNCATE トリガーが
--   あるが、権限そのものを外すほうが確実なので、API ロールからは一括で外す。
--
-- 影響:
--   - Supabase の REST API は TRUNCATE を発行できないため、アプリの動作は変わらない。
--   - 所有者（postgres）と service_role の権限は変えない。マイグレーションや
--     管理作業での TRUNCATE はこれまでどおり行える。
--   - 拡張が持つテーブル（PostGIS の spatial_ref_sys など）は対象外。
--
-- 検査: supabase/tests/security_checks.sql に「TRUNCATE が付いたテーブルが無い」確認を追加した。
-- 戻し方（必要になった場合のみ）:
--   GRANT TRUNCATE ON public.<table> TO anon, authenticated;
-- =============================================================================

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS tbl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE TRUNCATE ON TABLE %s FROM PUBLIC, anon, authenticated', r.tbl);
  END LOOP;
END $$;
