-- =============================================================================
-- wait_logs の閲覧を「本人」＋「施設の荷主組織の管理者」に限定する
--
-- 【何が起きていたか】
--   本番の wait_logs には SELECT ポリシー "Authenticated users can view wait_logs"
--   (USING true) が存在し、ログイン済みなら誰でも全社の待機記録（GPS座標・時刻・
--   チケット番号）を読めた。マイグレーション履歴には無いポリシーで、
--   docs/PROGRESS_LOG.md の「本人限定の1本のみ」という記述とも食い違っていた。
--
-- 【なぜ単に本人限定へ戻さないか】
--   AdminDashboard は facility_id で wait_logs を引く荷主側の画面で、上記の
--   `true` に依存して表示できていた。本人限定にすると画面が空になるため、
--   facilities と organizations を FK で結び、荷主組織の管理者にだけ読ませる。
--
-- 【バックフィル方針】
--   facilities.client_name（文字列）と organizations.name が「ちょうど1件」一致する
--   施設だけ client_organization_id を埋める。
--     - 一致0件（組織未登録の荷主）: NULL のまま。ドライバー本人にしか見えない。
--     - 一致2件以上（重複組織）: NULL のまま。誤った組織へ権限を与えないため。
--       重複の解消は 20260805100000_merge_duplicate_organizations.sql の領域。
--   曖昧な一致を推測で埋めると、他社の管理者に待機記録を見せる事故になる。
-- =============================================================================

-- STEP 1: FK 列
ALTER TABLE public.facilities
  ADD COLUMN IF NOT EXISTS client_organization_id UUID
    REFERENCES public.organizations(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.facilities.client_organization_id IS
  '施設の荷主組織。wait_logs の荷主側閲覧権限の根拠。client_name との文字列一致は表示用に残すが、権限判定には使わない。NULL=未紐付け（ドライバー本人のみ閲覧可）。';

CREATE INDEX IF NOT EXISTS idx_facilities_client_organization_id
  ON public.facilities(client_organization_id) WHERE client_organization_id IS NOT NULL;

-- STEP 2: 曖昧さのない一致だけバックフィル
UPDATE public.facilities f
SET client_organization_id = m.org_id
FROM (
  SELECT lower(btrim(o.name)) AS norm_name, (array_agg(o.id))[1] AS org_id
  FROM public.organizations o
  GROUP BY lower(btrim(o.name))
  HAVING count(*) = 1
) m
WHERE f.client_organization_id IS NULL
  AND lower(btrim(f.client_name)) = m.norm_name;

-- STEP 3: クライアントから紐付けを書き換えさせない（権限の根拠なので）
REVOKE UPDATE (client_organization_id) ON public.facilities FROM authenticated, anon;
REVOKE INSERT (client_organization_id) ON public.facilities FROM authenticated, anon;

-- STEP 4: 全員閲覧ポリシーを撤去し、限定したポリシーに置き換える
DROP POLICY IF EXISTS "Authenticated users can view wait_logs" ON public.wait_logs;
DROP POLICY IF EXISTS "wait_logs_select_own_or_client_admin" ON public.wait_logs;

CREATE POLICY "wait_logs_select_own_or_client_admin"
  ON public.wait_logs
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.facilities f
      WHERE f.id = wait_logs.facility_id
        AND f.client_organization_id IS NOT NULL
        AND public.has_role_in_org(auth.uid(), f.client_organization_id, 'admin'::public.app_role)
    )
  );
