-- =============================================================================
-- pending_punches: 圏外で記録された打刻の申請テーブル（オフライン打刻 Phase 1）
--
-- 【背景】
--   現状、通信圏外では打刻ボタンを物理ロックしており記録が一切残らない。
--   結果として「本当に到着しているのに電波のせいで待機料を請求できない」という
--   ドライバー側の一方的な不利益が生じていた。
--
--   一方で wait_logs / waiting_evidence は INSERT 時にサーバー時刻で時刻カラムを
--   無条件に上書きする（20260414000003）。これは時刻偽装を防ぐ正しい設計だが、
--   オフラインで貯めた記録を後から送ると「朝9時の到着」が「再接続した15時の到着」
--   として保存される。この上書きは外してはならない。
--
-- 【設計方針】詳細は docs/DESIGN_OFFLINE_PUNCH.md
--   1. 圏外＝GPS不可ではない。GPSは衛星測位のため通信がなくても座標は取れる。
--      圏外で失われるのは「時刻の信頼性」「整理券採番」「ジオフェンス判定」の3つだが、
--      後2者は座標さえ残っていれば送信時にサーバーが確定できる。
--      したがって本質的に検証不能なのは時刻だけである。
--   2. 主張時刻(claimed_at)は原理的に検証できない。サーバーが言えるのは
--      「received_at より前」という上界だけ。端末時計を巻き戻せば任意の過去を
--      主張できる。だから技術ではなく人間（管理者）の承認を挟む。
--   3. このテーブルは wait_logs とは別に置く（staging と真実の分離）。
--      待機料の集計はすべて wait_logs を読むため、未承認の申告がそこに入らなければ
--      集計側に条件を足さなくても請求に載らない。フラグで区別する案は、集計を
--      書くたびにフィルタが必要になり、実際に踏んだ「取消済み打刻の混入」と
--      同じ事故を必ず繰り返すため採用しない。
--
-- 【Phase 1 の範囲】
--   申請の受け皿と queue_offline_punch RPC のみ。承認/却下（approve_pending_punch /
--   reject_pending_punch）と wait_logs への昇格は Phase 2。
--   本 migration では承認用のカラムだけ先に用意し、値は入らない。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- TABLE
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pending_punches (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id UUID        REFERENCES public.organizations(id) ON DELETE SET NULL,

  -- 施設はサーバーが座標から解決する（オフラインの端末は施設マスタを持たないため）。
  -- 近傍に施設がない場合も申請自体は受け付け、NULL のまま管理者の判断に委ねる。
  facility_id     UUID        REFERENCES public.facilities(id) ON DELETE RESTRICT,

  punch_type      TEXT        NOT NULL CHECK (punch_type IN ('arrival', 'completion')),
  -- 完了打刻の申請の場合、対象の待機ログ
  wait_log_id     UUID        REFERENCES public.wait_logs(id) ON DELETE RESTRICT,

  -- ★ 時刻を2つ持つのがこのテーブルの核心。
  --   claimed_at はサーバー時刻で上書きしない（主張を主張として保存する）。
  --   received_at はトリガーでサーバー時刻に強制する。
  --   両方残すことで「いつ起きたと主張しているか」と「いつ届いたか」を区別できる。
  claimed_at      TIMESTAMPTZ NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- GPS座標は必須。位置の裏付けがない申告は承認者が判断する材料を持たないため受けない。
  latitude        DOUBLE PRECISION NOT NULL,
  longitude       DOUBLE PRECISION NOT NULL,
  gps_accuracy_m  DOUBLE PRECISION,

  -- 送信時にサーバーが座標から計算する。承認画面で「圏内だったのか」を数値で示す。
  distance_m      DOUBLE PRECISION,
  within_geofence BOOLEAN,

  driver_note     TEXT,

  -- 完了打刻の申請に付随する水産物情報（魚種・重量・漁獲番号）。
  -- 水産流通適正化法の要求項目であり、承認時に complete_ticket へ引き渡す必要がある。
  -- Phase 1 の UI は到着打刻のみを扱うため常に NULL だが、Phase 2 で完了打刻の
  -- 申請を追加する際にカラム追加のmigrationを重ねずに済むよう先に用意しておく。
  fishery_data    JSONB,

  -- 再送による二重申請を防ぐ冪等キー（端末が生成するUUID）
  client_punch_id UUID        NOT NULL,

  -- ── 承認まわり（Phase 2 で使用。Phase 1 では pending のまま）──
  review_status   TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (review_status IN ('pending', 'approved', 'rejected')),
  reviewed_by     UUID        REFERENCES auth.users(id),
  reviewed_at     TIMESTAMPTZ,
  review_note     TEXT,
  -- 承認者＝申請者だった場合に true。一人親方・小規模事業者では管理者＝ドライバーに
  -- なるため自己承認を禁止せず、代わりに記録して荷主向け提示でも明示する方針。
  self_approved   BOOLEAN     NOT NULL DEFAULT false,
  -- 承認により生成した wait_logs 行
  promoted_log_id UUID        REFERENCES public.wait_logs(id) ON DELETE RESTRICT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- 同一ドライバーからの同一申請の再送を1件に収斂させる
  CONSTRAINT pending_punches_client_punch_id_uniq UNIQUE (user_id, client_punch_id)
);

