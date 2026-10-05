-- =============================================================================
-- 運送会社の管理者が、自組織のドライバーの待機記録を読めるようにする
--
-- これまでの閲覧範囲: 本人 ／ 施設の荷主組織の admin
-- 追加: ドライバーが所属する運送会社（profiles.organization_id）の admin
--
-- 目的: 月次帳票（monthly_wait_risk_reports は security_invoker）が、管理者に
--       自組織の全ドライバー分を集計して返せるようにする。
--       他社のドライバーの記録は、これまでどおり読めない。
-- =============================================================================

DROP POLICY IF EXISTS "wait_logs_select_own_or_client_admin" ON public.wait_logs;
DROP POLICY IF EXISTS "wait_logs_select_scoped" ON public.wait_logs;

CREATE POLICY "wait_logs_select_scoped"
  ON public.wait_logs
  FOR SELECT
  TO authenticated
  USING (
    -- ① 本人
    user_id = auth.uid()
    -- ② 施設の荷主組織の管理者
    OR EXISTS (
      SELECT 1
      FROM public.facilities f
      WHERE f.id = wait_logs.facility_id
        AND f.client_organization_id IS NOT NULL
        AND public.has_role_in_org(auth.uid(), f.client_organization_id, 'admin'::public.app_role)
    )
    -- ③ ドライバーが所属する運送会社の管理者
    OR EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.user_id = wait_logs.user_id
        AND p.organization_id IS NOT NULL
        AND public.has_role_in_org(auth.uid(), p.organization_id, 'admin'::public.app_role)
    )
  );
