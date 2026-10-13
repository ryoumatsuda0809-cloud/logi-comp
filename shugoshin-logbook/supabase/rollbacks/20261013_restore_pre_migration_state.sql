-- =============================================================================
-- ロールバック: 20261013 系の5本のマイグレーションを適用する「前」の状態へ戻す
--
-- 対象のマイグレーション（この順に適用したものを、逆に戻す）
--   1. 20261013100000_register_unverified_facilities.sql
--   2. 20261013100001_shared_report_unverified_facilities.sql
--   3. 20261013200000_server_side_report_totals.sql
--   4. 20261013200001_lock_submitted_reports_direct_insert.sql
--   5. 20261013300000_monthly_report_unverified_visits.sql
--
-- 【いつ使うか】
--   上の5本（または途中まで）を本番に適用した後で、画面や打刻・日報の提出が壊れ、
--   マイグレーションの前の状態へ戻したいとき。どこまで適用済みでも動くように書いてある
--   （無いオブジェクトは IF EXISTS で飛ばす）。
--   実行する場所: Supabase の SQL エディタ、または psql（postgres ロール）。
--   全体が1つのトランザクション。途中で1か所でも失敗すれば、何も変わらない。
--
-- 【戻す先】
--   「5本を適用する前の本番」。2026-10-13 に本番（project qojhncmwmsqzycxrfezv）から
--   読み取り専用で取得した定義（pg_get_functiondef / pg_get_viewdef / pg_policies /
--   proacl / relacl / obj_description）を、そのまま書いてある。リポジトリのマイグレーションの
--   定義ではなく、本番の実際の定義が正。（例: verify_company_name の本体は本番では CRLF 改行。
--   下で改行まで再現してある。）
--   この日付より後に、下の6関数・ビュー・ポリシー・権限を変える別のマイグレーションを入れた場合は、
--   このファイルの該当部分を取得し直すこと（README 参照）。
--
-- 【戻すと失われるもの（この SQL がやること）】
--   * 運送会社の管理者が登録した「未確認の施設」の仕組みが無くなる:
--       facilities.verification_status / registered_by_organization_id / registered_by の3列、
--       register_facility / can_use_facility の2関数。
--       → 未確認の施設が1件でも残っていれば、列を落とさず中断する（下の STEP 0）。
--         列を落とすと、未確認の施設が全組織に見える・打刻に使える状態になってしまうため。
--   * サーバー側の日報計算が無くなる:
--       submit_daily_report / calc_daily_wait_totals / wait_yen_per_minute / protect_default_wait_rate、
--       wait_rates（料率表）、submitted_reports.reported_wait_minutes / server_calculation の2列。
--       → 2列にデータが入った日報が1件でもあれば、中断する（STEP 0）。日報は不変の証拠なので、
--         その内訳を黙って捨てない。
--       → wait_rates が初期値（2t=40 / 4t=50 既定 / 10t=60）から変わっていたら、中断する。
--   * 月次ビュー monthly_wait_risk_reports は、料率を CASE に直書きした元の定義に戻り、
--     unverified_visits 列が無くなる（DROP VIEW → CREATE VIEW。権限は付け直す）。
--   * 共有帳票 get_shared_report から unverified_facility_names が無くなる。
--   * facilities の SELECT ポリシーは元の「authenticated は全件」に戻る。
--   * 【重要】submitted_reports への直接 INSERT が、元どおり authenticated に戻る
--     （表の全権限と、"Users can insert own report" ポリシー）。つまり、クライアントが計算した
--     待機分数・待機料を、そのまま INSERT できる元の状態に戻る。UPDATE / DELETE は、
--     RESTRICTIVE ポリシーとトリガーで引き続き禁止されている。
--   * supabase_migrations.schema_migrations から上の5本の記録を消す（STEP 7）。
--     消さないと、後で supabase db push しても「適用済み」とみなされ、再適用されない。
--
-- 【戻らない・触らないもの】
--   * submitted_reports_user_id_report_date_key（同日の二重提出を拒否する一意制約）:
--     本番には元から有り、マイグレーション3は IF NOT EXISTS で何もしなかった。残す。
--   * facilities / submitted_reports / wait_logs の既存の行。
--   * 5本より前の全てのオブジェクト。
--
-- 【実行前に】
--   1. 5本が適用済みか確認する。2. フロント（src/）を、戻した後の DB と合う版に戻す
--      （submit_daily_report を呼ぶ画面や、unverified_facility_names / unverified_visits を読む画面は、
--       戻した後は動かない）。3. README.md（このフォルダ）を読む。
-- =============================================================================

