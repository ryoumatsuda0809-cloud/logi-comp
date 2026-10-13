-- =============================================================================
-- 提出日報の待機時間・待機料を、サーバーが wait_logs から計算する
--
-- 【なぜ必要か】
--   これまで submitted_reports は、画面（DailyReportConfirm）が組み立てた
--   total_wait_minutes / estimated_wait_cost / timeline_snapshot をクライアントが
--   そのまま INSERT していた。クライアントを信用しない（CLAUDE.md）なら、
--   待機料の根拠になる数値はサーバーが証拠（wait_logs）から計算すべき。
--   20260806180000 のコメントにあった「数値のサーバー側再計算は未実装」の解消。
--
-- 【やること】
--   1. 料率を wait_rates（DB）に1か所だけ持つ。クライアントロールは読み取りのみ。
--   2. 月次ビュー monthly_wait_risk_reports を、その表を使うように作り直す。
--      出力の列・値は変えない（CASE 直書きの料率をやめるだけ）。
--   3. 計算関数 calc_daily_wait_totals と、提出 RPC submit_daily_report を作る。
--      金額・GPS 記録の待機分数は引数にしない（サーバーが計算する）。
--   4. submitted_reports への直接 INSERT を authenticated / anon から剥奪する。
--
-- 【計算規則（src/lib/waitCostCalc.ts / src/lib/waitLogToTimeline.ts と一致させる）】
--   - 対象: 呼び出したユーザー本人の wait_logs。取消済み（status='cancelled'）は除く。
--   - 日付: COALESCE(claimed_at, arrival_time) を日本時間に直した日（整理券番号の
--     採番と同じ基準。等級C は承認日ではなく申告した到着日に属する）。
--   - 待機1回の分数: COALESCE(claimed_loading_at, work_start_time, called_time) と
--     COALESCE(claimed_at, arrival_time) の差を分に四捨五入（JS の Math.round と同じく
--     .5 は切り上げ）。0 未満は 0。荷役開始側が全て NULL なら「算定不能」（分数 NULL）。
--     work_end_time へフォールバックしてはならない（荷役時間が待機料に混入する）。
--   - 待機料: 待機1回ごとに 30 分を控除して GREATEST(分 - 30, 0) × 円/分、その合計。
--   - 円/分: profiles.vehicle_class を wait_rates で引く。該当なし・未設定は既定行。
--
-- 【既存の挙動との違い（意図したもの）】
--   画面の合計はこれまで compliance_logs（旧）と音声日報の申告待機分も足していた。
--   サーバーは証拠（wait_logs）だけを数える。音声の自己申告は合計に入らない。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- STEP 1: 料率表 wait_rates
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wait_rates (
  vehicle_class  text    PRIMARY KEY,
  yen_per_minute integer NOT NULL CHECK (yen_per_minute > 0),
  -- 該当する車格が無い・未設定のときに使う行。ちょうど1行だけ true にできる。
  is_default     boolean NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX IF NOT EXISTS wait_rates_one_default_uidx
  ON public.wait_rates ((true)) WHERE is_default;

-- 現行の料率（src/lib/waitCostCalc.ts の RATE_MAP と、旧ビューの CASE と同じ値）。
-- 既定は 4t の行（waitCostCalc.ts の DEFAULT_VEHICLE_CLASS = '4t'、旧ビューの ELSE 50）。
INSERT INTO public.wait_rates (vehicle_class, yen_per_minute, is_default) VALUES
  ('2t',  40, false),
  ('4t',  50, true),
  ('10t', 60, false)
ON CONFLICT (vehicle_class) DO NOTHING;

ALTER TABLE public.wait_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wait_rates readable" ON public.wait_rates;
CREATE POLICY "wait_rates readable"
  ON public.wait_rates FOR SELECT TO anon, authenticated
  USING (true);

-- 読み取りのみ。料率の変更はマイグレーションで行う。
-- anon に SELECT を残すのは、security_invoker のビューを anon が引いても
-- 従来どおり「空」で返る（権限エラーにならない）ようにするため。料率は秘密ではない。
REVOKE ALL ON public.wait_rates FROM anon, authenticated;
GRANT SELECT ON public.wait_rates TO anon, authenticated;

COMMENT ON TABLE public.wait_rates IS
  '待機料の料率（円/分）。料率を持つ唯一の場所。変更はマイグレーションのみ。提出済み日報は submitted_reports.server_calculation に適用した料率を残す。';

-- 車格 → 円/分。該当なし・NULL・空文字は既定行。
CREATE OR REPLACE FUNCTION public.wait_yen_per_minute(p_vehicle_class text)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT COALESCE(
    (SELECT r.yen_per_minute FROM public.wait_rates r WHERE r.vehicle_class = p_vehicle_class),
    (SELECT d.yen_per_minute FROM public.wait_rates d WHERE d.is_default)
  );
$$;

REVOKE ALL ON FUNCTION public.wait_yen_per_minute(text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- STEP 2: 月次ビューを料率表を使うように作り直す
--   出力の列・値は 20260803110000 と同じ。変えたのは料率の引き方だけ。
--   CREATE OR REPLACE なので、既存の権限（GRANT）はそのまま保たれる。
--   security_invoker は維持。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.monthly_wait_risk_reports
WITH (security_invoker = true) AS
WITH visit AS (
  SELECT
    f.client_name AS client_organization_name,
    f.name        AS location_name,
    date_trunc('month', w.work_end_time AT TIME ZONE 'Asia/Tokyo')
      AT TIME ZONE 'Asia/Tokyo' AS report_month,
    w.evidence_grade,
    -- 単価（円/分）。wait_rates を引く。該当なし・未設定は既定行。
    COALESCE(r.yen_per_minute, d.yen_per_minute) AS rate_jpy_per_min,
    -- 荷待ち時間（分）。到着から荷役開始まで。
    -- 等級Cでは claimed_* が実際の時刻、arrival_time / work_start_time は承認時刻。
    -- 終端が一つも無い場合は NULL（算定不能）とし、作業完了へはフォールバックしない。
    -- work_end_time で代替すると荷役作業時間が待機料に混入し過大請求になる。
    CASE
      WHEN COALESCE(w.claimed_loading_at, w.work_start_time, w.called_time) IS NOT NULL
      THEN GREATEST(
        EXTRACT(EPOCH FROM (
          COALESCE(w.claimed_loading_at, w.work_start_time, w.called_time)
          - COALESCE(w.claimed_at, w.arrival_time)
        )) / 60,
        0
      )
      ELSE NULL
    END AS wait_minutes
  FROM public.wait_logs w
    JOIN public.facilities f ON f.id = w.facility_id
    JOIN public.profiles   p ON p.user_id = w.user_id
    LEFT JOIN public.wait_rates r ON r.vehicle_class = p.vehicle_class
    LEFT JOIN public.wait_rates d ON d.is_default
  WHERE w.status = 'completed'      -- cancelled は除外される
    AND w.work_end_time IS NOT NULL
)
SELECT
  client_organization_name,
  location_name,
  report_month,
  count(*)                                             AS total_visits,
  count(*) FILTER (WHERE wait_minutes IS NULL)         AS unmeasured_visits,
  count(*) FILTER (WHERE evidence_grade = 'C')         AS approved_claim_visits,
  COALESCE(sum(wait_minutes), 0)::integer              AS total_wait_minutes,
  -- 30分の控除は待機1回ごと。合計に一度だけ適用すると過大になる。
  COALESCE(sum(GREATEST(wait_minutes - 30, 0) * rate_jpy_per_min), 0)::integer
                                                       AS estimated_loss_jpy,
  CASE
    WHEN COALESCE(avg(wait_minutes), 0) >= 60 THEN '高'
    WHEN COALESCE(avg(wait_minutes), 0) >= 30 THEN '中'
    ELSE '低'
  END                                                  AS gmen_risk_level
FROM visit
GROUP BY client_organization_name, location_name, report_month;

COMMENT ON VIEW public.monthly_wait_risk_reports IS
  '荷主別・拠点別の月次待機集計。荷待ち時間は到着〜荷役開始で算定し、待機料は待機1回ごとに30分を控除する。単価は wait_rates（DB）から引く。等級C（圏外申告の承認記録）と算定不能の件数を別列で示す。';

-- ---------------------------------------------------------------------------
-- STEP 3: submitted_reports に、サーバー計算の記録と手修正分の列を足す
--   reported_wait_minutes : 報告書に記載した待機分数（手修正したときだけ）。
--                           total_wait_minutes（サーバーが計算した記録）とは別に残す。
--   server_calculation    : 計算の内訳（適用した料率、待機1回ごとの分数・金額、算定不能の数）。
--                           料率表が将来変わっても、この日報の金額の根拠を再現できる。
--   既存の行は NULL のまま（提出後は変更できないため埋め戻さない）。
-- ---------------------------------------------------------------------------
ALTER TABLE public.submitted_reports
  ADD COLUMN IF NOT EXISTS reported_wait_minutes integer
    CHECK (reported_wait_minutes IS NULL OR reported_wait_minutes >= 0),
  ADD COLUMN IF NOT EXISTS server_calculation jsonb;

COMMENT ON COLUMN public.submitted_reports.reported_wait_minutes IS
  '報告書の文面に記載した待機分数（ドライバーが手で修正した場合のみ）。証拠ではなく表示用。サーバーが計算した記録は total_wait_minutes。';
COMMENT ON COLUMN public.submitted_reports.server_calculation IS
  'サーバー（submit_daily_report）が wait_logs から計算した内訳。適用した料率、待機1回ごとの分数・金額、算定不能の件数。';

-- 同じ日の二重提出を拒否する制約。本番には作成済みだが、これまでのマイグレーションに
-- 無かったので、ここで明示する（同名の索引があれば何もしない）。
CREATE UNIQUE INDEX IF NOT EXISTS submitted_reports_user_id_report_date_key
  ON public.submitted_reports (user_id, report_date);

-- ---------------------------------------------------------------------------
-- STEP 4: 計算関数（内部用。クライアントからは呼べない）
--   指定ユーザー・指定日（日本時間）の待機を wait_logs から計算する。
--   submit_daily_report と、supabase/tests/server_side_report_totals.sql が使う。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.calc_daily_wait_totals(p_user_id uuid, p_date date)
RETURNS TABLE (
  yen_per_minute      integer,
  visit_count         integer,
  unmeasured_visits   integer,
  total_wait_minutes  integer,
  estimated_wait_cost integer,
  visits              jsonb
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  WITH rate AS (
    SELECT public.wait_yen_per_minute(
      (SELECT p.vehicle_class FROM public.profiles p WHERE p.user_id = p_user_id)
    ) AS yen
  ), v AS (
    SELECT
      w.id,
      w.ticket_number,
      COALESCE(w.claimed_at, w.arrival_time) AS arrival_at,
      -- 荷待ちの終端。work_end_time にはフォールバックしない。
      COALESCE(w.claimed_loading_at, w.work_start_time, w.called_time) AS loading_at
    FROM public.wait_logs w
    WHERE w.user_id = p_user_id
      AND w.status IS DISTINCT FROM 'cancelled'
      AND COALESCE(w.claimed_at, w.arrival_time) >= (p_date::timestamp AT TIME ZONE 'Asia/Tokyo')
      AND COALESCE(w.claimed_at, w.arrival_time) <  ((p_date + 1)::timestamp AT TIME ZONE 'Asia/Tokyo')
  ), m AS (
    SELECT
      v.*,
      CASE
        WHEN v.loading_at IS NULL THEN NULL
        -- numeric の round は .5 を切り上げ（JS の Math.round と同じ）。0 未満は 0。
        ELSE GREATEST(round(EXTRACT(EPOCH FROM (v.loading_at - v.arrival_at))::numeric / 60)::integer, 0)
      END AS wait_minutes
    FROM v
  ), c AS (
    SELECT
      m.*,
      CASE
        WHEN m.wait_minutes IS NULL THEN NULL
        -- 30分の控除は待機1回ごと
        ELSE GREATEST(m.wait_minutes - 30, 0) * (SELECT yen FROM rate)
      END AS cost
    FROM m
  )
  SELECT
    (SELECT yen FROM rate)::integer,
    count(*)::integer,
    (count(*) FILTER (WHERE c.wait_minutes IS NULL))::integer,
    COALESCE(sum(c.wait_minutes), 0)::integer,
    COALESCE(sum(c.cost), 0)::integer,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'wait_log_id',   c.id,
          'ticket_number', c.ticket_number,
          'arrival_at',    c.arrival_at,
          'loading_at',    c.loading_at,
          'wait_minutes',  c.wait_minutes,
          'cost',          c.cost
        ) ORDER BY c.arrival_at, c.ticket_number, c.id
      ),
      '[]'::jsonb
    )
  FROM c;
