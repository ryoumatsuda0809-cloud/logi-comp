-- =============================================================================
-- 提出日報は、自分が所属する組織の名義でしか作れない
--
-- 提出後は不変（更新・削除ポリシーとトリガー）だが、INSERT は user_id の一致しか
-- 見ておらず、他組織の organization_id を指定して提出できた。
-- 組織未所属の場合に画面が使う仮の ID（全ゼロ）は引き続き許可する。
--
-- 注: 数値（待機時間・金額）はクライアントが組み立てた値で、サーバー側での再計算は
--     未実装（料率と30分控除の計算を SQL に二重に持つことになるため、別途設計する）。
-- =============================================================================

DROP POLICY IF EXISTS "Users can insert own report" ON public.submitted_reports;

CREATE POLICY "Users can insert own report"
  ON public.submitted_reports
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND (
      organization_id IS NULL
      OR organization_id = '00000000-0000-0000-0000-000000000000'::uuid
      OR public.is_member_of_org(auth.uid(), organization_id)
    )
  );
