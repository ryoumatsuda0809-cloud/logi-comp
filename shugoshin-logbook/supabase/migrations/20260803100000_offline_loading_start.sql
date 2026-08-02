-- =============================================================================
-- 圏外での「荷役開始」申請（オフライン打刻の穴埋め）
--
-- 【なぜ必要か】
--   20260731110000 で荷待ち時間の終端を「荷役開始」に変更した。これにより
--   荷役開始が待機料の課金境界そのものになったが、pending_punches.punch_type は
--   'arrival' / 'completion' しか許可しておらず、**圏外では荷役開始を記録できない**。
--
--   到着と作業完了だけを圏外申請できても、荷役開始が欠けると
--   loadingStartedAt() が終端を決められず、その待機の待機料は0円になる。
--   圏外救済の穴として最も影響が大きいのがここ。
--
-- 【時刻の扱い】
--   決定②（証拠カラムはサーバー時刻のまま据え置き、主張時刻は別カラム）に従い、
--   work_start_time には承認処理を行ったサーバー時刻が入る。ドライバーが主張する
--   荷役開始時刻は claimed_loading_at に保持し、荷待ち時間の算定はそちらを見る。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- STEP 1: punch_type に 'loading_start' を追加
-- ---------------------------------------------------------------------------
ALTER TABLE public.pending_punches
  DROP CONSTRAINT IF EXISTS pending_punches_punch_type_check;

ALTER TABLE public.pending_punches
  ADD CONSTRAINT pending_punches_punch_type_check
  CHECK (punch_type IN ('arrival', 'loading_start', 'completion'));

-- ---------------------------------------------------------------------------
-- STEP 2: wait_logs に主張荷役開始時刻を追加
-- ---------------------------------------------------------------------------
ALTER TABLE public.wait_logs
  ADD COLUMN IF NOT EXISTS claimed_loading_at TIMESTAMPTZ;

COMMENT ON COLUMN public.wait_logs.claimed_loading_at IS
  '等級Cのみ。ドライバーが主張する荷役開始時刻（検証不能）。work_start_time は承認処理を行ったサーバー時刻であり、実際の荷役開始時刻ではない。荷待ち時間の終端はこちらを見る。';

REVOKE UPDATE (claimed_loading_at) ON public.wait_logs FROM authenticated;

