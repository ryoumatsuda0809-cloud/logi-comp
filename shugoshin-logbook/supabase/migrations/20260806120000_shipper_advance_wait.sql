-- =============================================================================
-- 荷主組織の管理者が、自社施設の待機を「呼出」「荷役開始」に進める RPC
--
-- 背景:
--   荷主カンバンは advance_wait_status を呼んでいたが、その関数は記録の持ち主
--   （ドライバー）しか操作できないため、荷主側では必ず失敗していた。
--   advance_wait_status は他の関数から呼ばれる内部用に退かせ（20260806110000 で
--   authenticated の EXECUTE を剥奪）、荷主向けは権限判定の違うこの関数に分ける。
--
-- 方針:
--   - 権限: 施設の client_organization_id の admin のみ。
--   - 遷移: waiting → called、waiting/called → working のみ。順方向のみ。
--   - 時刻: サーバー時刻で記録する。クライアントから時刻を受け取らない。
--   - 完了はここでは扱わない。署名とGPSを伴う complete_ticket が確定させる。
-- =============================================================================

CREATE OR REPLACE FUNCTION public.shipper_advance_wait(p_log_id uuid, p_new_status text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_status TEXT;
  v_org_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ログインが必要です。' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_new_status NOT IN ('called', 'working') THEN
    RAISE EXCEPTION 'この操作は荷主側からは行えません。(%)', p_new_status
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT wl.status, f.client_organization_id
  INTO v_status, v_org_id
  FROM public.wait_logs wl
  JOIN public.facilities f ON f.id = wl.facility_id
  WHERE wl.id = p_log_id
  FOR UPDATE OF wl;

  -- 存在しない場合と権限が無い場合を区別しない（他社の記録の存在を示さない）
  IF NOT FOUND
     OR v_org_id IS NULL
     OR NOT public.has_role_in_org(auth.uid(), v_org_id, 'admin'::public.app_role) THEN
    RAISE EXCEPTION '待機ログが見つからないか、操作権限がありません。'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF p_new_status = 'called' AND v_status <> 'waiting' THEN
    RAISE EXCEPTION 'ステータス遷移エラー: % → called は無効です。', v_status
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_new_status = 'working' AND v_status NOT IN ('waiting', 'called') THEN
    RAISE EXCEPTION 'ステータス遷移エラー: % → working は無効です。', v_status
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.wait_logs
  SET status          = p_new_status,
      called_time     = CASE WHEN p_new_status = 'called'  THEN CURRENT_TIMESTAMP ELSE called_time END,
      work_start_time = CASE WHEN p_new_status = 'working' THEN CURRENT_TIMESTAMP ELSE work_start_time END
  WHERE id = p_log_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.shipper_advance_wait(uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.shipper_advance_wait(uuid, text) TO authenticated;
