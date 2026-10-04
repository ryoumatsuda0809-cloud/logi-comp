-- =============================================================================
-- 提出済み日報を、ログインしない荷主へ渡すための共有リンク
--
-- 背景:
--   /shared-report/:id はログイン不要のルートだが、submitted_reports の SELECT は
--   本人のみのため、荷主はリンクを開いても何も取得できなかった（証拠が相手に届かない）。
--
-- 方針:
--   - submitted_reports の SELECT は広げない。閲覧は専用 RPC だけを入口にする。
--   - リンクは推測不能なトークン。DB には SHA-256 のハッシュだけを保存する。
--   - 発行できるのは日報の持ち主のみ。期限付き（既定30日、最大90日）、失効可能。
--   - 公開する項目は帳票に載せるものだけ。user_id・組織IDなどの内部IDは返さない。
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.report_share_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id   uuid NOT NULL REFERENCES public.submitted_reports(id),
  token_hash  text NOT NULL UNIQUE,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  last_viewed_at timestamptz,
  view_count  integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS report_share_links_report_idx ON public.report_share_links (report_id);

-- RPC のみを入口にする（ポリシーなし = 直接の読み書きは誰にもできない）
ALTER TABLE public.report_share_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.report_share_links FROM anon, authenticated;

-- 共有リンクの発行。トークンはここで1度だけ返す（再取得はできない）。
CREATE OR REPLACE FUNCTION public.create_report_share_link(p_report_id uuid, p_days integer DEFAULT 30)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_token text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ログインが必要です。' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 90 THEN
    RAISE EXCEPTION '有効期間は1〜90日で指定してください。' USING ERRCODE = 'check_violation';
  END IF;

  -- 存在しない場合と他人の日報を区別しない
  IF NOT EXISTS (
    SELECT 1 FROM public.submitted_reports WHERE id = p_report_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION '日報が見つからないか、共有する権限がありません。'
      USING ERRCODE = 'no_data_found';
  END IF;

  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO public.report_share_links (report_id, token_hash, created_by, expires_at)
  VALUES (
    p_report_id,
    encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
    auth.uid(),
    now() + make_interval(days => p_days)
  );

  RETURN v_token;
END;
$$;

-- 共有リンクの失効（持ち主のみ）。その日報の有効なリンクをすべて止める。
CREATE OR REPLACE FUNCTION public.revoke_report_share_links(p_report_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_count integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ログインが必要です。' USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.report_share_links
  SET revoked_at = now()
  WHERE report_id = p_report_id
    AND created_by = auth.uid()
    AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- トークンから帳票を取得する。未ログイン（荷主）でも呼べる。
-- 無効・期限切れ・失効はすべて NULL（理由を区別しない）。
CREATE OR REPLACE FUNCTION public.get_shared_report(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_link public.report_share_links%ROWTYPE;
  v_rep  public.submitted_reports%ROWTYPE;
  v_carrier text;
  v_shippers jsonb;
BEGIN
  IF p_token IS NULL OR length(p_token) < 32 OR length(p_token) > 128 THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_link
  FROM public.report_share_links
  WHERE token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
    AND revoked_at IS NULL
    AND expires_at > now();
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_rep FROM public.submitted_reports WHERE id = v_link.report_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE public.report_share_links
  SET last_viewed_at = now(), view_count = view_count + 1
  WHERE id = v_link.id;

  SELECT o.name INTO v_carrier FROM public.organizations o WHERE o.id = v_rep.organization_id;

  SELECT COALESCE(jsonb_agg(DISTINCT f.client_name), '[]'::jsonb) INTO v_shippers
  FROM public.facilities f
  WHERE f.client_name IS NOT NULL
    AND f.name IN (
      SELECT e->>'locationName'
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(v_rep.timeline_snapshot) = 'array' THEN v_rep.timeline_snapshot ELSE '[]'::jsonb END
      ) e
      WHERE e->>'locationName' IS NOT NULL
    );

  RETURN jsonb_build_object(
    'id', v_rep.id,
    'report_date', v_rep.report_date,
    'vehicle_class', v_rep.vehicle_class,
    'total_wait_minutes', v_rep.total_wait_minutes,
    'estimated_wait_cost', v_rep.estimated_wait_cost,
    'formal_report', v_rep.formal_report,
    'has_discrepancy', v_rep.has_discrepancy,
    'timeline_snapshot', v_rep.timeline_snapshot,
    'submitted_at', v_rep.submitted_at,
    'carrier_name', v_carrier,
    'shipper_names', v_shippers
  );
END;
$$;

-- 新しい関数は既定で誰も実行できない（20260806110000 の方針）。必要なロールにだけ付与する。
REVOKE EXECUTE ON FUNCTION public.create_report_share_link(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.revoke_report_share_links(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_shared_report(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_report_share_link(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_report_share_links(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_shared_report(text) TO anon, authenticated;