COMMENT ON TABLE  public.pending_punches IS
  '圏外で記録された打刻の申請。管理者承認をもって wait_logs へ昇格する。未承認の行は待機料の集計対象外。';
COMMENT ON COLUMN public.pending_punches.claimed_at IS
  '端末が主張する打刻時刻。検証不能なためサーバー時刻で上書きしない。received_at と必ず併せて解釈すること。';
COMMENT ON COLUMN public.pending_punches.received_at IS
  'サーバーがこの申請を受信した時刻。トリガーでサーバー時刻に強制上書きされる。claimed_at の上界。';
COMMENT ON COLUMN public.pending_punches.self_approved IS
  '承認者と申請者が同一の場合 true。禁止せず記録し、荷主向けの提示でも明示する。';

CREATE INDEX IF NOT EXISTS idx_pending_punches_user_id
  ON public.pending_punches(user_id);
CREATE INDEX IF NOT EXISTS idx_pending_punches_review_status
  ON public.pending_punches(review_status);
CREATE INDEX IF NOT EXISTS idx_pending_punches_org_pending
  ON public.pending_punches(organization_id, review_status);

-- ---------------------------------------------------------------------------
-- TRIGGER: received_at / created_at をサーバー時刻で強制上書きする
--
--   claimed_at は意図的に対象外。ここを上書きすると、このテーブルを作った意味
--   （主張時刻を主張として残すこと）が失われる。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.force_pending_punch_timestamps()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.received_at := CURRENT_TIMESTAMP;
  NEW.created_at  := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.force_pending_punch_timestamps() IS
  '法的証拠要件: pending_punches の received_at / created_at をサーバー時刻で強制上書きする。claimed_at は端末の主張値として意図的に保持する。';

DROP TRIGGER IF EXISTS trg_force_pending_punch_timestamps ON public.pending_punches;
CREATE TRIGGER trg_force_pending_punch_timestamps
  BEFORE INSERT ON public.pending_punches
  FOR EACH ROW
  EXECUTE FUNCTION public.force_pending_punch_timestamps();

-- ---------------------------------------------------------------------------
-- TRIGGER: 審査確定後の申請内容の書き換えを禁止する
--
--   承認/却下が済んだ申請の中身（時刻・座標・理由）が後から変わると、
--   管理者が何を見て判断したのかが再現できなくなる。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_reviewed_pending_punch()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.review_status <> 'pending' THEN
    IF NEW.claimed_at    IS DISTINCT FROM OLD.claimed_at
    OR NEW.latitude      IS DISTINCT FROM OLD.latitude
    OR NEW.longitude     IS DISTINCT FROM OLD.longitude
    OR NEW.driver_note   IS DISTINCT FROM OLD.driver_note
    OR NEW.punch_type    IS DISTINCT FROM OLD.punch_type
    OR NEW.review_status IS DISTINCT FROM OLD.review_status THEN
      RAISE EXCEPTION '[法的保護] 審査済みの申請は変更できません。 (id: %)', OLD.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_reviewed_pending_punch ON public.pending_punches;
