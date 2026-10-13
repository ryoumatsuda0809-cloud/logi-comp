-- =============================================================================
-- 提出日報の数値をサーバーが計算することの回帰テスト
--   （20261013200000_server_side_report_totals.sql の検証）
--
-- 使い方: Supabase の SQL Editor（または psql）にそのまま貼って実行する。
--   結果は例外メッセージとして返り、**必ずロールバックされる**（データは残らない）。
--   `[OK]` 以外（[NG] / [??]）が1つでもあれば、算定が崩れている。
--   security_checks.sql と同じ形式。
--
-- 確認すること:
--   1. 計算: calc_daily_wait_totals の結果が、下の v_cases の期待値と一致する
--      （期待値は src/lib/waitCostCalc.ts / waitLogToTimeline.ts を読んで手計算したもの）。
--   2. 同じ v_cases を TypeScript 側（src/lib/serverTotalsParity.test.ts）も読み、
--      convertWaitLogsToTimeline + sumWaitCost の結果が同じ期待値になることを確認している。
--      つまり「同じ入力に対して SQL と TypeScript が同じ答えを出す」ことを、
--      1つの表（v_cases）を両方が検証することで担保する。
--      v_cases を変えるときは、このファイルの JSON だけを直す（TypeScript は SQL ファイルから読む）。
--   3. 月次ビュー monthly_wait_risk_reports が、料率を CASE 直書きしていた旧定義と
--      同じ結果を返す（車格 2t / 4t / 10t / 未設定 / 該当なし / 空で確認）。
--   4. submit_daily_report: 未ログイン拒否、日付違い拒否、本人の今日分をサーバーが計算して保存、
--      手修正した待機分数は別の列に残る、二重提出の拒否、直接 INSERT の拒否。
--   5. 権限: wait_rates は読み取りのみ、内部関数は誰も実行できない。
--
-- 手計算の表（4t=50円/分、2t=40、10t=60。待機1回ごとに30分控除）:
--   normal-72min          09:00→荷役開始10:12 = 72分。(72-30)*50 = 2100円。呼出09:30は使わない（荷役開始が優先）
--   within-30min-is-free  30分・20分。どちらも30分以下 → 0円（合計は50分）
--   deduct-30min-per-visit-2t  40分×2、2t。(40-30)*40*2 = 800円（日合計80分に1回だけ控除すると(80-30)*40=2000で過大）
--   grade-C-approval-day-claimed-minutes  申告 3/13 14:00→15:10 = 70分。(70-30)*50 = 2000円。
--                          どの日に入るかは arrival_time（=承認した日 3/15）。申告日 3/13 の日報には入らない（0件）。分数は申告時刻から
--   cancelled-is-excluded 有効な40分 → 500円。取消済みの120分（呼出あり）は数えない
--   unmeasured-and-called-fallback  60分→1500 / 呼出で代替45分→750 / 荷役開始なし（作業完了17:00は使わない）→算定不能 / 待機中で時刻なし→算定不能
--                          合計105分、2250円、算定不能2件
--   midnight-boundary-jst 3/20 00:00:00 到着(35分→250) と 3/20 23:50 到着(50分→1000) は3/20、
--                          3/21 00:00:00 到着(31分→50) と 00:05 到着(45分→750) は3/21、
--                          3/19 23:59:59 到着(50分01秒→50分→1000) は3/19
--   rate-for-vehicle-class-*  60分 → 30分課金。2t:1200 / 4t:1500 / 10t:1800 / 未設定・trailer・空:既定(4t)の1500
--   rounding-and-clamp    30分40秒→31分(50円) / 30分29秒→30分(0円) / 荷役開始が到着より前→0分 /
--                          40分30秒→41分(550円; .5は切り上げ)。合計102分、600円
--
-- 前提: public.facilities に1件以上あり、public.profiles に1件以上ユーザーがいること。
-- =============================================================================
DO $$
DECLARE
  -- BEGIN CASES (TypeScript テストがここから読む。ドル引用符で囲まれた JSON の配列)
  v_cases jsonb := $json$
