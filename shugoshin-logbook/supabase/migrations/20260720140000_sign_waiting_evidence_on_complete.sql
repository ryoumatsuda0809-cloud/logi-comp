-- =============================================================================
-- waiting_evidence の署名（is_signed）を complete_ticket 完了時に確定する
--
-- 【問題】
--   waiting_evidence テーブルは is_signed = true になった行の変更・削除を
--   全ロールで禁止する「改ざん防止」の仕組み（trg_guard_waiting_evidence_update）
--   を備えているが、is_signed を true にセットするコードがアプリ全体に
--   一箇所も存在しなかった。
--
--   その結果、全ての waiting_evidence 行は永久に is_signed = false のままであり、
--   RLS の UPDATE ポリシー (user_id = auth.uid() AND is_signed = false) により
--   ドライバー本人が自分のGPS座標・水産物情報をいつでも書き換えられる状態だった。
--   これは CLAUDE.md Rule 1／CONTEXT_LEGAL_SPEC.md が要求する
--   「待機時間の記録を不変（Immutable）に保つ」という要件を実質的に無効化していた。
--
-- 【対策】
--   complete_ticket（= その待機セッションの記録が完全に確定する瞬間）で、
--   同じ wait_log_id に紐づく waiting_evidence 行（到着・出発の両方）を
--   is_signed = true に更新し、以後の改ざんを不可能にする。
-- =============================================================================

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

  -- ⑥ [法的保護] この待機セッションに紐づく全エビデンス（到着・出発）を署名確定する。
  --    is_signed = true になった行は trg_guard_waiting_evidence_update により
  --    以後の変更が全ロールで禁止されるため、ここで初めて「改ざん不可能な記録」となる。
  UPDATE public.waiting_evidence
  SET is_signed = true
  WHERE wait_log_id = p_log_id
    AND user_id = auth.uid()
    AND is_signed = false;

  -- ⑦ 更新後の waiting_minutes を取得して返却
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
  '取適法・水産流通適正化法: 到着打刻済みwait_logの作業完了処理を行う。departure evidenceのGPS座標は作業完了操作時点でドライバー端末から取得した座標を使用する。完了と同時に、この待機セッションに紐づく全waiting_evidence行（到着・出発）をis_signed=trueにして改ざん不可能な状態に確定する。待機時間を自動確定する。時刻はDBサーバー時刻のみを使用する。';
