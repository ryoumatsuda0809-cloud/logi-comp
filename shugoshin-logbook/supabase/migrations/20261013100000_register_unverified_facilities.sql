-- =============================================================================
-- 運送会社の管理者が、新しい荷主の現場（施設）を自分で登録できるようにする
--
-- 【背景】
--   施設を足せるのは運営者の SQL だけで、新しい現場ではドライバーが打刻できなかった。
--
-- 【最重要の設計制約】
--   誰でも好きな座標に施設を作れると、GPS の証拠の意味がなくなる
--   （自分の居場所に施設を作れば、いつでも500m圏内になれる）。そのため:
--
--   1. 管理者が登録した施設は「未確認」（verification_status = 'unverified'）。
--   2. 登録の入口は SECURITY DEFINER の RPC register_facility だけ。
--      facilities への直接 INSERT / UPDATE / DELETE は、これまでどおり
--      authenticated に付与しない（20260806110000 で REVOKE 済み。ここでは変えない）。
--   3. 未確認の施設は「登録した組織のメンバー」だけが見え、打刻に使える。
--      他の組織には見えない・使えない。検査する場所:
--        - facilities の SELECT ポリシー
--        - get_nearest_facility / issue_ticket / queue_offline_punch
--          （SECURITY DEFINER で RLS を迂回するので、関数の中で明示的に検査する）
--        - verify_company_name（組織名の候補。確認済みの施設だけにする）
--        - wait_logs の INSERT トリガー enforce_wait_log_geofence（最後の砦。
--          approve_pending_punch など issue_ticket 以外の経路も止める）
--   4. 「確認済み」にする操作は RPC を作らない。運営者が SQL で行う（下記）。
--      クライアントから verification_status を変えられない。
--
-- 【運営者が施設を「確認済み」にする手順（SQL エディタで、運営者だけが実行する）】
--   荷主の実在と、座標が荷主の敷地であることを（電話・現地・地図などで）確認してから:
--
--     -- 1. 対象を確かめる（未確認の施設の一覧）
--     SELECT f.id, f.name, f.client_name, f.lat, f.lng, f.created_at,
--            o.name AS registered_by_org
--     FROM public.facilities f
--     LEFT JOIN public.organizations o ON o.id = f.registered_by_organization_id
--     WHERE f.verification_status = 'unverified'
--     ORDER BY f.created_at;
--
--     -- 2. 確認済みにする。届出番号（水産物を扱う荷主のみ・7桁）は登録画面では入力させないので、
--     --    ここで運営者が設定する（不明なら NULL のまま）。
--     UPDATE public.facilities
--        SET verification_status = 'verified',
--            notification_number = '<7桁の届出番号。無ければ行ごと削除>'
--      WHERE id = '<施設の id>' AND verification_status = 'unverified';
--
--     -- 3. 荷主が組織としてアプリに登録済みなら、あわせて紐付ける（任意）。
--     --    紐付けると、その荷主組織の管理者が待機記録を閲覧できるようになる。
--     --    紐付ける組織を取り違えると他社に記録を見せるので、必ず id を確認する。
--     UPDATE public.facilities
--        SET client_organization_id = '<荷主組織の id>'
--      WHERE id = '<施設の id>';
--
--   確認済みになった施設は、全ての組織のドライバーから見え、打刻に使える。
--   未確認に戻すのも運営者の SQL（UPDATE ... SET verification_status = 'unverified'）。
--   ただし、他組織が既に打刻した記録は残る（wait_logs は不変）。
--   【注意】既存の確認済み施設は registered_by_organization_id が NULL。これを unverified に
--   戻すと、誰にも見えず誰も使えなくなる（登録組織が無いため）。戻すなら、先に
--   registered_by_organization_id を設定すること。
--
-- 【適用順序】マイグレーション → フロントの順。逆にすると、新しいフロント
--   （SharedReportView が verification_status / unverified_facility_names を読む）が
--   存在しない列・項目を読み、荷主名と未確認の注記が空になる。
--
-- 【既存の経路への影響】
--   既存の行は全て 'verified' になるので、既存の挙動は変わらない。
--   未確認の施設は client_organization_id = NULL で作られるため、荷主側の wait_logs
--   閲覧（20260806100000）の対象外で、shipper_advance_wait も使えない。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- STEP 1: 列の追加（既存の行は 'verified'）
-- ---------------------------------------------------------------------------
ALTER TABLE public.facilities
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'verified',
  ADD COLUMN IF NOT EXISTS registered_by_organization_id uuid
    REFERENCES public.organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS registered_by uuid
    REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.facilities
  DROP CONSTRAINT IF EXISTS facilities_verification_status_check;
