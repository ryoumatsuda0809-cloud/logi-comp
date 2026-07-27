-- =============================================================================
-- complete_ticket 修正: 出発GPS座標をwait_logsの保存値ではなく引数で受け取る
--
-- 【問題】
--   complete_ticket は wait_logs.latitude / wait_logs.longitude を読み取って
--   waiting_evidence にそのまま INSERT していたが、issue_ticket 経由で作成された
--   wait_logs 行がこの2カラムに NULL を持つケースがあり、waiting_evidence の
--   NOT NULL 制約（latitude/longitude）に違反して INSERT が失敗していた。
--   これにより「作業完了（出発）」操作が 500 エラーで失敗し、
--   該当の待機ログが status='waiting' のまま永久に残り、ドライバーが
--   新しい到着打刻もできなくなる致命的な詰みが発生していた。
--
-- 【方針】
--   出発時のGPS座標は「到着時の座標を再利用する」のではなく、作業完了操作の
--   その瞬間にドライバー端末から取得した座標を証拠として記録するのが本来の
--   意味的に正しい設計であるため、p_latitude / p_longitude を必須引数として
--   受け取り、wait_logs 側の値には一切依存しないようにする。
--   Rule 2（GPS取得済みでない場合はボタンを物理ロック）が既にフロント側で
--   保証しているため、この2引数は常に非NULLで渡ってくる前提だが、
--   DB側でも [法的保護] チェックを行い二重に防御する。
-- =============================================================================

DROP FUNCTION IF EXISTS public.complete_ticket(UUID, JSONB);

CREATE OR REPLACE FUNCTION public.complete_ticket(
  p_log_id       UUID,
  p_latitude     DOUBLE PRECISION,
  p_longitude    DOUBLE PRECISION,
  p_fishery_data JSONB DEFAULT NULL
)
RETURNS TABLE (
  log_id          UUID,
  completed_at    TIMESTAMPTZ,
  waiting_minutes NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_status  TEXT;
  v_org_id          UUID;
  v_completed_at    TIMESTAMPTZ;
  v_waiting_minutes NUMERIC;
BEGIN
  -- ① [法的保護] GPS座標必須チェック（フロントのフェイルセーフを二重防御）
  IF p_latitude IS NULL OR p_longitude IS NULL THEN
    RAISE EXCEPTION '[法的保護] GPS座標(latitude/longitude)は必須です。'
      USING ERRCODE = 'check_violation';
  END IF;

  -- ② 対象レコードを SELECT FOR UPDATE（同時更新防止・本人確認）
  SELECT wl.status
  INTO v_current_status
  FROM public.wait_logs wl
  WHERE wl.id = p_log_id
    AND wl.user_id = auth.uid()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '待機ログが見つからないか、操作権限がありません。 (log_id: %)', p_log_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- organization_id はドライバーのプロファイルから取得（wait_logs にカラムなし）
  SELECT p.organization_id
  INTO v_org_id
  FROM public.profiles p
  WHERE p.user_id = auth.uid();

  -- ③ ステータス検証（既に completed / cancelled の場合は拒否）
  IF v_current_status NOT IN ('waiting', 'called', 'working') THEN
    RAISE EXCEPTION '打刻完了エラー: ステータス "%" の待機ログは完了処理できません。 (log_id: %)',
      v_current_status, p_log_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- ④ advance_wait_status で status → 'completed'、work_end_time をサーバー時刻で記録
  PERFORM public.advance_wait_status(p_log_id, 'completed');

  v_completed_at := CURRENT_TIMESTAMP;

  -- ⑤ departure エビデンスを INSERT
  --    GPS座標は引数で受け取った「作業完了操作時点」の座標を使用する
  --    （wait_logs の到着時座標には依存しない）
  INSERT INTO public.waiting_evidence (
    user_id,
    organization_id,
    wait_log_id,
    evidence_type,
    latitude,
    longitude,
    completed_at,
    fishery_data
  ) VALUES (
    auth.uid(),
    v_org_id,
    p_log_id,
    'departure',
    p_latitude,
    p_longitude,
    v_completed_at,
    p_fishery_data
  );

  -- ⑥ 更新後の waiting_minutes を取得して返却
  SELECT wl.waiting_minutes
  INTO v_waiting_minutes
  FROM public.wait_logs wl
  WHERE wl.id = p_log_id;

  RETURN QUERY
  SELECT
    p_log_id           AS log_id,
    v_completed_at     AS completed_at,
    v_waiting_minutes  AS waiting_minutes;
END;
$$;

COMMENT ON FUNCTION public.complete_ticket(UUID, DOUBLE PRECISION, DOUBLE PRECISION, JSONB) IS
  '取適法・水産流通適正化法: 到着打刻済みwait_logの作業完了処理を行う。departure evidenceのGPS座標は作業完了操作時点でドライバー端末から取得した座標を使用し、wait_logsの保存値には依存しない。待機時間を自動確定する。時刻はDBサーバー時刻のみを使用する。';
