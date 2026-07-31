-- =============================================================================
-- オフライン打刻 Phase 2: 管理者による承認/却下と wait_logs への昇格
--
-- 【前提】Phase 1（20260730100000）で pending_punches と queue_offline_punch を
--   導入済み。申請は溜まるが誰も処理できない状態だった。本migrationで
--   承認経路を通し、圏外の打刻が実際に救済されるようにする。
--
-- 【設計上の決定】詳細は docs/DESIGN_OFFLINE_PUNCH.md §8
--   ① 承認しても等級Aにはならない。wait_logs.evidence_grade = 'C' として記録し、
--      「サーバーが時刻を検証した記録」と「管理者が申告を認めた記録」を区別する。
--   ② arrival_time / work_end_time はサーバー時刻のまま据え置き、ドライバーの
--      主張時刻は claimed_at / claimed_end_at に別途保持する。
--      時刻強制上書きトリガーに例外を開けると、そこが将来の偽装経路になるため。
--   ③ 自己承認（管理者＝申請者）は禁止せず self_approved に記録する。
--      一人親方・小規模事業者では管理者＝ドライバーになり、禁止すると
--      圏外救済そのものが機能しないため。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- STEP 1: wait_logs に等級カラムを追加
--
--   既存行はすべて evidence_grade='A'（デフォルト）となり後方互換が保たれる。
-- ---------------------------------------------------------------------------
ALTER TABLE public.wait_logs
  ADD COLUMN IF NOT EXISTS evidence_grade  TEXT NOT NULL DEFAULT 'A',
  ADD COLUMN IF NOT EXISTS claimed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claimed_end_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by     UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS self_approved   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_punch_id UUID REFERENCES public.pending_punches(id);