-- ---------------------------------------------------------------------------
-- STEP 3: queue_offline_punch を 'loading_start' 対応に更新
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.queue_offline_punch(
  p_claimed_at  TIMESTAMPTZ,
  p_latitude    DOUBLE PRECISION,
  p_longitude   DOUBLE PRECISION,
  p_client_punch_id UUID,
  p_punch_type  TEXT DEFAULT 'arrival',
  p_accuracy_m  DOUBLE PRECISION DEFAULT NULL,
  p_note        TEXT DEFAULT NULL,
  p_wait_log_id UUID DEFAULT NULL,
  p_fishery_data JSONB DEFAULT NULL
)
RETURNS TABLE (
  punch_id        UUID,
  facility_name   TEXT,
  distance_m      DOUBLE PRECISION,
  within_geofence BOOLEAN,
  is_duplicate    BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id      UUID := auth.uid();
  v_org_id       UUID;
  v_facility_id  UUID;
  v_facility_nm  TEXT;
  v_distance_m   DOUBLE PRECISION;
  v_radius       INTEGER;
  v_within       BOOLEAN;
  v_existing_id  UUID;
  v_inserted_id  UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ログインが必要です。' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_latitude IS NULL OR p_longitude IS NULL THEN
    RAISE EXCEPTION '[法的保護] GPS座標(latitude/longitude)は必須です。'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_punch_type NOT IN ('arrival', 'loading_start', 'completion') THEN
    RAISE EXCEPTION '打刻種別が不正です。 (punch_type: %)', p_punch_type
      USING ERRCODE = 'check_violation';
  END IF;

  -- 到着以外は対象の待機ログが必須
  IF p_punch_type <> 'arrival' AND p_wait_log_id IS NULL THEN
    RAISE EXCEPTION '対象の待機ログが指定されていません。 (punch_type: %)', p_punch_type
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_claimed_at > CURRENT_TIMESTAMP + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION '[法的保護] 未来の時刻は申請できません。端末の時刻設定を確認してください。'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_claimed_at < CURRENT_TIMESTAMP - INTERVAL '30 days' THEN
    RAISE EXCEPTION '[法的保護] 30日を超える過去の打刻は申請できません。 (claimed_at: %)', p_claimed_at
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT pp.id INTO v_existing_id
  FROM public.pending_punches pp
  WHERE pp.user_id = v_user_id
    AND pp.client_punch_id = p_client_punch_id;

  IF FOUND THEN
    RETURN QUERY
    SELECT pp.id, f.name, pp.distance_m, pp.within_geofence, true
    FROM public.pending_punches pp
    LEFT JOIN public.facilities f ON f.id = pp.facility_id
    WHERE pp.id = v_existing_id;
    RETURN;
  END IF;

  SELECT f.id, f.name, f.radius,
         6371000 * 2 * asin(sqrt(
           sin(radians(f.lat - p_latitude) / 2) ^ 2 +
           cos(radians(p_latitude)) * cos(radians(f.lat)) *
           sin(radians(f.lng - p_longitude) / 2) ^ 2
         ))
  INTO v_facility_id, v_facility_nm, v_radius, v_distance_m
  FROM public.facilities f
  ORDER BY 4 ASC
  LIMIT 1;

  v_within := CASE
    WHEN v_facility_id IS NULL THEN NULL
    ELSE v_distance_m <= v_radius
  END;

  SELECT p.organization_id INTO v_org_id
  FROM public.profiles p
  WHERE p.user_id = v_user_id;

  INSERT INTO public.pending_punches (
    user_id, organization_id, facility_id, punch_type, wait_log_id,
    claimed_at, latitude, longitude, gps_accuracy_m,
    distance_m, within_geofence, driver_note, fishery_data, client_punch_id
  ) VALUES (
    v_user_id, v_org_id, v_facility_id, p_punch_type, p_wait_log_id,
    p_claimed_at, p_latitude, p_longitude, p_accuracy_m,
    v_distance_m, v_within, p_note, p_fishery_data, p_client_punch_id
  )
  RETURNING id INTO v_inserted_id;

  RETURN QUERY
  SELECT v_inserted_id, v_facility_nm, v_distance_m, v_within, false;
END;
$$;

-- ---------------------------------------------------------------------------
-- STEP 4: approve_pending_punch を 'loading_start' 対応に更新
--
--   あわせて承認順序の保護を入れる。荷役開始より先に作業完了を承認すると
--   待機ログが completed になり、後から荷役開始を承認できなくなる。
--   その待機の課金境界が永久に失われるため、明示的に拒否する。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_pending_punch(
  p_punch_id    UUID,
  p_review_note TEXT DEFAULT NULL
)
RETURNS TABLE (
  punch_id      UUID,
  wait_log_id   UUID,
  ticket_number INTEGER,
  self_approved BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_id    UUID := auth.uid();
  v_pp          public.pending_punches%ROWTYPE;
  v_fac_lat     DOUBLE PRECISION;
  v_fac_lng     DOUBLE PRECISION;
  v_fac_radius  INTEGER;
  v_distance_m  DOUBLE PRECISION;
  v_next_num    INTEGER;
  v_log_id      UUID;
  v_self        BOOLEAN;
  v_pending_ls  INTEGER;
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'ログインが必要です。' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_pp
  FROM public.pending_punches
  WHERE id = p_punch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '申請が見つかりません。 (punch_id: %)', p_punch_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT public.has_role_in_org(v_admin_id, v_pp.organization_id, 'admin') THEN
    RAISE EXCEPTION '[法的保護] この申請を承認する権限がありません。'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_pp.review_status <> 'pending' THEN
    RAISE EXCEPTION '審査済みの申請です。 (review_status: %)', v_pp.review_status
      USING ERRCODE = 'check_violation';
  END IF;

  v_self := (v_admin_id = v_pp.user_id);

  IF v_pp.facility_id IS NULL THEN
    RAISE EXCEPTION '[法的保護] 近傍に登録拠点がない申請は承認できません。拠点を登録するか、この申請を却下してください。'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT f.lat, f.lng, f.radius
  INTO v_fac_lat, v_fac_lng, v_fac_radius
  FROM public.facilities f
  WHERE f.id = v_pp.facility_id;

  v_distance_m := 6371000 * 2 * asin(sqrt(
    sin(radians(v_fac_lat - v_pp.latitude) / 2) ^ 2 +
    cos(radians(v_pp.latitude)) * cos(radians(v_fac_lat)) *
    sin(radians(v_fac_lng - v_pp.longitude) / 2) ^ 2
  ));

  IF v_distance_m > v_fac_radius THEN
    RAISE EXCEPTION '[法的保護] 拠点から%m離れた地点の申請は承認できません（許容%m）。拠点の範囲設定を確認するか、この申請を却下してください。',
      ROUND(v_distance_m::numeric), v_fac_radius
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_pp.punch_type = 'arrival' THEN
    SELECT COALESCE(MAX(wl.ticket_number), 0) + 1
    INTO v_next_num
    FROM public.wait_logs wl
    WHERE wl.facility_id = v_pp.facility_id
      AND DATE(COALESCE(wl.claimed_at, wl.arrival_time) AT TIME ZONE 'Asia/Tokyo')
        = DATE(v_pp.claimed_at AT TIME ZONE 'Asia/Tokyo');

    INSERT INTO public.wait_logs (
      facility_id, user_id, ticket_number, status, arrival_time,
      latitude, longitude,
      evidence_grade, claimed_at, approved_by, self_approved, source_punch_id
    ) VALUES (
      v_pp.facility_id, v_pp.user_id, v_next_num, 'waiting', now(),
      v_pp.latitude, v_pp.longitude,
      'C', v_pp.claimed_at, v_admin_id, v_self, v_pp.id
    )
    RETURNING id INTO v_log_id;

    INSERT INTO public.waiting_evidence (
      user_id, organization_id, wait_log_id, evidence_type, latitude, longitude, note
    ) VALUES (
      v_pp.user_id, v_pp.organization_id, v_log_id, 'arrival',
      v_pp.latitude, v_pp.longitude,
      format('等級C: 圏外申告を%sが承認（主張到着時刻 %s）', v_admin_id, v_pp.claimed_at)
    );

  ELSIF v_pp.punch_type = 'loading_start' THEN
    SELECT wl.id INTO v_log_id
    FROM public.wait_logs wl
    WHERE wl.id = v_pp.wait_log_id
      AND wl.status IN ('waiting', 'called')
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION '対象の待機ログが見つからないか、すでに荷役開始・完了・取消済みです。 (wait_log_id: %)', v_pp.wait_log_id
        USING ERRCODE = 'check_violation';
    END IF;

    -- work_start_time はサーバー時刻（承認時刻）。主張時刻は claimed_loading_at に保持し、
    -- 荷待ち時間（＝課金対象）の終端はそちらを見る。
    UPDATE public.wait_logs
    SET status             = 'working',
        work_start_time    = now(),
        claimed_loading_at = v_pp.claimed_at,
        evidence_grade     = 'C',
        approved_by        = v_admin_id,
        self_approved      = v_self,
        source_punch_id    = v_pp.id
    WHERE id = v_log_id;

    INSERT INTO public.waiting_evidence (
      user_id, organization_id, wait_log_id, evidence_type, latitude, longitude, note
    ) VALUES (
      v_pp.user_id, v_pp.organization_id, v_log_id, 'gps_checkpoint',
      v_pp.latitude, v_pp.longitude,
      format('等級C: 圏外の荷役開始申告を%sが承認（主張荷役開始時刻 %s）', v_admin_id, v_pp.claimed_at)
    );

    SELECT wl.ticket_number INTO v_next_num
    FROM public.wait_logs wl WHERE wl.id = v_log_id;

  ELSIF v_pp.punch_type = 'completion' THEN
    IF v_pp.wait_log_id IS NULL THEN
      RAISE EXCEPTION '完了申請に対象の待機ログが指定されていません。 (punch_id: %)', p_punch_id
        USING ERRCODE = 'check_violation';
    END IF;

    -- [重要] 同じ待機ログに未処理の荷役開始申請が残っている場合は完了を承認しない。
    -- 先に完了を通すと待機ログが completed になり、後から荷役開始を承認できなくなる。
    -- 荷役開始は荷待ち時間の終端＝課金境界なので、失うとその待機の待機料が0円になる。
    SELECT COUNT(*) INTO v_pending_ls
    FROM public.pending_punches pp2
    WHERE pp2.wait_log_id = v_pp.wait_log_id
      AND pp2.punch_type = 'loading_start'
      AND pp2.review_status = 'pending';

    IF v_pending_ls > 0 THEN
      RAISE EXCEPTION '[法的保護] この待機には未処理の荷役開始申請が残っています。先にそちらを承認または却下してください（順序を誤ると荷待ち時間が確定できなくなります）。'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT wl.id INTO v_log_id
    FROM public.wait_logs wl
    WHERE wl.id = v_pp.wait_log_id
      AND wl.status IN ('waiting', 'called', 'working')
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION '対象の待機ログが見つからないか、すでに完了・取消済みです。 (wait_log_id: %)', v_pp.wait_log_id
        USING ERRCODE = 'check_violation';
    END IF;

    UPDATE public.wait_logs
    SET status          = 'completed',
        work_end_time   = now(),
        claimed_end_at  = v_pp.claimed_at,
        evidence_grade  = 'C',
        approved_by     = v_admin_id,
        self_approved   = v_self,
        source_punch_id = v_pp.id
    WHERE id = v_log_id;

    INSERT INTO public.waiting_evidence (
      user_id, organization_id, wait_log_id, evidence_type,
      latitude, longitude, fishery_data, note
    ) VALUES (
      v_pp.user_id, v_pp.organization_id, v_log_id, 'departure',
      v_pp.latitude, v_pp.longitude, v_pp.fishery_data,
      format('等級C: 圏外申告を%sが承認（主張完了時刻 %s）', v_admin_id, v_pp.claimed_at)
    );

    UPDATE public.waiting_evidence
    SET is_signed = true
    WHERE wait_log_id = v_log_id
      AND is_signed = false;

    SELECT wl.ticket_number INTO v_next_num
    FROM public.wait_logs wl WHERE wl.id = v_log_id;

  ELSE
    RAISE EXCEPTION '未対応の申請種別です。 (punch_type: %)', v_pp.punch_type
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.pending_punches
  SET review_status   = 'approved',
      reviewed_by     = v_admin_id,
      reviewed_at     = CURRENT_TIMESTAMP,
      review_note     = p_review_note,
      self_approved   = v_self,
      distance_m      = v_distance_m,
      within_geofence = true,
      promoted_log_id = v_log_id
  WHERE id = p_punch_id;

  RETURN QUERY SELECT p_punch_id, v_log_id, v_next_num, v_self;
END;
$$;

-- ---------------------------------------------------------------------------
-- STEP 5: waiting_minutes（GENERATED列）は変更しない
--
--   この列は「到着〜作業完了」の総滞在時間であり荷待ち時間そのものではない
--   （PROGRESS_LOG の未着手事項参照）。荷待ち時間の算定はフロント側の
--   loadingStartedAt() が claimed_loading_at を優先して行う。
--   ここで定義を変えると意味の異なる2つの値が混在するため触らない。
-- ---------------------------------------------------------------------------