BEGIN;

-- 本番で長い待ちが出るのを避ける。取れなければ失敗して全体が戻る。やり直せばよい。
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- STEP 0: ガード（データが入っているなら、何も変えずに止める）
--   DROP COLUMN は取り消せない。データが有るなら、人が判断する。
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
  v_col   text;
  v_conds text[] := ARRAY[]::text[];
  v_n     bigint;
BEGIN
  -- (a) facilities の新しい3列に、初期値以外のデータが無いこと
  FOREACH v_col IN ARRAY ARRAY['verification_status', 'registered_by_organization_id', 'registered_by'] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'facilities' AND column_name = v_col
    ) THEN
      v_conds := v_conds || CASE v_col
        WHEN 'verification_status' THEN 'verification_status IS DISTINCT FROM ''verified'''
        ELSE v_col || ' IS NOT NULL'
      END;
    END IF;
  END LOOP;
  IF array_length(v_conds, 1) IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.facilities WHERE ' || array_to_string(v_conds, ' OR ') INTO v_n;
    IF v_n > 0 THEN
      RAISE EXCEPTION
        '中断: facilities に、運送会社の管理者が登録した施設の情報（未確認、または登録組織・登録者の記録）が % 件あります。列を落とすとその記録が消え、未確認の施設が全組織に見える状態になります。README の「データが有るとき」を読み、人が判断してください。', v_n
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- (b) submitted_reports の新しい2列に、データが無いこと
  v_conds := ARRAY[]::text[];
  FOREACH v_col IN ARRAY ARRAY['reported_wait_minutes', 'server_calculation'] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'submitted_reports' AND column_name = v_col
    ) THEN
      v_conds := v_conds || (v_col || ' IS NOT NULL');
    END IF;
  END LOOP;
  IF array_length(v_conds, 1) IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.submitted_reports WHERE ' || array_to_string(v_conds, ' OR ') INTO v_n;
    IF v_n > 0 THEN
      RAISE EXCEPTION
        '中断: submitted_reports に、サーバー計算の内訳（server_calculation）または報告書に記載した待機分数（reported_wait_minutes）が入った日報が % 件あります。日報は不変の証拠です。列を落とすと内訳が失われます。README の「データが有るとき」を読み、人が判断してください。', v_n
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- (c) wait_rates が初期値のままであること（料率を変えていたら、その履歴が消える）
  IF to_regclass('public.wait_rates') IS NOT NULL THEN
    EXECUTE $q$
      SELECT (SELECT count(*) FROM (
                SELECT vehicle_class::text, yen_per_minute::int, is_default FROM public.wait_rates
                EXCEPT
                SELECT * FROM (VALUES ('2t', 40, false), ('4t', 50, true), ('10t', 60, false)) AS v(a, b, c)
              ) x)
           + (SELECT count(*) FROM (
                SELECT * FROM (VALUES ('2t', 40, false), ('4t', 50, true), ('10t', 60, false)) AS v(a, b, c)
                EXCEPT
                SELECT vehicle_class::text, yen_per_minute::int, is_default FROM public.wait_rates
              ) y)
    $q$ INTO v_n;
    IF v_n > 0 THEN
      RAISE EXCEPTION
        '中断: wait_rates が初期値（2t=40円 / 4t=50円（既定）/ 10t=60円）から変わっています。表を落とすと変更後の料率が失われます。README を読み、人が判断してください。'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- STEP 1: 月次ビュー monthly_wait_risk_reports を、本番の元の定義に戻す
