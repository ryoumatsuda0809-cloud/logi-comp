-- =============================================================================
-- start_loading: ドライバー自身による「荷役開始」打刻
--
-- 【何が壊れていたか】
--   荷待ち時間は wait_logs の到着時刻と「荷待ち終了時刻」の差で算出するが、
--   その終了時刻（called_time / work_start_time）を設定できる経路は
--   advance_wait_status RPC ただ一つで、これを呼ぶのは管理ダッシュボードの
--   呼出／荷役開始ボタンだけだった。
--
--   ところが advance_wait_status は対象を
--     WHERE id = p_log_id AND user_id = auth.uid()
--   に限定しており、**自分のログしか操作できない**。
--   管理ダッシュボードの利用者は facilities.client_name と組織名が一致する
--   荷主側であり、ドライバーとは別ユーザー・別組織のため、ボタンを押しても
--   必ず「待機ログが見つからないか、操作権限がありません」で失敗する。
--   さらに wait_logs の SELECT ポリシーは "user_id = auth.uid()" の1本のみで
--   組織管理者向けのものが存在しないため、そもそも一覧に何も出ない。
--
--   結果として called_time / work_start_time は永久に NULL のままとなり、
--   convertWaitLogsToTimeline は荷待ちイベントを1件も生成せず、
--   **待機料は常に0円**になっていた。取適法対応という本来の目的が
--   成立していない状態であり、影響は極めて大きい。
--
-- 【この migration の位置づけ】
--   荷主側の可視性・操作権限の是正（facilities と organizations が
--   client_name の文字列一致で結ばれている問題を含む）は別途必要だが、
--   それを待たずにドライバー単独で荷待ち時間を確定できるようにする。
--
--   証拠の強さの観点でも妥協ではない。荷役開始はサーバー時刻で記録され、
--   GPS座標も証拠として保存される。これは既に請求根拠として使っている
--   complete_ticket（作業完了）とまったく同じ強度である。
--
-- 【ジオフェンス判定を行わない理由】
--   到着打刻の時点で500m圏内であることは検証済みであり、荷役開始で再度
--   距離判定を課すと、拠点の radius 設定が実態に合っていない現場（広い港湾など）で
--   ドライバーが荷役開始を記録できず待機料を丸ごと失う。
--   座標は証拠として保存するため、事後の監査は可能。
--   なお complete_ticket も同じ理由で距離判定を行っていない。
-- =============================================================================

CREATE OR REPLACE FUNCTION public.start_loading(
  p_log_id    UUID,
  p_latitude  DOUBLE PRECISION,
  p_longitude DOUBLE PRECISION
)
RETURNS TABLE (
  log_id          UUID,
  started_at      TIMESTAMPTZ,
  waiting_minutes NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_status TEXT;
  v_org_id         UUID;
  v_started_at     TIMESTAMPTZ;
  v_arrival        TIMESTAMPTZ;
  v_wait_mins      NUMERIC;
BEGIN
  -- ① [法的保護] GPS座標必須（issue_ticket / complete_ticket と同じ二重防御）
  IF p_latitude IS NULL OR p_longitude IS NULL THEN
    RAISE EXCEPTION '[法的保護] GPS座標(latitude/longitude)は必須です。'
      USING ERRCODE = 'check_violation';
  END IF;

  -- ② 対象レコードをロックして取得（本人確認を兼ねる）
  SELECT wl.status, COALESCE(wl.claimed_at, wl.arrival_time)
  INTO v_current_status, v_arrival
  FROM public.wait_logs wl
  WHERE wl.id = p_log_id
    AND wl.user_id = auth.uid()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '待機ログが見つからないか、操作権限がありません。 (log_id: %)', p_log_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_current_status NOT IN ('waiting', 'called') THEN
    RAISE EXCEPTION '荷役開始エラー: ステータス "%" の待機ログには荷役開始を記録できません。 (log_id: %)',
      v_current_status, p_log_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- ③ status → 'working'、work_start_time をサーバー時刻で記録。
  --    時刻の付与は advance_wait_status に集約されており、
  --    クライアントから時刻を受け取る経路は存在しない。
  PERFORM public.advance_wait_status(p_log_id, 'working');

  v_started_at := CURRENT_TIMESTAMP;

  SELECT p.organization_id
  INTO v_org_id
  FROM public.profiles p
  WHERE p.user_id = auth.uid();

  -- ④ 荷役開始地点をエビデンスとして記録する。
  --    荷待ち時間の終端＝課金対象の境界となる時刻なので、
  --    その時点の位置を証拠として残す。
  INSERT INTO public.waiting_evidence (
    user_id, organization_id, wait_log_id, evidence_type, latitude, longitude, note
  ) VALUES (
    auth.uid(), v_org_id, p_log_id, 'gps_checkpoint', p_latitude, p_longitude,
    '荷役開始（荷待ち時間の終端）'
  );

  -- ⑤ 確定した荷待ち時間を返す（到着〜荷役開始）
  v_wait_mins := ROUND(EXTRACT(EPOCH FROM (v_started_at - v_arrival)) / 60, 1);

  RETURN QUERY SELECT p_log_id, v_started_at, GREATEST(v_wait_mins, 0);
END;
$$;

COMMENT ON FUNCTION public.start_loading IS
  '取適法: ドライバー自身が荷役開始を記録し、荷待ち時間（到着〜荷役開始）を確定する。work_start_timeはサーバー時刻で付与し、荷役開始地点のGPS座標をエビデンスとして保存する。';

REVOKE ALL ON FUNCTION public.start_loading FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_loading TO authenticated;