DO $$ BEGIN
  ALTER TABLE public.wait_logs
    ADD CONSTRAINT wait_logs_evidence_grade_check
    CHECK (evidence_grade IN ('A', 'C'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN public.wait_logs.evidence_grade IS
  '証拠の等級。A=サーバー検証済（通常の打刻）、C=圏外申告を管理者が承認したもの。Cは時刻がサーバー検証されていないため、荷主への提示ではAと区別すること。';
COMMENT ON COLUMN public.wait_logs.claimed_at IS
  '等級Cのみ。ドライバーが主張する到着時刻（検証不能）。arrival_time は承認処理を行ったサーバー時刻であり、実際の到着時刻ではない。';
COMMENT ON COLUMN public.wait_logs.claimed_end_at IS
  '等級Cのみ。ドライバーが主張する作業完了時刻（検証不能）。';
COMMENT ON COLUMN public.wait_logs.self_approved IS
  '承認者と申請者が同一の場合 true。禁止はせず記録し、荷主向けの提示でも明示する。';

-- 等級・主張時刻・承認者はRPC経由でのみ設定させる（クライアントからの改変を防ぐ）
REVOKE UPDATE (
  evidence_grade, claimed_at, claimed_end_at, approved_by, self_approved, source_punch_id
) ON public.wait_logs FROM authenticated;

CREATE INDEX IF NOT EXISTS idx_wait_logs_evidence_grade
  ON public.wait_logs(evidence_grade);

-- ---------------------------------------------------------------------------
-- STEP 2: waiting_minutes（GENERATED列）を主張時刻に対応させる
--
-- 【なぜ必要か】
--   waiting_minutes は arrival_time〜work_end_time から自動計算される GENERATED 列。
--   等級Cでは arrival_time が「承認処理を行った時刻」になるため、このままだと
--   待機時間が実態とかけ離れた値（場合によっては負）になる。
--   決定②により主張時刻は claimed_at / claimed_end_at に入るので、
--   導出値であるこの列は COALESCE で主張時刻を優先して参照する。
--   証拠カラム（arrival_time / work_end_time）自体はサーバー時刻のまま無傷。
--
--   GENERATED列は導出値のみを保持するため、DROP して再定義しても元データは失われない。
-- ---------------------------------------------------------------------------
ALTER TABLE public.wait_logs DROP COLUMN IF EXISTS waiting_minutes;

ALTER TABLE public.wait_logs
  ADD COLUMN waiting_minutes NUMERIC
    GENERATED ALWAYS AS (
      CASE
        WHEN COALESCE(claimed_end_at, work_end_time) IS NOT NULL
         AND COALESCE(claimed_at, arrival_time) IS NOT NULL
        THEN ROUND(
          EXTRACT(EPOCH FROM (
            COALESCE(claimed_end_at, work_end_time) - COALESCE(claimed_at, arrival_time)
          )) / 60, 1)
        ELSE NULL
      END
    ) STORED;

COMMENT ON COLUMN public.wait_logs.waiting_minutes IS
  '取適法: 拠点滞在時間（分）。等級Cでは主張時刻(claimed_at/claimed_end_at)を優先して算出する。クライアント入力不可（GENERATED ALWAYS）。※荷待ち時間そのものではなく到着〜出発の総滞在時間である点に注意。';

-- ---------------------------------------------------------------------------
-- STEP 3: approve_pending_punch
--
--   圏外申請を承認し、wait_logs へ等級Cで昇格させる。
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
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'ログインが必要です。' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- ① 対象申請をロックして取得
  SELECT * INTO v_pp
  FROM public.pending_punches
  WHERE id = p_punch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '申請が見つかりません。 (punch_id: %)', p_punch_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- ② 権限検証: 申請者と同じ組織の管理者のみ
  IF NOT public.has_role_in_org(v_admin_id, v_pp.organization_id, 'admin') THEN
    RAISE EXCEPTION '[法的保護] この申請を承認する権限がありません。'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_pp.review_status <> 'pending' THEN
    RAISE EXCEPTION '審査済みの申請です。 (review_status: %)', v_pp.review_status
      USING ERRCODE = 'check_violation';
  END IF;

  -- ③ 自己承認は禁止せず記録する（決定③）
  v_self := (v_admin_id = v_pp.user_id);

  -- ④ ジオフェンスを承認時点で再計算する。
  --    申請時の判定結果をそのまま使わないのは、施設の radius 設定を修正すれば
  --    正しく承認できるようにするため（設定ミスで永久に救済不能になるのを防ぐ）。
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

  -- 圏外の申請は承認しない。ここを緩めると wait_logs のジオフェンス保証が
  -- 全体として失われ、待機料の算定根拠が崩れる。拠点の radius が実態に
  -- 合っていない場合は拠点設定を直してから再度承認する。
  IF v_distance_m > v_fac_radius THEN
    RAISE EXCEPTION '[法的保護] 拠点から%m離れた地点の申請は承認できません（許容%m）。拠点の範囲設定を確認するか、この申請を却下してください。',
      ROUND(v_distance_m::numeric), v_fac_radius
      USING ERRCODE = 'check_violation';
  END IF;

  -- ⑤ 種別ごとの昇格処理
  IF v_pp.punch_type = 'arrival' THEN
    -- 整理券番号は「主張された到着日」の連番として採番する
    SELECT COALESCE(MAX(wl.ticket_number), 0) + 1
    INTO v_next_num
    FROM public.wait_logs wl
    WHERE wl.facility_id = v_pp.facility_id
      AND DATE(COALESCE(wl.claimed_at, wl.arrival_time) AT TIME ZONE 'Asia/Tokyo')
        = DATE(v_pp.claimed_at AT TIME ZONE 'Asia/Tokyo');

    -- arrival_time はトリガーによりサーバー時刻（＝承認時刻）で確定する。
    -- 実際の到着時刻は claimed_at に保持し、waiting_minutes はそちらを見る。
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

  ELSIF v_pp.punch_type = 'completion' THEN
    IF v_pp.wait_log_id IS NULL THEN
      RAISE EXCEPTION '完了申請に対象の待機ログが指定されていません。 (punch_id: %)', p_punch_id
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

    -- work_end_time はサーバー時刻（承認時刻）。主張時刻は claimed_end_at に保持する。
    -- 完了申請の承認により、その待機ログ全体が等級Cになる点に注意。
    -- 到着がサーバー検証済みでも、退出時刻が検証されていない以上、
    -- 算定される待機時間はサーバー検証済みとは言えないため。
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

    -- 完了確定に伴い、この待機ログのエビデンスを署名して以後の改ざんを不可能にする
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

  -- ⑥ 申請を承認済みに確定する
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

COMMENT ON FUNCTION public.approve_pending_punch IS
  '圏外申請を承認し wait_logs へ等級Cで昇格させる。同組織の管理者のみ実行可能。ジオフェンスは承認時点で再計算し、圏外の申請は承認できない。自己承認は禁止せず self_approved に記録する。';

-- ---------------------------------------------------------------------------
-- STEP 4: reject_pending_punch
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_pending_punch(
  p_punch_id    UUID,
  p_review_note TEXT
)
RETURNS TABLE (
  punch_id    UUID,
  rejected_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_id UUID := auth.uid();
  v_org_id   UUID;
  v_status   TEXT;
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'ログインが必要です。' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 却下理由は必須。ドライバーに理由が伝わらないと再申請の判断ができない。
  IF p_review_note IS NULL OR btrim(p_review_note) = '' THEN
    RAISE EXCEPTION '却下理由は必須です。' USING ERRCODE = 'check_violation';
  END IF;

  SELECT pp.organization_id, pp.review_status
  INTO v_org_id, v_status
  FROM public.pending_punches pp
  WHERE pp.id = p_punch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '申請が見つかりません。 (punch_id: %)', p_punch_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT public.has_role_in_org(v_admin_id, v_org_id, 'admin') THEN
    RAISE EXCEPTION '[法的保護] この申請を却下する権限がありません。'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_status <> 'pending' THEN
    RAISE EXCEPTION '審査済みの申請です。 (review_status: %)', v_status
      USING ERRCODE = 'check_violation';
  END IF;

  -- 物理削除はしない（証拠隠滅防止）。行を残したまま却下状態にする。
  UPDATE public.pending_punches
  SET review_status = 'rejected',
      reviewed_by   = v_admin_id,
      reviewed_at   = CURRENT_TIMESTAMP,
      review_note   = p_review_note
  WHERE id = p_punch_id;

  RETURN QUERY SELECT p_punch_id, CURRENT_TIMESTAMP;
END;
$$;

COMMENT ON FUNCTION public.reject_pending_punch IS
  '圏外申請を却下する。同組織の管理者のみ実行可能。却下理由は必須。証拠隠滅防止のため行は削除せず残す。';

REVOKE ALL ON FUNCTION public.approve_pending_punch FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_pending_punch  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_pending_punch TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_pending_punch  TO authenticated;