--   CREATE OR REPLACE VIEW は列を減らせない（unverified_visits を消せない）ので、
--   DROP VIEW → CREATE VIEW。
--   このビューに依存する他のビューは無い（本番で確認済み）。依存があれば DROP VIEW が失敗して全体が戻る。
--   元の属性: security_invoker=true、所有者 postgres（postgres で実行すれば自動でそうなる）、
--   権限は anon / authenticated / service_role に全権限（relacl = arwdDxtm）、コメントあり。
--   料率は wait_rates ではなく CASE に直書き（wait_rates はこの後で消すので、先にビューを戻す）。
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS public.monthly_wait_risk_reports;

CREATE VIEW public.monthly_wait_risk_reports
WITH (security_invoker = true) AS
 WITH visit AS (
         SELECT f.client_name AS client_organization_name,
            f.name AS location_name,
            (date_trunc('month'::text, (w.work_end_time AT TIME ZONE 'Asia/Tokyo'::text)) AT TIME ZONE 'Asia/Tokyo'::text) AS report_month,
            w.evidence_grade,
                CASE p.vehicle_class
                    WHEN '2t'::text THEN 40
                    WHEN '4t'::text THEN 50
                    WHEN '10t'::text THEN 60
                    ELSE 50
                END AS rate_jpy_per_min,
                CASE
                    WHEN COALESCE(w.claimed_loading_at, w.work_start_time, w.called_time) IS NOT NULL THEN GREATEST(EXTRACT(epoch FROM COALESCE(w.claimed_loading_at, w.work_start_time, w.called_time) - COALESCE(w.claimed_at, w.arrival_time)) / 60::numeric, 0::numeric)
                    ELSE NULL::numeric
                END AS wait_minutes
           FROM public.wait_logs w
             JOIN public.facilities f ON f.id = w.facility_id
             JOIN public.profiles p ON p.user_id = w.user_id
          WHERE w.status = 'completed'::text AND w.work_end_time IS NOT NULL
        )
 SELECT client_organization_name,
    location_name,
    report_month,
    count(*) AS total_visits,
    count(*) FILTER (WHERE wait_minutes IS NULL) AS unmeasured_visits,
    count(*) FILTER (WHERE evidence_grade = 'C'::text) AS approved_claim_visits,
    COALESCE(sum(wait_minutes), 0::numeric)::integer AS total_wait_minutes,
    COALESCE(sum(GREATEST(wait_minutes - 30::numeric, 0::numeric) * rate_jpy_per_min::numeric), 0::numeric)::integer AS estimated_loss_jpy,
        CASE
            WHEN COALESCE(avg(wait_minutes), 0::numeric) >= 60::numeric THEN '高'::text
            WHEN COALESCE(avg(wait_minutes), 0::numeric) >= 30::numeric THEN '中'::text
            ELSE '低'::text
        END AS gmen_risk_level
   FROM visit
  GROUP BY client_organization_name, location_name, report_month;

-- 本番の relacl: postgres / anon / authenticated / service_role のすべてに全権限。
-- いったん全員から外してから付け直す（Supabase の既定権限で付いたものも含め、結果を揃える）。
REVOKE ALL ON public.monthly_wait_risk_reports FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON public.monthly_wait_risk_reports TO anon, authenticated, service_role;

COMMENT ON VIEW public.monthly_wait_risk_reports IS
  '荷主別・拠点別の月次待機集計。荷待ち時間は到着〜荷役開始で算定し、待機料は待機1回ごとに30分を控除する。単価は src/lib/waitCostCalc.ts と一致させること。等級C（圏外申告の承認記録）と算定不能の件数を別列で示す。';

-- ---------------------------------------------------------------------------
-- STEP 2: 置き換えられた既存の関数6本を、本番の元の定義に戻す（権限・コメントも）
--   本番の proacl（PUBLIC への EXECUTE は無い）:
--     enforce_wait_log_geofence : postgres, service_role
--     get_nearest_facility / issue_ticket / queue_offline_punch / verify_company_name
--                               : postgres, service_role, authenticated
--     get_shared_report         : postgres, service_role, anon, authenticated
-- ---------------------------------------------------------------------------