ALTER TABLE public.facilities
  ADD CONSTRAINT facilities_verification_status_check
  CHECK (verification_status IN ('verified', 'unverified'));

COMMENT ON COLUMN public.facilities.verification_status IS
  'verified=運営者が確認済み（全組織が使える）／unverified=運送会社の管理者が登録した未確認の施設（登録した組織のメンバーだけが見え、打刻に使える）。確認済みにするのは運営者の SQL だけ。RPC は無い。';
COMMENT ON COLUMN public.facilities.registered_by_organization_id IS
  '未確認の施設を登録した運送会社の組織。unverified の施設の可視性の根拠。運営者が登録した施設は NULL。';
COMMENT ON COLUMN public.facilities.registered_by IS
  '未確認の施設を登録した管理者。運営者が登録した施設は NULL。';

CREATE INDEX IF NOT EXISTS idx_facilities_registered_by_org
  ON public.facilities (registered_by_organization_id)
  WHERE registered_by_organization_id IS NOT NULL;

-- テーブル単位の INSERT / UPDATE は 20260806110000 で外し済み（ここでは変えない）。
-- 念のため、権限の根拠になる列は列単位でも外しておく
-- （今後テーブル単位の GRANT が緩んでも、書き換えられないように）。
REVOKE INSERT (verification_status, registered_by_organization_id, registered_by)
  ON public.facilities FROM authenticated, anon;
REVOKE UPDATE (verification_status, registered_by_organization_id, registered_by)
  ON public.facilities FROM authenticated, anon;

-- ---------------------------------------------------------------------------
-- STEP 2: SELECT ポリシー（確認済み、または自組織が登録したものだけ）
--   旧: authenticated_can_select USING (true)
--   is_member_of_org は SECURITY DEFINER（user_roles を RLS に関係なく引く）で、
--   authenticated に EXECUTE が付与済み（RLS の評価で呼ばれるため）。
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "authenticated_can_select" ON public.facilities;
DROP POLICY IF EXISTS "facilities_select_verified_or_own_org" ON public.facilities;

CREATE POLICY "facilities_select_verified_or_own_org"
  ON public.facilities
  FOR SELECT
  TO authenticated
  USING (
    verification_status = 'verified'
    OR (
      registered_by_organization_id IS NOT NULL
      AND public.is_member_of_org(auth.uid(), registered_by_organization_id)
    )
  );

-- ---------------------------------------------------------------------------
-- STEP 3: 「この人はこの施設を打刻に使えるか」の共通判定
--   SECURITY DEFINER の関数（RLS を迂回する）の中から呼ぶ用。クライアントには公開しない。
--   存在しない施設は false。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_use_facility(p_user_id uuid, p_facility_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.facilities f
    WHERE f.id = p_facility_id
      AND (
        f.verification_status = 'verified'
        OR (
          p_user_id IS NOT NULL
          AND f.registered_by_organization_id IS NOT NULL
          AND public.is_member_of_org(p_user_id, f.registered_by_organization_id)
        )
      )
  );
$$;