$$;

REVOKE ALL ON FUNCTION public.calc_daily_wait_totals(uuid, date) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.calc_daily_wait_totals(uuid, date) IS
  '内部用。指定ユーザー・指定日（日本時間）の待機を wait_logs から計算する。クライアントからは実行できない（submit_daily_report 経由のみ）。';

-- ---------------------------------------------------------------------------
-- STEP 5: 提出 RPC
--   クライアントから受け取るのは、表示用の情報だけ（報告書の文面、表示用の
--   タイムライン、手修正した待機分数、乖離フラグ）。金額・GPS 記録の待機分数・
--   組織・車格・提出時刻は受け取らない。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_daily_report(
  p_report_date           date,
  p_formal_report         text,
  p_original_ai_output    text    DEFAULT NULL,
  p_timeline_snapshot     jsonb   DEFAULT '[]'::jsonb,
  p_has_discrepancy       boolean DEFAULT false,
  p_is_edited             boolean DEFAULT false,
  p_reported_wait_minutes integer DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_today    date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
  v_org      uuid;
  v_profile_class text;
  v_default_class text;
  v_calc     record;
  v_is_edited boolean;
  v_id       uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'ログインが必要です。' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 提出できるのは、サーバー時計で「今日（日本時間）」の分だけ。
  -- 日付をまたいで画面を開いたままにした場合に、別の日の記録で提出してしまうのを防ぐ。
  IF p_report_date IS DISTINCT FROM v_today THEN
    RAISE EXCEPTION '提出できるのは本日（日本時間）の日報だけです。日付が変わった場合は、画面を開き直してください。'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 表示用の入力の形と大きさの検査
  IF p_timeline_snapshot IS NULL OR jsonb_typeof(p_timeline_snapshot) <> 'array'
     OR octet_length(p_timeline_snapshot::text) > 1000000 THEN
    RAISE EXCEPTION 'タイムラインの形式が正しくありません。画面を開き直してください。'
      USING ERRCODE = 'check_violation';
  END IF;
  IF length(COALESCE(p_formal_report, '')) > 20000
     OR length(COALESCE(p_original_ai_output, '')) > 20000 THEN
    RAISE EXCEPTION '報告書の文面が長すぎます。'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_reported_wait_minutes IS NOT NULL
     AND (p_reported_wait_minutes < 0 OR p_reported_wait_minutes > 10000) THEN
    RAISE EXCEPTION '報告書に記載する待機時間が範囲外です。'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 組織・車格は、呼び出したユーザー自身のプロフィールから取る
  SELECT p.organization_id, p.vehicle_class
    INTO v_org, v_profile_class
  FROM public.profiles p
  WHERE p.user_id = v_uid;

  SELECT d.vehicle_class INTO v_default_class
  FROM public.wait_rates d WHERE d.is_default;

  -- 待機時間と待機料は、サーバーが wait_logs から計算する
  SELECT * INTO v_calc FROM public.calc_daily_wait_totals(v_uid, v_today);
  IF v_calc.yen_per_minute IS NULL THEN
    RAISE EXCEPTION '料率が設定されていません。管理者に連絡してください。'
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.submitted_reports s
    WHERE s.user_id = v_uid AND s.report_date = v_today
  ) THEN
    RAISE EXCEPTION '本日の日報は提出済みです。'
      USING ERRCODE = 'unique_violation';
  END IF;

  -- 手で修正した待機分数がサーバーの計算と違うなら、修正したことを必ず記録する
  v_is_edited := COALESCE(p_is_edited, false)
    OR (p_reported_wait_minutes IS NOT NULL
        AND p_reported_wait_minutes <> v_calc.total_wait_minutes);

  BEGIN
    INSERT INTO public.submitted_reports (
      user_id, organization_id, report_date, vehicle_class,
      total_wait_minutes, estimated_wait_cost,
      has_discrepancy, timeline_snapshot, original_ai_output, is_edited, formal_report,
      reported_wait_minutes, server_calculation
    ) VALUES (
      v_uid, v_org, v_today,
      COALESCE(NULLIF(btrim(v_profile_class), ''), v_default_class, ''),
      v_calc.total_wait_minutes, v_calc.estimated_wait_cost,
      COALESCE(p_has_discrepancy, false), p_timeline_snapshot,
      NULLIF(p_original_ai_output, ''), v_is_edited, NULLIF(p_formal_report, ''),
      p_reported_wait_minutes,
      jsonb_build_object(
        'rule', '待機1回ごとに30分を控除。荷待ちは到着から荷役開始まで（呼出で代替、荷役完了にはしない）。等級Cは申告時刻を使う。',
        'report_date', v_today,
        'profile_vehicle_class', v_profile_class,
        'yen_per_minute', v_calc.yen_per_minute,
        'deduction_minutes', 30,
        'visit_count', v_calc.visit_count,
        'unmeasured_visits', v_calc.unmeasured_visits,
        'total_wait_minutes', v_calc.total_wait_minutes,
        'estimated_wait_cost', v_calc.estimated_wait_cost,
        'visits', v_calc.visits,
        'calculated_at', now()
      )
    )
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    -- 同時に2回押された場合
    RAISE EXCEPTION '本日の日報は提出済みです。'
      USING ERRCODE = 'unique_violation';
  END;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_daily_report(date, text, text, jsonb, boolean, boolean, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_daily_report(date, text, text, jsonb, boolean, boolean, integer)
  TO authenticated;

COMMENT ON FUNCTION public.submit_daily_report(date, text, text, jsonb, boolean, boolean, integer) IS
  '日報を提出する唯一の入口。待機時間・待機料はサーバーが wait_logs から計算する（引数にしない）。提出できるのは本人の本日（日本時間）の分だけ。同じ日の二重提出は拒否。';

-- ---------------------------------------------------------------------------
-- STEP 6: submitted_reports への直接 INSERT を剥奪する
--   提出は submit_daily_report だけ。SELECT は残す（本人の閲覧）。
--   更新・削除は RESTRICTIVE ポリシーとトリガーで引き続き禁止。
--   anon には何も付けない（これまでは表の権限だけ付いていた）。
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.submitted_reports FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.submitted_reports FROM authenticated;

-- INSERT のポリシーは不要になった（権限が無いので使われない）。残すと「直接 INSERT できる」と読める。
DROP POLICY IF EXISTS "Users can insert own report" ON public.submitted_reports;
DROP POLICY IF EXISTS "Users can insert own submitted reports" ON public.submitted_reports;