[
  {"name": "normal-72min", "vehicle_class": "4t", "yen_per_minute": 50, "logs": [{"status": "completed", "arrival_time": "2001-03-10T09:00:00+09:00", "called_time": "2001-03-10T09:30:00+09:00", "work_start_time": "2001-03-10T10:12:00+09:00", "work_end_time": "2001-03-10T11:00:00+09:00"}], "checks": [{"date": "2001-03-10", "visit_count": 1, "unmeasured_visits": 0, "total_wait_minutes": 72, "estimated_wait_cost": 2100}]},
  {"name": "within-30min-is-free", "vehicle_class": "4t", "yen_per_minute": 50, "logs": [{"status": "completed", "arrival_time": "2001-03-11T09:00:00+09:00", "called_time": null, "work_start_time": "2001-03-11T09:30:00+09:00", "work_end_time": "2001-03-11T10:00:00+09:00"}, {"status": "completed", "arrival_time": "2001-03-11T11:00:00+09:00", "called_time": null, "work_start_time": "2001-03-11T11:20:00+09:00", "work_end_time": "2001-03-11T12:00:00+09:00"}], "checks": [{"date": "2001-03-11", "visit_count": 2, "unmeasured_visits": 0, "total_wait_minutes": 50, "estimated_wait_cost": 0}]},
  {"name": "deduct-30min-per-visit-2t", "vehicle_class": "2t", "yen_per_minute": 40, "logs": [{"status": "completed", "arrival_time": "2001-03-12T09:00:00+09:00", "called_time": null, "work_start_time": "2001-03-12T09:40:00+09:00", "work_end_time": "2001-03-12T10:30:00+09:00"}, {"status": "completed", "arrival_time": "2001-03-12T13:00:00+09:00", "called_time": null, "work_start_time": "2001-03-12T13:40:00+09:00", "work_end_time": "2001-03-12T14:30:00+09:00"}], "checks": [{"date": "2001-03-12", "visit_count": 2, "unmeasured_visits": 0, "total_wait_minutes": 80, "estimated_wait_cost": 800}]},
  {"name": "grade-C-approval-day-claimed-minutes", "vehicle_class": "4t", "yen_per_minute": 50, "logs": [{"status": "completed", "arrival_time": "2001-03-15T10:00:00+09:00", "called_time": null, "work_start_time": "2001-03-15T10:05:00+09:00", "work_end_time": "2001-03-15T10:30:00+09:00", "evidence_grade": "C", "claimed_at": "2001-03-13T14:00:00+09:00", "claimed_loading_at": "2001-03-13T15:10:00+09:00", "claimed_end_at": "2001-03-13T15:50:00+09:00"}], "checks": [{"date": "2001-03-15", "visit_count": 1, "unmeasured_visits": 0, "total_wait_minutes": 70, "estimated_wait_cost": 2000}, {"date": "2001-03-13", "visit_count": 0, "unmeasured_visits": 0, "total_wait_minutes": 0, "estimated_wait_cost": 0}]},
  {"name": "cancelled-is-excluded", "vehicle_class": "4t", "yen_per_minute": 50, "logs": [{"status": "completed", "arrival_time": "2001-03-14T09:00:00+09:00", "called_time": null, "work_start_time": "2001-03-14T09:40:00+09:00", "work_end_time": "2001-03-14T10:00:00+09:00"}, {"status": "cancelled", "arrival_time": "2001-03-14T13:00:00+09:00", "called_time": "2001-03-14T15:00:00+09:00", "work_start_time": null, "work_end_time": null}], "checks": [{"date": "2001-03-14", "visit_count": 1, "unmeasured_visits": 0, "total_wait_minutes": 40, "estimated_wait_cost": 500}]},
  {"name": "unmeasured-and-called-fallback", "vehicle_class": "4t", "yen_per_minute": 50, "logs": [{"status": "completed", "arrival_time": "2001-03-16T09:00:00+09:00", "called_time": null, "work_start_time": "2001-03-16T10:00:00+09:00", "work_end_time": "2001-03-16T10:30:00+09:00"}, {"status": "completed", "arrival_time": "2001-03-16T12:00:00+09:00", "called_time": "2001-03-16T12:45:00+09:00", "work_start_time": null, "work_end_time": "2001-03-16T14:00:00+09:00"}, {"status": "completed", "arrival_time": "2001-03-16T15:00:00+09:00", "called_time": null, "work_start_time": null, "work_end_time": "2001-03-16T17:00:00+09:00"}, {"status": "waiting", "arrival_time": "2001-03-16T18:00:00+09:00", "called_time": null, "work_start_time": null, "work_end_time": null}], "checks": [{"date": "2001-03-16", "visit_count": 4, "unmeasured_visits": 2, "total_wait_minutes": 105, "estimated_wait_cost": 2250}]},
  {"name": "midnight-boundary-jst", "vehicle_class": "4t", "yen_per_minute": 50, "logs": [{"status": "completed", "arrival_time": "2001-03-20T00:00:00+09:00", "called_time": null, "work_start_time": "2001-03-20T00:35:00+09:00", "work_end_time": "2001-03-20T01:00:00+09:00"}, {"status": "completed", "arrival_time": "2001-03-20T23:50:00+09:00", "called_time": null, "work_start_time": "2001-03-21T00:40:00+09:00", "work_end_time": "2001-03-21T01:00:00+09:00"}, {"status": "completed", "arrival_time": "2001-03-21T00:00:00+09:00", "called_time": null, "work_start_time": "2001-03-21T00:31:00+09:00", "work_end_time": "2001-03-21T01:00:00+09:00"}, {"status": "completed", "arrival_time": "2001-03-21T00:05:00+09:00", "called_time": null, "work_start_time": "2001-03-21T00:50:00+09:00", "work_end_time": "2001-03-21T01:30:00+09:00"}, {"status": "completed", "arrival_time": "2001-03-19T23:59:59+09:00", "called_time": null, "work_start_time": "2001-03-20T00:50:00+09:00", "work_end_time": "2001-03-20T01:30:00+09:00"}], "checks": [{"date": "2001-03-19", "visit_count": 1, "unmeasured_visits": 0, "total_wait_minutes": 50, "estimated_wait_cost": 1000}, {"date": "2001-03-20", "visit_count": 2, "unmeasured_visits": 0, "total_wait_minutes": 85, "estimated_wait_cost": 1250}, {"date": "2001-03-21", "visit_count": 2, "unmeasured_visits": 0, "total_wait_minutes": 76, "estimated_wait_cost": 800}]},
  {"name": "rate-for-vehicle-class-2t", "vehicle_class": "2t", "yen_per_minute": 40, "logs": [{"status": "completed", "arrival_time": "2001-04-01T09:00:00+09:00", "called_time": null, "work_start_time": "2001-04-01T10:00:00+09:00", "work_end_time": "2001-04-01T10:30:00+09:00"}], "checks": [{"date": "2001-04-01", "visit_count": 1, "unmeasured_visits": 0, "total_wait_minutes": 60, "estimated_wait_cost": 1200}]},
  {"name": "rate-for-vehicle-class-4t", "vehicle_class": "4t", "yen_per_minute": 50, "logs": [{"status": "completed", "arrival_time": "2001-04-02T09:00:00+09:00", "called_time": null, "work_start_time": "2001-04-02T10:00:00+09:00", "work_end_time": "2001-04-02T10:30:00+09:00"}], "checks": [{"date": "2001-04-02", "visit_count": 1, "unmeasured_visits": 0, "total_wait_minutes": 60, "estimated_wait_cost": 1500}]},
  {"name": "rate-for-vehicle-class-10t", "vehicle_class": "10t", "yen_per_minute": 60, "logs": [{"status": "completed", "arrival_time": "2001-04-03T09:00:00+09:00", "called_time": null, "work_start_time": "2001-04-03T10:00:00+09:00", "work_end_time": "2001-04-03T10:30:00+09:00"}], "checks": [{"date": "2001-04-03", "visit_count": 1, "unmeasured_visits": 0, "total_wait_minutes": 60, "estimated_wait_cost": 1800}]},
  {"name": "rate-for-vehicle-class-NULL", "vehicle_class": null, "yen_per_minute": 50, "logs": [{"status": "completed", "arrival_time": "2001-04-04T09:00:00+09:00", "called_time": null, "work_start_time": "2001-04-04T10:00:00+09:00", "work_end_time": "2001-04-04T10:30:00+09:00"}], "checks": [{"date": "2001-04-04", "visit_count": 1, "unmeasured_visits": 0, "total_wait_minutes": 60, "estimated_wait_cost": 1500}]},
  {"name": "rate-for-vehicle-class-trailer", "vehicle_class": "trailer", "yen_per_minute": 50, "logs": [{"status": "completed", "arrival_time": "2001-04-05T09:00:00+09:00", "called_time": null, "work_start_time": "2001-04-05T10:00:00+09:00", "work_end_time": "2001-04-05T10:30:00+09:00"}], "checks": [{"date": "2001-04-05", "visit_count": 1, "unmeasured_visits": 0, "total_wait_minutes": 60, "estimated_wait_cost": 1500}]},
  {"name": "rate-for-vehicle-class-empty", "vehicle_class": "", "yen_per_minute": 50, "logs": [{"status": "completed", "arrival_time": "2001-04-06T09:00:00+09:00", "called_time": null, "work_start_time": "2001-04-06T10:00:00+09:00", "work_end_time": "2001-04-06T10:30:00+09:00"}], "checks": [{"date": "2001-04-06", "visit_count": 1, "unmeasured_visits": 0, "total_wait_minutes": 60, "estimated_wait_cost": 1500}]},
  {"name": "rounding-and-clamp", "vehicle_class": "4t", "yen_per_minute": 50, "logs": [{"status": "completed", "arrival_time": "2001-05-01T09:00:00+09:00", "called_time": null, "work_start_time": "2001-05-01T09:30:40+09:00", "work_end_time": "2001-05-01T10:00:00+09:00"}, {"status": "completed", "arrival_time": "2001-05-01T11:00:00+09:00", "called_time": null, "work_start_time": "2001-05-01T11:30:29+09:00", "work_end_time": "2001-05-01T12:00:00+09:00"}, {"status": "completed", "arrival_time": "2001-05-01T13:00:00+09:00", "called_time": null, "work_start_time": "2001-05-01T12:50:00+09:00", "work_end_time": "2001-05-01T13:30:00+09:00"}, {"status": "completed", "arrival_time": "2001-05-01T15:00:00+09:00", "called_time": null, "work_start_time": "2001-05-01T15:40:30+09:00", "work_end_time": "2001-05-01T16:00:00+09:00"}], "checks": [{"date": "2001-05-01", "visit_count": 4, "unmeasured_visits": 0, "total_wait_minutes": 102, "estimated_wait_cost": 600}]}
]
  $json$;
  -- END CASES
  v_res    text := '';
  v_uid    uuid;
  v_fac    record;
  v_case   jsonb;
  v_log    jsonb;
  v_chk    jsonb;
  v_id     uuid;
  v_ticket integer := 900000;
  v_calc   record;
  v_ok     boolean;
  v_diff   integer;
  v_vc     text;
  v_today  date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
  v_rpc_uid uuid;
  v_rep    public.submitted_reports%ROWTYPE;
  v_rid    uuid;
  v_n      integer;
  v_args   text;
