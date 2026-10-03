-- =============================================================================
-- 整理券番号の重複を防ぐ
--
-- 整理券は「施設 × 日本時間の日付」ごとの連番だが、採番が MAX+1 で排他制御が無く、
-- 同じ施設に同時に到着した2台が同じ番号を受け取りうる。
-- 番号は荷主との照合に使うため、重複は DB の制約で拒否する。
--
-- 日付の基準は COALESCE(claimed_at, arrival_time)。
--   - 通常の打刻（等級A）は claimed_at が無く、到着時刻の日付。
--   - 圏外申告を承認した記録（等級C）は、承認時刻ではなく申告した到着日で採番される
--     （approve_pending_punch の採番と同じ基準）。
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS wait_logs_ticket_per_day_uidx
  ON public.wait_logs (
    facility_id,
    ((COALESCE(claimed_at, arrival_time) AT TIME ZONE 'Asia/Tokyo')::date),
    ticket_number
  );

-- issue_ticket: 同時到着で番号が衝突したら、採番をやり直す（最大5回）。
CREATE OR REPLACE FUNCTION public.issue_ticket(
  p_facility_id uuid,
  p_latitude double precision,
  p_longitude double precision
)
RETURNS TABLE(new_ticket_number integer, new_arrival_time timestamp with time zone, log_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  next_num      INTEGER;
  inserted_id   UUID;
  inserted_time TIMESTAMPTZ;
  v_org_id      UUID;
  v_attempt     INTEGER := 0;
BEGIN
  -- [法的保護] GPS座標必須チェック（フロントのフェイルセーフを二重防御）
  IF p_latitude IS NULL OR p_longitude IS NULL THEN
    RAISE EXCEPTION '[法的保護] GPS座標(latitude/longitude)は必須です。'
      USING ERRCODE = 'check_violation';
  END IF;

  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ログインが必要です。' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT p.organization_id INTO v_org_id
  FROM public.profiles p
  WHERE p.user_id = auth.uid();

  LOOP
    v_attempt := v_attempt + 1;
    BEGIN
      -- 当日（JST）の該当施設における最大の整理券番号 + 1
      SELECT COALESCE(MAX(ticket_number), 0) + 1
      INTO next_num
      FROM public.wait_logs
      WHERE facility_id = p_facility_id
        AND (COALESCE(claimed_at, arrival_time) AT TIME ZONE 'Asia/Tokyo')::date
          = (now() AT TIME ZONE 'Asia/Tokyo')::date;

      -- サーバー時刻とGPS座標で INSERT。500mジオフェンスは
      -- enforce_wait_log_geofence トリガーが判定する。
      INSERT INTO public.wait_logs (
        facility_id, user_id, ticket_number, status, arrival_time, latitude, longitude
      )
      VALUES (
        p_facility_id, auth.uid(), next_num, 'waiting', now(), p_latitude, p_longitude
      )
      RETURNING id, arrival_time INTO inserted_id, inserted_time;

      -- arrival エビデンス（recorded_at 等はトリガーがサーバー時刻で上書きする）
      INSERT INTO public.waiting_evidence (
        user_id, organization_id, wait_log_id, evidence_type, latitude, longitude
      )
      VALUES (
        auth.uid(), v_org_id, inserted_id, 'arrival', p_latitude, p_longitude
      );

      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF v_attempt >= 5 THEN
        RAISE EXCEPTION '整理券の発行が混み合っています。もう一度お試しください。'
          USING ERRCODE = 'serialization_failure';
      END IF;
    END;
  END LOOP;

  new_ticket_number := next_num;
  new_arrival_time  := inserted_time;
  log_id            := inserted_id;
  RETURN NEXT;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.issue_ticket(uuid, double precision, double precision) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.issue_ticket(uuid, double precision, double precision) TO authenticated;