CREATE TRIGGER trg_guard_reviewed_pending_punch
  BEFORE UPDATE ON public.pending_punches
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_reviewed_pending_punch();

-- ---------------------------------------------------------------------------
-- TRIGGER: DELETE 全面禁止（証拠隠滅防止。却下も行を残す）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.block_pending_punch_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION '[法的保護] 申請の削除は禁止されています。却下する場合は review_status を rejected にしてください。'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS trg_block_pending_punch_delete ON public.pending_punches;
CREATE TRIGGER trg_block_pending_punch_delete
  BEFORE DELETE ON public.pending_punches
  FOR EACH ROW
  EXECUTE FUNCTION public.block_pending_punch_delete();

-- ---------------------------------------------------------------------------
-- RLS
--
--   Rule 1（RPCチェーン必須）に従い、INSERT ポリシーは作らない。
--   唯一の入口は SECURITY DEFINER の queue_offline_punch RPC。
--   UPDATE ポリシーも Phase 2 の承認RPCで導入するため、ここでは作らない。
-- ---------------------------------------------------------------------------
ALTER TABLE public.pending_punches ENABLE ROW LEVEL SECURITY;

-- SELECT: 本人 OR 同組織の管理者
DROP POLICY IF EXISTS "pending_punches_select" ON public.pending_punches;
CREATE POLICY "pending_punches_select"
  ON public.pending_punches FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.has_role_in_org(auth.uid(), organization_id, 'admin')
  );

-- ---------------------------------------------------------------------------
-- RPC: queue_offline_punch
--
--   圏外で記録した打刻をサーバーへ送る唯一の入口。
--   施設の解決とジオフェンス判定はここで行う（端末は施設マスタを持たない）。
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

  -- ① 座標必須。位置の裏付けがない申告は承認者の判断材料にならないため受けない。
  IF p_latitude IS NULL OR p_longitude IS NULL THEN
    RAISE EXCEPTION '[法的保護] GPS座標(latitude/longitude)は必須です。'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_punch_type NOT IN ('arrival', 'completion') THEN
    RAISE EXCEPTION '打刻種別が不正です。 (punch_type: %)', p_punch_type
      USING ERRCODE = 'check_violation';
  END IF;

  -- ② 未来時刻の主張を拒否する。「まだ起きていないこと」を申告している。
  --    端末時計のズレを考慮し5分の猶予を設ける。
  IF p_claimed_at > CURRENT_TIMESTAMP + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION '[法的保護] 未来の時刻は申請できません。端末の時刻設定を確認してください。'
      USING ERRCODE = 'check_violation';
  END IF;

  -- ③ 申請期限は30日。それ以前の打刻は証拠として態をなさないため受け付けない。
  --    （届いた申請の「承認」自体には期限を設けない。管理者の見落としで
  --      ドライバーが救済されなくなる事態を避けるため）
  IF p_claimed_at < CURRENT_TIMESTAMP - INTERVAL '30 days' THEN
    RAISE EXCEPTION '[法的保護] 30日を超える過去の打刻は申請できません。 (claimed_at: %)', p_claimed_at
      USING ERRCODE = 'check_violation';
  END IF;

  -- ④ 冪等性: オフラインキューの再送で二重申請にならないようにする。
  --    既に同じ client_punch_id があればそれを返して終わる。
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

  -- ⑤ 座標から最寄り施設を解決する。
  --    半径で絞らず最寄りを1件取り、距離と圏内判定を記録する。
  --    圏外でも申請自体は受け付け、管理者が距離を見て判断する。
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

  -- ⑥ 組織IDを profiles から解決（承認画面の絞り込みに使う）
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

COMMENT ON FUNCTION public.queue_offline_punch IS
  '圏外で記録された打刻を pending_punches に申請として登録する。claimed_at は端末の主張値として保存し、施設解決とジオフェンス判定はサーバーが行う。未承認のため待機料の集計対象にはならない。';

REVOKE ALL ON FUNCTION public.queue_offline_punch FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.queue_offline_punch TO authenticated;
