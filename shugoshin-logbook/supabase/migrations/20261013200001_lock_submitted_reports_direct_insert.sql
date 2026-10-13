-- =============================================================================
-- submitted_reports への直接 INSERT を剥奪する（日報の提出は submit_daily_report のみ）
--
-- 【適用順序（重要）】新しいフロント（submit_daily_report を呼ぶ画面）をデプロイした「後」に適用する。
--   先に適用すると、旧い画面の日報の提出が失敗する。
--   戻す場合: GRANT INSERT ON public.submitted_reports TO authenticated;
--             CREATE POLICY "Users can insert own report" ON public.submitted_reports FOR INSERT TO authenticated
--               WITH CHECK (user_id = auth.uid() AND (organization_id IS NULL
--                 OR organization_id = '00000000-0000-0000-0000-000000000000'::uuid
--                 OR public.is_member_of_org(auth.uid(), organization_id)));
-- =============================================================================

-- ---------------------------------------------------------------------------
-- STEP 6: submitted_reports への直接 INSERT を剥奪する
--   提出は submit_daily_report だけ。SELECT は残す（本人の閲覧）。
--   更新・削除は RESTRICTIVE ポリシーとトリガーで引き続き禁止。
--   anon には何も付けない（これまでは表の権限だけ付いていた）。
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.submitted_reports FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.submitted_reports FROM authenticated;

-- INSERT のポリシーは不要になった（権限が無いので使われない）。残すと「直接 INSERT できる」と読める。
DROP POLICY IF EXISTS "Users can insert own report" ON public.submitted_reports;
DROP POLICY IF EXISTS "Users can insert own submitted reports" ON public.submitted_reports;
