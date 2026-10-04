-- =============================================================================
-- 共有帳票の荷主名を、施設名ではなく施設IDで引く（R4）
--
-- get_shared_report は、帳票のスナップショットにある施設名で facilities を
-- 照合して荷主名を出していた。施設は全社共通のマスタなので、同名の施設
-- （例:「本社倉庫」）があると、関係のない荷主名が相手に渡る帳票に載る。
-- 提出者がその日に打刻した wait_logs の施設IDから引くように直す。
-- 打刻はサーバーが記録したものなので、帳票の中身に左右されない。
--
-- 変えたのは荷主名の取り出し方だけ。引数・戻り値・権限は 20260807100000 と同じ。
-- =============================================================================

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

  -- 荷主名は、提出者がその日（日本時間）に打刻した記録の施設IDから引く。
  -- 以前は帳票のスナップショットにある施設「名」で照合していたため、
  -- 同名の施設があると関係のない荷主名が帳票に載った。
  SELECT COALESCE(jsonb_agg(DISTINCT f.client_name), '[]'::jsonb) INTO v_shippers
  FROM public.wait_logs w
  JOIN public.facilities f ON f.id = w.facility_id
  WHERE w.user_id = v_rep.user_id
    AND w.arrival_time >= (v_rep.report_date::timestamp AT TIME ZONE 'Asia/Tokyo')
    AND w.arrival_time <  ((v_rep.report_date + 1)::timestamp AT TIME ZONE 'Asia/Tokyo')
    AND f.client_name IS NOT NULL;

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

-- CREATE OR REPLACE は権限を保つが、明示しておく
REVOKE EXECUTE ON FUNCTION public.get_shared_report(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_shared_report(text) TO anon, authenticated;