-- 2-1. get_nearest_facility（施設の絞り込みを元に戻す）
CREATE OR REPLACE FUNCTION public.get_nearest_facility(user_lat double precision, user_lng double precision)
 RETURNS TABLE(id uuid, name text, client_name text, lat double precision, lng double precision, radius integer, notification_number text, distance_m double precision)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    f.id, f.name, f.client_name, f.lat, f.lng, f.radius, f.notification_number,
    6371000 * 2 * asin(sqrt(
      sin(radians(f.lat - user_lat) / 2) ^ 2 +
      cos(radians(user_lat)) * cos(radians(f.lat)) *
      sin(radians(f.lng - user_lng) / 2) ^ 2
    )) AS distance_m
  FROM facilities f
  WHERE 6371000 * 2 * asin(sqrt(
      sin(radians(f.lat - user_lat) / 2) ^ 2 +
      cos(radians(user_lat)) * cos(radians(f.lat)) *
      sin(radians(f.lng - user_lng) / 2) ^ 2
    )) <= f.radius
  ORDER BY distance_m ASC
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.get_nearest_facility(double precision, double precision) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_nearest_facility(double precision, double precision) TO service_role, authenticated;
COMMENT ON FUNCTION public.get_nearest_facility(double precision, double precision) IS
  '現在地から radius(既定500m) 圏内で最も近い施設を返す。漁獲番号の組み立てに使う notification_number を含む。';

