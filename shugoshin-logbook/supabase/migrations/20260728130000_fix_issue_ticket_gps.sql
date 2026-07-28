-- =============================================================================
-- issue_ticket 修正: 到着GPS座標の記録と arrival エビデンスの生成
--
-- 【問題】
--   issue_ticket は wait_logs へ INSERT する際に latitude / longitude を
--   一切書き込んでいなかった。一方 20260414000004 で追加された
--   enforce_gps_not_null トリガーが wait_logs の GPS NULL を拒否するため、
--   本番では到着打刻が必ず失敗していた:
--     [法的保護] GPS座標 (latitude/longitude) は必須です。テーブル: wait_logs
--
--   結果として、当該トリガー導入（2026-04-14）以降、新規の到着打刻が
--   一件も記録できない状態が続いていた。取適法上の待機記録が取得不能であり、
--   アプリの中核機能が停止していたことを意味する。
--
-- 【あわせて判明した点】
--   旧 issue_ticket にはジオフェンス判定が存在しなかった。
--   （ドキュメント上は「500m圏外は RAISE EXCEPTION」とされていたが未実装で、
--     実際の距離判定は get_nearest_facility の絞り込みのみ＝クライアント経由で
--     迂回可能だった。）
--   20260720130000 で追加した enforce_wait_log_geofence トリガーが
--   サーバーサイドの唯一の距離検証だが、座標が NULL のままでは判定不能なため、
--   本修正により初めて実効性を持つ。
--
-- 【対策】
--   1. p_latitude / p_longitude を必須引数として受け取り wait_logs に記録する。
--      整理券番号の採番ロジック（施設単位・JST日単位で MAX+1）は既存挙動を維持する。
--   2. arrival の waiting_evidence 行を生成する。
--      waiting_evidence は署名・削除禁止トリガーで保護された証拠テーブルであり、
--      到着時のGPSをここに残すことで complete_ticket の署名確定
--      （is_signed = true）が到着・出発の双方を対象にできるようになる。
--   3. SECURITY DEFINER 関数として search_path を固定する（旧定義では未設定）。
-- =============================================================================

DROP FUNCTION IF EXISTS public.issue_ticket(UUID);

CREATE OR REPLACE FUNCTION public.issue_ticket(
  p_facility_id UUID,
  p_latitude    DOUBLE PRECISION,
  p_longitude   DOUBLE PRECISION
)
RETURNS TABLE (
  new_ticket_number INTEGER,
  new_arrival_time  TIMESTAMPTZ,
  log_id            UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_num      INTEGER;
  inserted_id   UUID;
  inserted_time TIMESTAMPTZ;
  v_org_id      UUID;
BEGIN
  -- ① [法的保護] GPS座標必須チェック（フロントのフェイルセーフを二重防御）
  IF p_latitude IS NULL OR p_longitude IS NULL THEN
    RAISE EXCEPTION '[法的保護] GPS座標(latitude/longitude)は必須です。'
      USING ERRCODE = 'check_violation';
  END IF;

  -- ② 当日（JST）の該当施設における最大の整理券番号を取得し +1 する（既存挙動を維持）
  SELECT COALESCE(MAX(ticket_number), 0) + 1
  INTO next_num
  FROM public.wait_logs
  WHERE facility_id = p_facility_id
    AND DATE(arrival_time AT TIME ZONE 'Asia/Tokyo') = DATE(now() AT TIME ZONE 'Asia/Tokyo');

  -- ③ サーバー時刻とGPS座標で wait_logs を INSERT
  --    500mジオフェンス判定は enforce_wait_log_geofence トリガーが行う。
  INSERT INTO public.wait_logs (
    facility_id, user_id, ticket_number, status, arrival_time, latitude, longitude
  )
  VALUES (
    p_facility_id, auth.uid(), next_num, 'waiting', now(), p_latitude, p_longitude
  )
  RETURNING id, arrival_time INTO inserted_id, inserted_time;

  -- ④ arrival エビデンスを waiting_evidence に記録する。
  --    recorded_at / created_at は force_waiting_evidence_timestamps トリガーが
  --    サーバー時刻で強制上書きするため、ここでは指定しない。
  SELECT p.organization_id
  INTO v_org_id
  FROM public.profiles p
  WHERE p.user_id = auth.uid();

  INSERT INTO public.waiting_evidence (
    user_id, organization_id, wait_log_id, evidence_type, latitude, longitude
  )
  VALUES (
    auth.uid(), v_org_id, inserted_id, 'arrival', p_latitude, p_longitude
  );

  -- ⑤ フロントエンドへ結果を返す
  new_ticket_number := next_num;
  new_arrival_time  := inserted_time;
  log_id            := inserted_id;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.issue_ticket(UUID, DOUBLE PRECISION, DOUBLE PRECISION) IS
  '取適法: 到着打刻を発行する。GPS座標を wait_logs と waiting_evidence(arrival) の双方に記録し、時刻はDBサーバー時刻のみを使用する。500mジオフェンス判定は enforce_wait_log_geofence トリガーが担う。';

-- ---------------------------------------------------------------------------
-- 調査用に一時作成した関数を削除する（20260728120000 で作成）
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.__introspect_issue_ticket();