REVOKE EXECUTE ON FUNCTION public.can_use_facility(uuid, uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.can_use_facility(uuid, uuid) IS
  '確認済みの施設、または未確認でも利用者が登録組織のメンバーなら true。get_nearest_facility / issue_ticket / queue_offline_punch / wait_logs の INSERT トリガーが使う内部用。クライアントには公開しない。';

-- ---------------------------------------------------------------------------
-- STEP 4: register_facility（施設を未確認として登録する唯一の入口）
--
--   - 呼べるのは、自組織の admin のみ。
--   - 半径は 500m 固定（引数にしない）。
--   - 組織ごとの未確認施設は最大20件。
--   - 確認済みの施設（他組織のものを含む）から 30m 以内の座標は拒否。未確認の施設が、
--     近くの確認済みの施設を覆い隠して（最寄りに選ばれて）しまうのを防ぐ。
--   - 同じ組織で、50m 以内・同名の重複登録は拒否。
--   - 届出番号は引数にしない。NULL で作り、運営者が確認済みにするときに SQL で設定する。
--   - 同じ組織の同時登録で上限・重複の検査がすり抜けないよう、組織の行をロックする。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_facility(
  p_name                text,
  p_client_name         text,
  p_lat                 double precision,
  p_lng                 double precision,
  p_address             text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  c_max_unverified CONSTANT integer := 20;
  c_dup_radius_m   CONSTANT double precision := 50;
  -- 確認済みの施設の近く（他組織のものを含む）には登録させない距離。
  -- 同じ市場に施設が密集している実態があるので 30m。
  c_verified_near_m CONSTANT double precision := 30;
  v_uid     uuid := auth.uid();
  v_org_id  uuid;
  v_name    text := btrim(COALESCE(p_name, ''));
  v_client  text := btrim(COALESCE(p_client_name, ''));
  v_address text := NULLIF(btrim(COALESCE(p_address, '')), '');
  v_count   integer;
  v_id      uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'ログインが必要です。' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT p.organization_id INTO v_org_id
  FROM public.profiles p
  WHERE p.user_id = v_uid;

  IF v_org_id IS NULL OR NOT public.has_role_in_org(v_uid, v_org_id, 'admin'::public.app_role) THEN
    RAISE EXCEPTION '施設を登録できるのは、所属する組織の管理者だけです。'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 入力の検証
  IF char_length(v_name) < 1 OR char_length(v_name) > 100 THEN
    RAISE EXCEPTION '施設名は1〜100文字で入力してください。' USING ERRCODE = 'check_violation';
  END IF;
  IF char_length(v_client) < 1 OR char_length(v_client) > 100 THEN
    RAISE EXCEPTION '荷主名は1〜100文字で入力してください。' USING ERRCODE = 'check_violation';
  END IF;
  IF v_address IS NOT NULL AND char_length(v_address) > 200 THEN
    RAISE EXCEPTION '住所は200文字以内で入力してください。' USING ERRCODE = 'check_violation';
  END IF;
  -- NaN / Infinity もここで弾かれる（BETWEEN が偽になる）
  IF p_lat IS NULL OR p_lng IS NULL
     OR NOT (p_lat BETWEEN -90 AND 90) OR NOT (p_lng BETWEEN -180 AND 180) THEN
    RAISE EXCEPTION '位置情報が正しくありません。緯度は-90〜90、経度は-180〜180の範囲で指定してください。'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 同じ組織の同時登録を直列化する（上限・重複の検査をすり抜けさせない）
  PERFORM 1 FROM public.organizations o WHERE o.id = v_org_id FOR NO KEY UPDATE;

  SELECT count(*) INTO v_count
  FROM public.facilities f
  WHERE f.registered_by_organization_id = v_org_id
    AND f.verification_status = 'unverified';
  IF v_count >= c_max_unverified THEN
    RAISE EXCEPTION '未確認の施設は最大%件までです。運営者の確認が済むまで、新しい施設は登録できません。', c_max_unverified
      USING ERRCODE = 'check_violation';
  END IF;

  -- 確認済みの施設（他組織のものを含む）の近くには登録できない。施設名は出さない。
  IF EXISTS (
    SELECT 1
    FROM public.facilities f
    WHERE f.verification_status = 'verified'
      AND 6371000 * 2 * asin(sqrt(least(1.0::double precision,
            sin(radians(f.lat - p_lat) / 2) ^ 2 +
            cos(radians(p_lat)) * cos(radians(f.lat)) *
            sin(radians(f.lng - p_lng) / 2) ^ 2
          ))) <= c_verified_near_m
  ) THEN
    RAISE EXCEPTION '既に登録されている施設の近くです。同じ現場の場合は、運営者に確認を依頼してください。'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 同じ組織が登録した、ほぼ同じ位置・同名の施設（大文字小文字・前後の空白は無視）
  IF EXISTS (
    SELECT 1
    FROM public.facilities f
    WHERE f.registered_by_organization_id = v_org_id
      AND lower(btrim(f.name)) = lower(v_name)
      AND 6371000 * 2 * asin(sqrt(least(1.0::double precision,
            sin(radians(f.lat - p_lat) / 2) ^ 2 +
            cos(radians(p_lat)) * cos(radians(f.lat)) *
            sin(radians(f.lng - p_lng) / 2) ^ 2
          ))) <= c_dup_radius_m
  ) THEN
    RAISE EXCEPTION '同じ名前の施設が、ほぼ同じ場所にすでに登録されています。'
      USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO public.facilities (
    name, client_name, address, lat, lng, radius,
    verification_status, registered_by_organization_id, registered_by
  )
  VALUES (
    v_name, v_client, v_address, p_lat, p_lng, 500,
    'unverified', v_org_id, v_uid
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.register_facility(text, text, double precision, double precision, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_facility(text, text, double precision, double precision, text)
  TO authenticated;

COMMENT ON FUNCTION public.register_facility(text, text, double precision, double precision, text) IS
  '自組織の管理者が、施設を「未確認」として登録する唯一の入口。半径500m固定・未確認は組織ごとに最大20件・確認済み施設の30m以内は拒否・同組織の50m以内同名は拒否・届出番号は登録時に受け取らない。確認済みにする RPC は無い（運営者の SQL）。';

-- ---------------------------------------------------------------------------
-- STEP 5: get_nearest_facility（SECURITY DEFINER なので RLS は効かない。明示的に絞る）
--   未確認の施設は、登録組織のメンバーにだけ返す。距離計算・戻り値は 20260728140000 のまま。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_nearest_facility(
  user_lat DOUBLE PRECISION,
  user_lng DOUBLE PRECISION
)
RETURNS TABLE (
  id                  UUID,
  name                TEXT,
  client_name         TEXT,
  lat                 DOUBLE PRECISION,
  lng                 DOUBLE PRECISION,
  radius              INTEGER,
  notification_number TEXT,
  distance_m          DOUBLE PRECISION
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    f.id, f.name, f.client_name, f.lat, f.lng, f.radius, f.notification_number,
    6371000 * 2 * asin(sqrt(
      sin(radians(f.lat - user_lat) / 2) ^ 2 +
      cos(radians(user_lat)) * cos(radians(f.lat)) *
      sin(radians(f.lng - user_lng) / 2) ^ 2
    )) AS distance_m
  FROM facilities f
  WHERE public.can_use_facility(auth.uid(), f.id)
    AND 6371000 * 2 * asin(sqrt(
      sin(radians(f.lat - user_lat) / 2) ^ 2 +
      cos(radians(user_lat)) * cos(radians(f.lat)) *
      sin(radians(f.lng - user_lng) / 2) ^ 2
    )) <= f.radius
  ORDER BY distance_m ASC
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_nearest_facility(DOUBLE PRECISION, DOUBLE PRECISION) IS
  '現在地から radius(既定500m) 圏内で最も近い施設を返す。未確認の施設は、登録した組織のメンバーにだけ返す。漁獲番号の組み立てに使う notification_number を含む。';

-- ---------------------------------------------------------------------------
-- STEP 6: issue_ticket（20260806150000 の定義に、施設の利用可否の検査を足しただけ）
-- ---------------------------------------------------------------------------
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

  -- 未確認の施設は、登録した組織のメンバーしか使えない（存在しない施設も同じ扱い）
  IF NOT public.can_use_facility(auth.uid(), p_facility_id) THEN
    RAISE EXCEPTION '[法的保護] この施設では打刻できません。施設が見つからないか、未確認の施設です。'
      USING ERRCODE = 'insufficient_privilege';
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

-- ---------------------------------------------------------------------------
-- STEP 7: queue_offline_punch（20260803100000 の定義の、最寄り施設の検索だけを絞る）
--   絞らないと、他組織の未確認施設が「最寄り」に選ばれ、その施設名が戻り値で漏れる。
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

  -- 最寄りの施設。未確認の施設は、登録した組織のメンバーにだけ候補になる。
  SELECT f.id, f.name, f.radius,
         6371000 * 2 * asin(sqrt(
           sin(radians(f.lat - p_latitude) / 2) ^ 2 +
           cos(radians(p_latitude)) * cos(radians(f.lat)) *
           sin(radians(f.lng - p_longitude) / 2) ^ 2
         ))
  INTO v_facility_id, v_facility_nm, v_radius, v_distance_m
  FROM public.facilities f
  WHERE public.can_use_facility(v_user_id, f.id)
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

REVOKE EXECUTE ON FUNCTION public.queue_offline_punch(timestamptz, double precision, double precision, uuid, text, double precision, text, uuid, jsonb)
  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.queue_offline_punch(timestamptz, double precision, double precision, uuid, text, double precision, text, uuid, jsonb)
  TO authenticated;

-- ---------------------------------------------------------------------------
-- STEP 8: verify_company_name（組織名の入力補助。本番の定義に、確認済みへの絞り込みだけを足す）
--   絞らないと、運送会社が自分で登録した荷主名・住所（未確認）が、組織作成時の
--   候補として他組織に見えてしまう。自組織の未確認施設も候補には出さない
--   （候補は、運営者が確認した荷主名だけにする）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_company_name(_input text)
RETURNS TABLE(matched_client_name text, matched_facility_id uuid, matched_address text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  cleaned text;
  match_count integer;
  result_name text;
  result_id uuid;
  result_address text;
BEGIN
  -- 「株式会社」やスペースなどの表記揺れを除去
  cleaned := regexp_replace(btrim(_input), '(株式会社|有限会社|合同会社|合資会社|合名会社|\(株\)|（株）|㈱|\(有\)|（有）|㈲|\s+)', '', 'g');

  IF length(cleaned) < 2 THEN
    RETURN;
  END IF;

  SELECT count(DISTINCT client_name) INTO match_count
  FROM facilities f
  WHERE f.verification_status = 'verified'
    AND regexp_replace(btrim(f.client_name), '(株式会社|有限会社|合同会社|合資会社|合名会社|\(株\)|（株）|㈱|\(有\)|（有）|㈲|\s+)', '', 'g') ILIKE '%' || cleaned || '%';

  -- 1社だけに特定できた場合のみ返す
  IF match_count = 1 THEN
    SELECT f.client_name, f.id, f.address INTO result_name, result_id, result_address
    FROM facilities f
    WHERE f.verification_status = 'verified'
      AND regexp_replace(btrim(f.client_name), '(株式会社|有限会社|合同会社|合資会社|合名会社|\(株\)|（株）|㈱|\(有\)|（有）|㈲|\s+)', '', 'g') ILIKE '%' || cleaned || '%'
    LIMIT 1;

    matched_client_name := result_name;
    matched_facility_id := result_id;
    matched_address := result_address;
    RETURN NEXT;
  END IF;

  RETURN;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.verify_company_name(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.verify_company_name(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- STEP 9: wait_logs の INSERT トリガー（最後の砦）
--   issue_ticket 以外の経路（approve_pending_punch など）でも、未確認の施設に
--   登録組織外のメンバーの記録が入らないようにする。
--   20260720130000 の定義に、施設の利用可否の検査を足しただけ。
--   ※ INSERT 時点の所属で判定する。後からドライバーが組織を離れても、
--      既存の待機の完了（start_loading / complete_ticket）は止めない（INSERT しないため）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_wait_log_geofence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_facility_lat    DOUBLE PRECISION;
  v_facility_lng    DOUBLE PRECISION;
  v_facility_radius INTEGER;
  v_distance_m      DOUBLE PRECISION;
BEGIN
  SELECT f.lat, f.lng, f.radius
  INTO v_facility_lat, v_facility_lng, v_facility_radius
  FROM public.facilities f
  WHERE f.id = NEW.facility_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION '[法的保護] 指定された施設が見つかりません。 (facility_id: %)', NEW.facility_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT public.can_use_facility(NEW.user_id, NEW.facility_id) THEN
    RAISE EXCEPTION '[法的保護] 未確認の施設は、登録した組織のメンバーしか打刻できません。'
      USING ERRCODE = 'check_violation';
  END IF;

  -- get_nearest_facility と同一の Haversine 式で距離(m)を算出する
  v_distance_m := 6371000 * 2 * asin(sqrt(
    sin(radians(v_facility_lat - NEW.latitude) / 2) ^ 2 +
    cos(radians(NEW.latitude)) * cos(radians(v_facility_lat)) *
    sin(radians(v_facility_lng - NEW.longitude) / 2) ^ 2
  ));

  IF v_distance_m > v_facility_radius THEN
    RAISE EXCEPTION '[法的保護] 500m圏外のため打刻できません。（施設からの距離: 約%m）',
      ROUND(v_distance_m::numeric)
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
