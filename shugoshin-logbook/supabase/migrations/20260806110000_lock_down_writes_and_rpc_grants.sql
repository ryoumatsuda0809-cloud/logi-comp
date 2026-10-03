-- =============================================================================
-- 書き込み経路の絞り込みと、関数の EXECUTE 権限の整理
--
-- 方針（CLAUDE.md Rule 1）:
--   証拠テーブルへの書き込みは SECURITY DEFINER の RPC だけを入口にする。
--   これまではポリシーで守っていたが、Supabase は authenticated にテーブル単位の
--   権限を既定で付与するため、列単位の REVOKE が効かない箇所があった。
--   そこで、テーブル単位で権限を外す。RLS は二重防御として残す。
--
-- 前提の確認:
--   - フロントは wait_logs / waiting_evidence / pending_punches / facilities /
--     organizations へ直接書き込まない（RPC 経由のみ）。
--   - 関数・テーブルの所有者は postgres。SECURITY DEFINER 関数は所有者権限で動くため、
--     authenticated から権限を外しても正規のフロー（issue_ticket 等）は影響を受けない。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- STEP 1: 証拠系テーブルは直接書き込み不可（読み取りのみ）
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.wait_logs, public.waiting_evidence, public.pending_punches FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.wait_logs, public.waiting_evidence, public.pending_punches FROM authenticated;

-- 施設マスタ・組織の作成は直接書き込み不可
REVOKE ALL ON public.facilities FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.facilities FROM authenticated;
REVOKE INSERT ON public.organizations FROM anon, authenticated;

-- 旧テーブル。確定後に書き換えられる経路を残さない
REVOKE UPDATE, DELETE, TRUNCATE ON public.compliance_logs FROM authenticated;

-- ---------------------------------------------------------------------------
-- STEP 2: 関数の EXECUTE 権限
--   いったん全員から外し、アプリが呼ぶものだけ authenticated に付与する。
--   拡張が持つ関数（PostGIS 等）は対象外。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
  END LOOP;

  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY (ARRAY[
        -- 打刻
        'get_nearest_facility', 'issue_ticket', 'start_loading', 'complete_ticket', 'cancel_ticket',
        -- 圏外の仮記録と承認
        'queue_offline_punch', 'approve_pending_punch', 'reject_pending_punch',
        -- 組織
        'create_organization_with_admin', 'join_organization_by_invite_code',
        'create_invite_code', 'deactivate_invite_code', 'verify_company_name',
        -- RLS ポリシーの評価で呼ばれる
        'has_role', 'has_role_in_org', 'is_member_of_org', 'get_user_org_id'
      ])
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.sig);
  END LOOP;
END $$;

-- 今後作る関数は、明示的に GRANT するまで誰も実行できない
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- STEP 3: 不要になったポリシーと関数の撤去
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can insert their own wait_logs" ON public.wait_logs;
DROP POLICY IF EXISTS "Users can insert own wait logs" ON public.wait_logs;
DROP POLICY IF EXISTS "waiting_evidence_insert" ON public.waiting_evidence;
DROP POLICY IF EXISTS "waiting_evidence_update" ON public.waiting_evidence;
DROP POLICY IF EXISTS "New users can create initial org" ON public.organizations;

-- 定義がリポジトリに無く、現行スキーマに存在しない列を参照する旧関数
DROP FUNCTION IF EXISTS public.force_join_organization_by_invite_code(text);