-- 2-2. issue_ticket（未確認の施設の検査を外す）
CREATE OR REPLACE FUNCTION public.issue_ticket(p_facility_id uuid, p_latitude double precision, p_longitude double precision)
 RETURNS TABLE(new_ticket_number integer, new_arrival_time timestamp with time zone, log_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

REVOKE ALL ON FUNCTION public.issue_ticket(uuid, double precision, double precision) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.issue_ticket(uuid, double precision, double precision) TO service_role, authenticated;
COMMENT ON FUNCTION public.issue_ticket(uuid, double precision, double precision) IS
  '取適法: 到着打刻を発行する。GPS座標を wait_logs と waiting_evidence(arrival) の双方に記録し、時刻はDBサーバー時刻のみを使用する。500mジオフェンス判定は enforce_wait_log_geofence トリガーが担う。';

-- 2-3. queue_offline_punch（最寄り施設の検索の絞り込みを外す）
CREATE OR REPLACE FUNCTION public.queue_offline_punch(p_claimed_at timestamp with time zone, p_latitude double precision, p_longitude double precision, p_client_punch_id uuid, p_punch_type text DEFAULT 'arrival'::text, p_accuracy_m double precision DEFAULT NULL::double precision, p_note text DEFAULT NULL::text, p_wait_log_id uuid DEFAULT NULL::uuid, p_fishery_data jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(punch_id uuid, facility_name text, distance_m double precision, within_geofence boolean, is_duplicate boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

REVOKE ALL ON FUNCTION public.queue_offline_punch(timestamptz, double precision, double precision, uuid, text, double precision, text, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.queue_offline_punch(timestamptz, double precision, double precision, uuid, text, double precision, text, uuid, jsonb) TO service_role, authenticated;
COMMENT ON FUNCTION public.queue_offline_punch(timestamptz, double precision, double precision, uuid, text, double precision, text, uuid, jsonb) IS
  '圏外で記録された打刻を pending_punches に申請として登録する。claimed_at は端末の主張値として保存し、施設解決とジオフェンス判定はサーバーが行う。未承認のため待機料の集計対象にはならない。';

-- 2-4. verify_company_name（確認済みへの絞り込みを外す）
--   本番の本体は CRLF 改行（コンソールで作られたため）。バイト単位で元に戻すため、
--   LF で書いた本体を replace で CRLF にして EXECUTE する。
DO $restore_verify_company_name$
DECLARE
  v_body text := $body$
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
  FROM facilities
  WHERE regexp_replace(btrim(client_name), '(株式会社|有限会社|合同会社|合資会社|合名会社|\(株\)|（株）|㈱|\(有\)|（有）|㈲|\s+)', '', 'g') ILIKE '%' || cleaned || '%';

  -- 1社だけに特定できた場合のみ返す
  IF match_count = 1 THEN
    SELECT f.client_name, f.id, f.address INTO result_name, result_id, result_address
    FROM facilities f
    WHERE regexp_replace(btrim(f.client_name), '(株式会社|有限会社|合同会社|合資会社|合名会社|\(株\)|（株）|㈱|\(有\)|（有）|㈲|\s+)', '', 'g') ILIKE '%' || cleaned || '%'
    LIMIT 1;

    matched_client_name := result_name;
    matched_facility_id := result_id;
    matched_address := result_address;
    RETURN NEXT;
  END IF;

  RETURN;
END;
$body$;
BEGIN
  EXECUTE
    'CREATE OR REPLACE FUNCTION public.verify_company_name(_input text)'
    || ' RETURNS TABLE(matched_client_name text, matched_facility_id uuid, matched_address text)'
    || ' LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''public'''
    || ' AS $function$' || replace(v_body, E'\n', E'\r\n') || '$function$';
END
$restore_verify_company_name$;

REVOKE ALL ON FUNCTION public.verify_company_name(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.verify_company_name(text) TO service_role, authenticated;
COMMENT ON FUNCTION public.verify_company_name(text) IS NULL;

-- 2-5. enforce_wait_log_geofence（wait_logs の INSERT トリガー。未確認の施設の検査を外す）
--   トリガー trg_enforce_wait_log_geofence 自体は変わっていないので、関数だけ戻す。
CREATE OR REPLACE FUNCTION public.enforce_wait_log_geofence()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

REVOKE ALL ON FUNCTION public.enforce_wait_log_geofence() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enforce_wait_log_geofence() TO service_role;
COMMENT ON FUNCTION public.enforce_wait_log_geofence() IS
  '法的保護: wait_logs へのINSERT時、facility_idの施設からlatitude/longitudeが radius(既定500m) を超える場合はINSERTを拒否する。直接INSERT・RPC経由を問わず効く多重防御。';

-- 2-6. get_shared_report（unverified_facility_names を外す）
CREATE OR REPLACE FUNCTION public.get_shared_report(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_link public.report_share_links%ROWTYPE;
  v_rep  public.submitted_reports%ROWTYPE;
  v_carrier text;
  v_shippers jsonb;
BEGIN
  IF p_token IS NULL OR length(p_token) < 32 OR length(p_token) > 128 THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_link
  FROM public.report_share_links
  WHERE token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
    AND revoked_at IS NULL
    AND expires_at > now();
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_rep FROM public.submitted_reports WHERE id = v_link.report_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE public.report_share_links
  SET last_viewed_at = now(), view_count = view_count + 1
  WHERE id = v_link.id;

  SELECT o.name INTO v_carrier FROM public.organizations o WHERE o.id = v_rep.organization_id;

  -- 荷主名は、提出者がその日（日本時間）に打刻した記録の施設IDから引く。
  -- 以前は帳票のスナップショットにある施設「名」で照合していたため、
  -- 同名の施設があると関係のない荷主名が帳票に載った。
  SELECT COALESCE(jsonb_agg(DISTINCT f.client_name), '[]'::jsonb) INTO v_shippers
  FROM public.wait_logs w
  JOIN public.facilities f ON f.id = w.facility_id
  WHERE w.user_id = v_rep.user_id
    AND w.arrival_time >= (v_rep.report_date::timestamp AT TIME ZONE 'Asia/Tokyo')
    AND w.arrival_time <  ((v_rep.report_date + 1)::timestamp AT TIME ZONE 'Asia/Tokyo')
    AND f.client_name IS NOT NULL;

  RETURN jsonb_build_object(
    'id', v_rep.id,
    'report_date', v_rep.report_date,
    'vehicle_class', v_rep.vehicle_class,
    'total_wait_minutes', v_rep.total_wait_minutes,
    'estimated_wait_cost', v_rep.estimated_wait_cost,
    'formal_report', v_rep.formal_report,
    'has_discrepancy', v_rep.has_discrepancy,
    'timeline_snapshot', v_rep.timeline_snapshot,
    'submitted_at', v_rep.submitted_at,
    'carrier_name', v_carrier,
    'shipper_names', v_shippers
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_shared_report(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_shared_report(text) TO service_role, anon, authenticated;
COMMENT ON FUNCTION public.get_shared_report(text) IS NULL;

-- ---------------------------------------------------------------------------
-- STEP 3: facilities の SELECT ポリシーを元に戻し、未確認の施設の関数・列を消す
--   元のポリシー: authenticated_can_select  FOR SELECT TO authenticated USING (true)
--   先に元のポリシーを作ってから新しい方を消す（列を落とす前に、新しいポリシーを外す必要がある）。
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "authenticated_can_select" ON public.facilities;
CREATE POLICY "authenticated_can_select"
  ON public.facilities
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "facilities_select_verified_or_own_org" ON public.facilities;

-- 戻した関数はこれらを呼ばない。依存が残っていれば DROP が失敗して全体が戻る（CASCADE は使わない）。
DROP FUNCTION IF EXISTS public.register_facility(text, text, double precision, double precision, text);
DROP FUNCTION IF EXISTS public.can_use_facility(uuid, uuid);

-- 列を落とす（STEP 0 で、初期値以外のデータが無いことを確認済み）。
-- 列に付いた索引・CHECK・外部キー・コメント・列権限は、列と一緒に消える。明示しておく。
DROP INDEX IF EXISTS public.idx_facilities_registered_by_org;
ALTER TABLE public.facilities DROP CONSTRAINT IF EXISTS facilities_verification_status_check;
ALTER TABLE public.facilities
  DROP COLUMN IF EXISTS verification_status,
  DROP COLUMN IF EXISTS registered_by_organization_id,
  DROP COLUMN IF EXISTS registered_by;

-- ---------------------------------------------------------------------------
-- STEP 4: submitted_reports の権限とポリシーを元に戻す（直接 INSERT を戻す）
--   本番の元の状態:
--     relacl: anon / authenticated / service_role に全権限（arwdDxtm）
--     "Users can insert own report" : PERMISSIVE, INSERT, TO authenticated, WITH CHECK (下)
--     （"Users can insert own submitted reports" は本番に元から無い。作らない。）
--   RESTRICTIVE の "Immutable: ..." と SELECT ポリシー、不変トリガーは、マイグレーションが
--   触っていないので、そのまま。
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.submitted_reports FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON public.submitted_reports TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "Users can insert own report" ON public.submitted_reports;
CREATE POLICY "Users can insert own report"
  ON public.submitted_reports
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (user_id = auth.uid())
    AND (
      (organization_id IS NULL)
      OR (organization_id = '00000000-0000-0000-0000-000000000000'::uuid)
      OR is_member_of_org(auth.uid(), organization_id)
    )
  );

-- ---------------------------------------------------------------------------
-- STEP 5: サーバー側の日報計算を消す（関数 → 列）
--   列の CHECK（reported_wait_minutes >= 0）とコメントは、列と一緒に消える。
--   submitted_reports_user_id_report_date_key は本番に元からある制約なので、消さない。
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.submit_daily_report(date, text, text, jsonb, boolean, boolean, integer);
DROP FUNCTION IF EXISTS public.calc_daily_wait_totals(uuid, date);

ALTER TABLE public.submitted_reports
  DROP COLUMN IF EXISTS reported_wait_minutes,
  DROP COLUMN IF EXISTS server_calculation;

-- ---------------------------------------------------------------------------
-- STEP 6: 料率表 wait_rates と、その関数・トリガーを消す
--   月次ビューは STEP 1 で CASE 直書きに戻してあるので、依存は無い。
--   表を消すと、そのトリガー・ポリシー・索引も消える。
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.wait_yen_per_minute(text);
DROP TABLE IF EXISTS public.wait_rates;
DROP FUNCTION IF EXISTS public.protect_default_wait_rate();

-- ---------------------------------------------------------------------------
-- STEP 7: マイグレーションの適用記録を消す（あれば）
--   消さないと、後の supabase db push が「適用済み」とみなして再適用しない。
--   version（ファイル名の番号）と name（apply_migration で別の番号が付いた場合）の両方で探す。
-- ---------------------------------------------------------------------------
DO $bookkeeping$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    DELETE FROM supabase_migrations.schema_migrations
    WHERE version IN ('20261013100000', '20261013100001', '20261013200000', '20261013200001', '20261013300000')
       OR name IN ('register_unverified_facilities', 'shared_report_unverified_facilities',
                   'server_side_report_totals', 'lock_submitted_reports_direct_insert',
                   'monthly_report_unverified_visits');
  END IF;
END
$bookkeeping$;

-- ---------------------------------------------------------------------------
-- STEP 8: 自己検査（一つでも食い違えば例外 → 全体が戻る）
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_n int;
BEGIN
  -- 足したオブジェクトが残っていない
  IF to_regclass('public.wait_rates') IS NOT NULL THEN
    RAISE EXCEPTION '検査失敗: wait_rates が残っています。';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('register_facility', 'can_use_facility', 'submit_daily_report',
                      'calc_daily_wait_totals', 'wait_yen_per_minute', 'protect_default_wait_rate');
  IF v_n <> 0 THEN
    RAISE EXCEPTION '検査失敗: 足した関数が % 本残っています。', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM information_schema.columns
  WHERE table_schema = 'public'
    AND ((table_name = 'facilities' AND column_name IN ('verification_status', 'registered_by_organization_id', 'registered_by'))
      OR (table_name = 'submitted_reports' AND column_name IN ('reported_wait_minutes', 'server_calculation')));
  IF v_n <> 0 THEN
    RAISE EXCEPTION '検査失敗: 足した列が % 個残っています。', v_n;
  END IF;

  -- 月次ビュー: 元の9列、security_invoker、unverified_visits が無い
  SELECT count(*) INTO v_n FROM pg_attribute
  WHERE attrelid = 'public.monthly_wait_risk_reports'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_n <> 9 THEN
    RAISE EXCEPTION '検査失敗: monthly_wait_risk_reports の列数が % です（9のはず）。', v_n;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.monthly_wait_risk_reports'::regclass
      AND reloptions @> ARRAY['security_invoker=true']
  ) THEN
    RAISE EXCEPTION '検査失敗: monthly_wait_risk_reports の security_invoker が設定されていません。';
  END IF;

  -- facilities のポリシーは元の1本だけ
  SELECT count(*) INTO v_n FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'facilities';
  IF v_n <> 1 OR NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'facilities'
      AND policyname = 'authenticated_can_select' AND qual = 'true'
  ) THEN
    RAISE EXCEPTION '検査失敗: facilities のポリシーが元の状態ではありません。';
  END IF;

  -- submitted_reports に元の INSERT ポリシーがあり、authenticated が INSERT できる
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'submitted_reports'
      AND policyname = 'Users can insert own report' AND cmd = 'INSERT'
  ) THEN
    RAISE EXCEPTION '検査失敗: submitted_reports の INSERT ポリシーが戻っていません。';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.submitted_reports', 'INSERT')
     OR NOT has_table_privilege('anon', 'public.submitted_reports', 'INSERT') THEN
    RAISE EXCEPTION '検査失敗: submitted_reports の元の権限が戻っていません。';
  END IF;

  -- facilities への書き込み権限が authenticated / anon に付いていない（元から無い）
  IF has_table_privilege('authenticated', 'public.facilities', 'INSERT')
     OR has_table_privilege('authenticated', 'public.facilities', 'UPDATE')
     OR has_table_privilege('anon', 'public.facilities', 'INSERT') THEN
    RAISE EXCEPTION '検査失敗: facilities に書き込み権限が付いています（元から無いはず）。';
  END IF;

  -- 戻した関数の実行権限（PUBLIC / anon に開いていないこと）
  IF has_function_privilege('anon', 'public.issue_ticket(uuid, double precision, double precision)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_nearest_facility(double precision, double precision)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.verify_company_name(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.enforce_wait_log_geofence()', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.get_shared_report(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '検査失敗: 関数の実行権限が元の状態ではありません。';
  END IF;
END
$verify$;

COMMIT;
