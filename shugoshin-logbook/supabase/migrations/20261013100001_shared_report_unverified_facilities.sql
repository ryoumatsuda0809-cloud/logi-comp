-- =============================================================================
-- 共有帳票に「施設の位置が未確認」であることを載せる
--
-- 20261013100000 で、運送会社の管理者が施設を「未確認」として登録できるようになった。
-- 未確認の施設は、位置を運営者が確認していない。その施設での打刻を、確認済みの
-- 施設と同じ体裁で荷主に見せると、証拠の強さを偽ることになる。
--
-- get_shared_report に unverified_facility_names（その日の打刻のうち、現時点で
-- 未確認の施設の名前）を足す。運営者が確認済みにすれば、次の閲覧から出なくなる。
-- 変えたのはこの1項目だけ。引数・権限・他の戻り値は 20261004110000 と同じ。
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
  v_unverified jsonb;
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
  SELECT COALESCE(jsonb_agg(DISTINCT f.client_name), '[]'::jsonb) INTO v_shippers
  FROM public.wait_logs w
  JOIN public.facilities f ON f.id = w.facility_id
  WHERE w.user_id = v_rep.user_id
    AND w.arrival_time >= (v_rep.report_date::timestamp AT TIME ZONE 'Asia/Tokyo')
    AND w.arrival_time <  ((v_rep.report_date + 1)::timestamp AT TIME ZONE 'Asia/Tokyo')
    AND f.client_name IS NOT NULL;

  -- その日の打刻のうち、現時点で位置が未確認の施設の名前。
  SELECT COALESCE(jsonb_agg(DISTINCT f.name), '[]'::jsonb) INTO v_unverified
  FROM public.wait_logs w
  JOIN public.facilities f ON f.id = w.facility_id
  WHERE w.user_id = v_rep.user_id
    AND w.arrival_time >= (v_rep.report_date::timestamp AT TIME ZONE 'Asia/Tokyo')
    AND w.arrival_time <  ((v_rep.report_date + 1)::timestamp AT TIME ZONE 'Asia/Tokyo')
    AND f.verification_status = 'unverified';

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
    'shipper_names', v_shippers,
    'unverified_facility_names', v_unverified
  );
END;
$$;

-- CREATE OR REPLACE は権限を保つが、明示しておく
REVOKE EXECUTE ON FUNCTION public.get_shared_report(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_shared_report(text) TO anon, authenticated;