BEGIN
  SELECT user_id INTO v_uid FROM public.profiles ORDER BY created_at LIMIT 1;
  SELECT id, lat, lng INTO v_fac FROM public.facilities ORDER BY created_at LIMIT 1;
  IF v_uid IS NULL OR v_fac.id IS NULL THEN
    RAISE EXCEPTION 'テストの前提が足りません（profiles / facilities が空です）';
  END IF;
  IF EXISTS (SELECT 1 FROM public.wait_logs WHERE user_id = v_uid AND arrival_time < '2002-01-01') THEN
    RAISE EXCEPTION 'テストの前提が崩れています（このユーザーに2001年の記録があります）';
  END IF;

  -- ---------------------------------------------------------------------------
  -- 0. 料率表
  -- ---------------------------------------------------------------------------
  SELECT count(*) INTO v_n FROM public.wait_rates;
  v_res := v_res || CASE WHEN v_n = 3
      AND (SELECT yen_per_minute FROM public.wait_rates WHERE vehicle_class = '2t')  = 40
      AND (SELECT yen_per_minute FROM public.wait_rates WHERE vehicle_class = '4t')  = 50
      AND (SELECT yen_per_minute FROM public.wait_rates WHERE vehicle_class = '10t') = 60
      AND (SELECT count(*) FROM public.wait_rates WHERE is_default) = 1
      AND (SELECT vehicle_class FROM public.wait_rates WHERE is_default) = '4t'
    THEN E'\n[OK] 料率表: 2t=40 / 4t=50 / 10t=60、既定は4t' ELSE E'\n[NG] 料率表の内容が想定と違う' END;

  -- ---------------------------------------------------------------------------
  -- 1. 計算（calc_daily_wait_totals）。テストデータはここで作り、最後にロールバックされる。
  --    arrival_time は INSERT 時にトリガーがサーバー時刻へ上書きするため、INSERT のあとで UPDATE する。
  -- ---------------------------------------------------------------------------
  FOR v_case IN SELECT * FROM jsonb_array_elements(v_cases) LOOP
    UPDATE public.profiles SET vehicle_class = (v_case->>'vehicle_class') WHERE user_id = v_uid;

    FOR v_log IN SELECT * FROM jsonb_array_elements(v_case->'logs') LOOP
      v_ticket := v_ticket + 1;
      INSERT INTO public.wait_logs (facility_id, user_id, ticket_number, status, latitude, longitude)
      VALUES (v_fac.id, v_uid, v_ticket, 'waiting', v_fac.lat, v_fac.lng)
      RETURNING id INTO v_id;
      UPDATE public.wait_logs SET
        status             = v_log->>'status',
        arrival_time       = (v_log->>'arrival_time')::timestamptz,
        called_time        = (v_log->>'called_time')::timestamptz,
        work_start_time    = (v_log->>'work_start_time')::timestamptz,
        work_end_time      = (v_log->>'work_end_time')::timestamptz,
        evidence_grade     = COALESCE(v_log->>'evidence_grade', 'A'),
        claimed_at         = (v_log->>'claimed_at')::timestamptz,
        claimed_loading_at = (v_log->>'claimed_loading_at')::timestamptz,
        claimed_end_at     = (v_log->>'claimed_end_at')::timestamptz
      WHERE id = v_id;
    END LOOP;

    FOR v_chk IN SELECT * FROM jsonb_array_elements(v_case->'checks') LOOP
      SELECT * INTO v_calc FROM public.calc_daily_wait_totals(v_uid, (v_chk->>'date')::date);
      v_ok := v_calc.yen_per_minute      = (v_case->>'yen_per_minute')::int
          AND v_calc.visit_count         = (v_chk->>'visit_count')::int
          AND v_calc.unmeasured_visits   = (v_chk->>'unmeasured_visits')::int
          AND v_calc.total_wait_minutes  = (v_chk->>'total_wait_minutes')::int
          AND v_calc.estimated_wait_cost = (v_chk->>'estimated_wait_cost')::int;
      v_res := v_res || CASE WHEN v_ok
        THEN format(E'\n[OK] 計算 %s %s: %s分 / %s円 / 算定不能%s', v_case->>'name', v_chk->>'date',
                    v_calc.total_wait_minutes, v_calc.estimated_wait_cost, v_calc.unmeasured_visits)
        ELSE format(E'\n[NG] 計算 %s %s: 期待 %s分/%s円/不能%s/件数%s/料率%s、実際 %s分/%s円/不能%s/件数%s/料率%s',
                    v_case->>'name', v_chk->>'date',
                    v_chk->>'total_wait_minutes', v_chk->>'estimated_wait_cost', v_chk->>'unmeasured_visits',
                    v_chk->>'visit_count', v_case->>'yen_per_minute',
                    v_calc.total_wait_minutes, v_calc.estimated_wait_cost, v_calc.unmeasured_visits,
                    v_calc.visit_count, v_calc.yen_per_minute) END;
    END LOOP;
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- 3. 月次ビュー: 料率の CASE 直書きだった旧定義（20260803110000）と同じ結果か
  --    （テストの logs と実データ全体を、車格ごとに旧定義と突き合わせる）
  -- ---------------------------------------------------------------------------
  FOREACH v_vc IN ARRAY ARRAY['2t', '4t', '10t', 'trailer', '']::text[] || ARRAY[NULL]::text[] LOOP
    UPDATE public.profiles SET vehicle_class = v_vc WHERE user_id = v_uid;
    WITH legacy AS (
      WITH visit AS (
        SELECT
          f.client_name AS client_organization_name,
          f.name        AS location_name,
          date_trunc('month', w.work_end_time AT TIME ZONE 'Asia/Tokyo')
            AT TIME ZONE 'Asia/Tokyo' AS report_month,
          w.evidence_grade,
          CASE p.vehicle_class WHEN '2t' THEN 40 WHEN '4t' THEN 50 WHEN '10t' THEN 60 ELSE 50 END AS rate_jpy_per_min,
          CASE
            WHEN COALESCE(w.claimed_loading_at, w.work_start_time, w.called_time) IS NOT NULL
            THEN GREATEST(
              EXTRACT(EPOCH FROM (
                COALESCE(w.claimed_loading_at, w.work_start_time, w.called_time)
                - COALESCE(w.claimed_at, w.arrival_time)
              )) / 60, 0)
            ELSE NULL
          END AS wait_minutes
        FROM public.wait_logs w
          JOIN public.facilities f ON f.id = w.facility_id
          JOIN public.profiles   p ON p.user_id = w.user_id
        WHERE w.status = 'completed' AND w.work_end_time IS NOT NULL
      )
      SELECT
        client_organization_name, location_name, report_month,
        count(*) AS total_visits,
        count(*) FILTER (WHERE wait_minutes IS NULL) AS unmeasured_visits,
        count(*) FILTER (WHERE evidence_grade = 'C') AS approved_claim_visits,
        COALESCE(sum(wait_minutes), 0)::integer AS total_wait_minutes,
        COALESCE(sum(GREATEST(wait_minutes - 30, 0) * rate_jpy_per_min), 0)::integer AS estimated_loss_jpy,
        CASE
          WHEN COALESCE(avg(wait_minutes), 0) >= 60 THEN '高'
          WHEN COALESCE(avg(wait_minutes), 0) >= 30 THEN '中'
          ELSE '低'
        END AS gmen_risk_level
      FROM visit
      GROUP BY client_organization_name, location_name, report_month
    )
    SELECT count(*) INTO v_diff FROM (
      (SELECT * FROM legacy EXCEPT ALL SELECT client_organization_name, location_name, report_month, total_visits, unmeasured_visits, approved_claim_visits, total_wait_minutes, estimated_loss_jpy, gmen_risk_level FROM public.monthly_wait_risk_reports)
      UNION ALL
      (SELECT client_organization_name, location_name, report_month, total_visits, unmeasured_visits, approved_claim_visits, total_wait_minutes, estimated_loss_jpy, gmen_risk_level FROM public.monthly_wait_risk_reports EXCEPT ALL SELECT * FROM legacy)
    ) d;
    v_res := v_res || CASE WHEN v_diff = 0
      THEN format(E'\n[OK] 月次ビューは旧定義と同じ結果（車格=%s）', COALESCE(NULLIF(v_vc, ''), CASE WHEN v_vc IS NULL THEN 'NULL' ELSE '空' END))
      ELSE format(E'\n[NG] 月次ビューが旧定義と違う（車格=%s、差分%s行）', COALESCE(v_vc, 'NULL'), v_diff) END;
  END LOOP;
  SELECT count(*) INTO v_n FROM public.monthly_wait_risk_reports;
  v_res := v_res || format(E'\n[情報] 月次ビューの行数（突き合わせた件数）: %s', v_n);
  v_res := v_res || CASE WHEN (SELECT reloptions::text FROM pg_class WHERE oid = 'public.monthly_wait_risk_reports'::regclass) LIKE '%security_invoker=true%'
    THEN E'\n[OK] 月次ビューは security_invoker のまま' ELSE E'\n[NG] 月次ビューの security_invoker が外れている' END;

  -- 月次ビューの末尾の列 unverified_visits（位置未確認の訪問数）。既存の施設は全て確認済みなので 0
  v_res := v_res || CASE
    WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='monthly_wait_risk_reports' AND column_name='unverified_visits')
         AND (SELECT count(*) FROM public.monthly_wait_risk_reports WHERE unverified_visits <> 0) = 0
    THEN E'\n[OK] 月次ビューに unverified_visits があり、確認済みの施設だけの集計では 0'
    ELSE E'\n[NG] 月次ビューの unverified_visits が無い、または確認済みの施設で 0 でない' END;

  -- ---------------------------------------------------------------------------
  -- 4. submit_daily_report
  -- ---------------------------------------------------------------------------
  -- 引数に金額・GPS記録の待機分数・組織・車格・提出時刻が無いこと
  SELECT pg_get_function_arguments('public.submit_daily_report(date,text,text,jsonb,boolean,boolean,integer)'::regprocedure) INTO v_args;
  v_res := v_res || CASE WHEN v_args !~* '(cost|total|organization|vehicle|submitted_at|user_id)'
    THEN E'\n[OK] submit_daily_report の引数に、金額・待機分数・組織・車格・提出時刻・user_id が無い'
    ELSE E'\n[NG] submit_daily_report の引数にサーバーが決めるべき値がある: ' || v_args END;

  -- 今日の記録も提出の記録もない本人を選ぶ（無ければ省略）
  SELECT p.user_id INTO v_rpc_uid FROM public.profiles p
  WHERE NOT EXISTS (SELECT 1 FROM public.submitted_reports s WHERE s.user_id = p.user_id AND s.report_date = v_today)
    AND NOT EXISTS (SELECT 1 FROM public.wait_logs w WHERE w.user_id = p.user_id
                    AND w.arrival_time >= (v_today::timestamp AT TIME ZONE 'Asia/Tokyo'))
  ORDER BY (p.user_id = v_uid) DESC
  LIMIT 1;

  -- 未ログイン（anon）
  SET LOCAL ROLE anon;
  BEGIN
    PERFORM public.submit_daily_report(v_today, 'x');
    v_res := v_res || E'\n[NG] 未ログイン(anon)で submit_daily_report を実行できた';
  EXCEPTION WHEN insufficient_privilege THEN v_res := v_res || E'\n[OK] 未ログイン(anon)の提出は拒否';
  WHEN OTHERS THEN v_res := v_res || E'\n[??] anon の提出: ' || SQLERRM;
  END;
  RESET ROLE;

  -- ログイン済みだが auth.uid() が無い
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.submit_daily_report(v_today, 'x');
    v_res := v_res || E'\n[NG] auth.uid() が無いのに提出できた';
  EXCEPTION WHEN insufficient_privilege THEN v_res := v_res || E'\n[OK] auth.uid() が無い提出は拒否（ログインが必要）';
  WHEN OTHERS THEN v_res := v_res || E'\n[??] uid無しの提出: ' || SQLERRM;
  END;
  RESET ROLE;

  IF v_rpc_uid IS NULL THEN
    v_res := v_res || E'\n[--] 今日の記録・提出が無いユーザーがいないため、提出 RPC の実行テストは省略';
  ELSE
    UPDATE public.profiles SET vehicle_class = '4t' WHERE user_id = v_rpc_uid;

    -- 打刻が0件の日は提出できない（音声の申告だけでは提出不可）
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rpc_uid, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM public.submit_daily_report(v_today, '文面だけ', NULL, '[{"eventType":"voice_report","waitMinutes":120}]'::jsonb);
      v_res := v_res || E'\n[NG] 打刻が0件の日報を提出できた';
    EXCEPTION WHEN check_violation THEN
      v_res := v_res || CASE WHEN SQLERRM LIKE '%打刻の記録がないため%'
        THEN E'\n[OK] 打刻0件の日報は拒否（日本語メッセージ）: ' || SQLERRM
        ELSE E'\n[NG] 打刻0件の拒否メッセージが想定と違う: ' || SQLERRM END;
    WHEN OTHERS THEN v_res := v_res || E'\n[??] 打刻0件の提出: ' || SQLERRM;
    END;
    RESET ROLE;

    -- 取消済みの打刻だけの日も0件扱い
    v_ticket := v_ticket + 1;
    INSERT INTO public.wait_logs (facility_id, user_id, ticket_number, status, latitude, longitude)
    VALUES (v_fac.id, v_rpc_uid, v_ticket, 'waiting', v_fac.lat, v_fac.lng) RETURNING id INTO v_id;
    UPDATE public.wait_logs SET status = 'cancelled',
      arrival_time = (v_today::timestamp AT TIME ZONE 'Asia/Tokyo') + interval '5 hours',
      called_time  = (v_today::timestamp AT TIME ZONE 'Asia/Tokyo') + interval '7 hours'
    WHERE id = v_id;
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM public.submit_daily_report(v_today, '文面だけ');
      v_res := v_res || E'\n[NG] 取消済みの打刻だけの日報を提出できた';
    EXCEPTION WHEN check_violation THEN v_res := v_res || E'\n[OK] 取消済みの打刻だけの日（算定対象0件）は拒否';
    WHEN OTHERS THEN v_res := v_res || E'\n[??] 取消済みだけの提出: ' || SQLERRM;
    END;
    RESET ROLE;

    -- 4t・今日 00:01 到着 → 荷役開始 01:13（72分）、同日 12:00 到着 → 12:20（20分）、
    -- 等級C: 承認は今日 14:00（arrival_time）、申告は昨日 10:00→10:40（40分・500円）
    v_ticket := v_ticket + 1;
    INSERT INTO public.wait_logs (facility_id, user_id, ticket_number, status, latitude, longitude)
    VALUES (v_fac.id, v_rpc_uid, v_ticket, 'waiting', v_fac.lat, v_fac.lng) RETURNING id INTO v_id;
    UPDATE public.wait_logs SET status = 'completed',
      arrival_time    = (v_today::timestamp AT TIME ZONE 'Asia/Tokyo') + interval '1 minute',
      work_start_time = (v_today::timestamp AT TIME ZONE 'Asia/Tokyo') + interval '73 minutes',
      work_end_time   = (v_today::timestamp AT TIME ZONE 'Asia/Tokyo') + interval '3 hours'
    WHERE id = v_id;
    v_ticket := v_ticket + 1;
    INSERT INTO public.wait_logs (facility_id, user_id, ticket_number, status, latitude, longitude)
    VALUES (v_fac.id, v_rpc_uid, v_ticket, 'waiting', v_fac.lat, v_fac.lng) RETURNING id INTO v_id;
    UPDATE public.wait_logs SET status = 'completed',
      arrival_time    = (v_today::timestamp AT TIME ZONE 'Asia/Tokyo') + interval '12 hours',
      work_start_time = (v_today::timestamp AT TIME ZONE 'Asia/Tokyo') + interval '12 hours 20 minutes',
      work_end_time   = (v_today::timestamp AT TIME ZONE 'Asia/Tokyo') + interval '13 hours'
    WHERE id = v_id;
    v_ticket := v_ticket + 1;
    INSERT INTO public.wait_logs (facility_id, user_id, ticket_number, status, latitude, longitude)
    VALUES (v_fac.id, v_rpc_uid, v_ticket, 'waiting', v_fac.lat, v_fac.lng) RETURNING id INTO v_id;
    UPDATE public.wait_logs SET status = 'completed', evidence_grade = 'C',
      arrival_time       = (v_today::timestamp AT TIME ZONE 'Asia/Tokyo') + interval '14 hours',
      work_start_time    = (v_today::timestamp AT TIME ZONE 'Asia/Tokyo') + interval '14 hours 5 minutes',
      work_end_time      = (v_today::timestamp AT TIME ZONE 'Asia/Tokyo') + interval '14 hours 30 minutes',
      claimed_at         = (v_today::timestamp AT TIME ZONE 'Asia/Tokyo') - interval '14 hours',
      claimed_loading_at = (v_today::timestamp AT TIME ZONE 'Asia/Tokyo') - interval '13 hours 20 minutes'
    WHERE id = v_id;

    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rpc_uid, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;

    -- 日付が今日でない提出は拒否
    BEGIN
      PERFORM public.submit_daily_report(v_today - 1, 'x');
      v_res := v_res || E'\n[NG] 昨日の日付で提出できた';
    EXCEPTION WHEN check_violation THEN v_res := v_res || CASE WHEN SQLERRM LIKE '%端末の日時設定がずれている場合%' THEN E'\n[OK] 今日(日本時間)以外の日付の提出は拒否（端末の日時のずれにも触れたメッセージ）' ELSE E'\n[NG] 日付違いの拒否メッセージが想定と違う: ' || SQLERRM END;
    WHEN OTHERS THEN v_res := v_res || E'\n[??] 日付違いの提出: ' || SQLERRM;
    END;

    -- 直接 INSERT / UPDATE / DELETE は権限が無い
    BEGIN
      INSERT INTO public.submitted_reports (user_id, report_date, total_wait_minutes, estimated_wait_cost)
      VALUES (v_rpc_uid, v_today, 999, 99999);
      v_res := v_res || E'\n[NG] submitted_reports への直接INSERTが通った';
    EXCEPTION WHEN insufficient_privilege THEN v_res := v_res || E'\n[OK] submitted_reports への直接INSERTは拒否';
    WHEN OTHERS THEN v_res := v_res || E'\n[??] submitted_reports INSERT: ' || SQLERRM;
    END;

    -- 正常: 手修正の待機分数 45 を添えて提出（サーバーの計算は 72+20+40(等級C)=132分・2600円）
    BEGIN
      v_rid := public.submit_daily_report(
        v_today, '報告書の文面', '元の文面',
        '[{"eventType":"waiting_start","waitMinutes":999,"estimatedCost":99999}]'::jsonb,
        false, false, 45);
      v_res := v_res || E'\n[OK] submit_daily_report が通った';
    EXCEPTION WHEN OTHERS THEN
      v_res := v_res || E'\n[NG] submit_daily_report: ' || SQLERRM;
      v_rid := NULL;
    END;
    RESET ROLE;

    IF v_rid IS NOT NULL THEN
      SELECT * INTO v_rep FROM public.submitted_reports WHERE id = v_rid;
      v_res := v_res || CASE WHEN v_rep.total_wait_minutes = 132 AND v_rep.estimated_wait_cost = 2600
        THEN E'\n[OK] 保存された値はサーバーの計算（72+20+40=132分 / 2600円。等級Cは承認した今日の日報に入り、分数は申告時刻から）。表示用スナップショットの 999分/99999円 は採用されない'
        ELSE format(E'\n[NG] 保存された値が想定と違う: %s分 / %s円', v_rep.total_wait_minutes, v_rep.estimated_wait_cost) END;
      v_res := v_res || CASE WHEN v_rep.reported_wait_minutes = 45 AND v_rep.is_edited
        THEN E'\n[OK] 手修正した待機分数(45)は別の列に残り、is_edited が立つ（GPS記録の132分とは別）'
        ELSE E'\n[NG] 手修正の記録が想定と違う' END;
      v_res := v_res || CASE WHEN v_rep.user_id = v_rpc_uid AND v_rep.report_date = v_today
          AND v_rep.organization_id IS NOT DISTINCT FROM (SELECT organization_id FROM public.profiles WHERE user_id = v_rpc_uid)
          AND v_rep.vehicle_class = '4t'
        THEN E'\n[OK] user_id・日付・組織・車格はサーバーが決めた'
        ELSE E'\n[NG] user_id/日付/組織/車格が想定と違う' END;
      v_res := v_res || CASE WHEN (v_rep.server_calculation->>'yen_per_minute')::int = 50
          AND jsonb_array_length(v_rep.server_calculation->'visits') = 3
          AND (v_rep.server_calculation->>'estimated_wait_cost')::int = 2600
        THEN E'\n[OK] server_calculation に適用した料率(50)と待機1回ごとの内訳(3件)が残る'
        ELSE E'\n[NG] server_calculation が想定と違う' END;

      -- 二重提出
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rpc_uid, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      BEGIN
        PERFORM public.submit_daily_report(v_today, 'もう一度');
        v_res := v_res || E'\n[NG] 同じ日の二重提出が通った';
      EXCEPTION WHEN unique_violation THEN v_res := v_res || E'\n[OK] 同じ日の二重提出は拒否（23505・日本語メッセージ）: ' || SQLERRM;
      WHEN OTHERS THEN v_res := v_res || E'\n[??] 二重提出: ' || SQLERRM;
      END;
      RESET ROLE;
    END IF;
  END IF;

  -- ---------------------------------------------------------------------------
  -- 5. 権限
  -- ---------------------------------------------------------------------------
  v_res := v_res || CASE WHEN has_table_privilege('authenticated', 'public.submitted_reports', 'SELECT')
      AND NOT has_table_privilege('authenticated', 'public.submitted_reports', 'INSERT')
      AND NOT has_table_privilege('authenticated', 'public.submitted_reports', 'UPDATE')
      AND NOT has_table_privilege('authenticated', 'public.submitted_reports', 'DELETE')
      AND NOT has_table_privilege('anon', 'public.submitted_reports', 'SELECT')
      AND NOT has_table_privilege('anon', 'public.submitted_reports', 'INSERT')
    THEN E'\n[OK] submitted_reports: authenticated は SELECT のみ、anon は何も無し'
    ELSE E'\n[NG] submitted_reports のテーブル権限が想定と違う' END;
  v_res := v_res || CASE WHEN has_table_privilege('authenticated', 'public.wait_rates', 'SELECT')
      AND NOT has_table_privilege('authenticated', 'public.wait_rates', 'INSERT')
      AND NOT has_table_privilege('authenticated', 'public.wait_rates', 'UPDATE')
      AND NOT has_table_privilege('authenticated', 'public.wait_rates', 'DELETE')
      AND NOT has_table_privilege('anon', 'public.wait_rates', 'INSERT')
      AND NOT has_table_privilege('anon', 'public.wait_rates', 'UPDATE')
      AND NOT has_table_privilege('anon', 'public.wait_rates', 'DELETE')
    THEN E'\n[OK] wait_rates: クライアントロールは読み取りのみ'
    ELSE E'\n[NG] wait_rates のテーブル権限が想定と違う' END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE public.wait_rates SET yen_per_minute = 1;
    v_res := v_res || E'\n[NG] wait_rates を UPDATE できた';
  EXCEPTION WHEN insufficient_privilege THEN v_res := v_res || E'\n[OK] wait_rates の UPDATE は拒否';
  WHEN OTHERS THEN v_res := v_res || E'\n[??] wait_rates UPDATE: ' || SQLERRM;
  END;
  RESET ROLE;
  v_res := v_res || CASE WHEN NOT has_function_privilege('anon', 'public.submit_daily_report(date,text,text,jsonb,boolean,boolean,integer)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.submit_daily_report(date,text,text,jsonb,boolean,boolean,integer)', 'EXECUTE')
    THEN E'\n[OK] submit_daily_report: authenticated のみ実行可（anon 不可）'
    ELSE E'\n[NG] submit_daily_report の実行権限が想定と違う' END;
  v_res := v_res || CASE WHEN NOT has_function_privilege('authenticated', 'public.calc_daily_wait_totals(uuid,date)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.calc_daily_wait_totals(uuid,date)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.wait_yen_per_minute(text)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.wait_yen_per_minute(text)', 'EXECUTE')
    THEN E'\n[OK] 内部関数（calc_daily_wait_totals / wait_yen_per_minute）はクライアントから実行不可'
    ELSE E'\n[NG] 内部関数がクライアントから実行できる' END;

  -- 既定行（is_default）は消せない・外せない。通常行の削除、料率の変更は妨げない。
  RESET ROLE;
  BEGIN
    DELETE FROM public.wait_rates WHERE is_default;
    v_res := v_res || E'\n[NG] 既定の料率行を DELETE できた';
  EXCEPTION WHEN check_violation THEN v_res := v_res || E'\n[OK] 既定の料率行の DELETE は拒否';
  WHEN OTHERS THEN v_res := v_res || E'\n[??] wait_rates DELETE: ' || SQLERRM;
  END;
  BEGIN
    UPDATE public.wait_rates SET is_default = false WHERE is_default;
    v_res := v_res || E'\n[NG] 既定の料率行の is_default を解除できた';
  EXCEPTION WHEN check_violation THEN v_res := v_res || E'\n[OK] 既定の料率行の is_default 解除は拒否';
  WHEN OTHERS THEN v_res := v_res || E'\n[??] wait_rates UPDATE: ' || SQLERRM;
  END;
  BEGIN
    TRUNCATE public.wait_rates;
    v_res := v_res || E'\n[NG] wait_rates を TRUNCATE できた';
  EXCEPTION WHEN check_violation THEN v_res := v_res || E'\n[OK] wait_rates の TRUNCATE は拒否';
  WHEN OTHERS THEN v_res := v_res || E'\n[??] wait_rates TRUNCATE: ' || SQLERRM;
  END;
  BEGIN
    UPDATE public.wait_rates SET yen_per_minute = yen_per_minute + 1 WHERE is_default;
    DELETE FROM public.wait_rates WHERE vehicle_class = '2t';
    v_res := v_res || E'\n[OK] 料率の変更と、既定でない行の削除は妨げない（マイグレーションで変更できる）';
  EXCEPTION WHEN OTHERS THEN v_res := v_res || E'\n[NG] 通常の料率変更が拒否された: ' || SQLERRM;
  END;

  -- 省略（[--]）の件数。1件でもあれば、本番では何も検証されていない項目がある
  v_n := (length(v_res) - length(replace(v_res, '[--]', ''))) / 4;
  IF v_n > 0 THEN
    v_res := E'\n⚠⚠⚠ 省略 ' || v_n || E' 件: 本番では何も検証されていません ⚠⚠⚠' || v_res;
  END IF;

  RAISE EXCEPTION 'ROLLBACK_TEST_RESULT:%', v_res;
END $$;
