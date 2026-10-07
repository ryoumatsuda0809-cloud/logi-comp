-- =============================================================================
-- 日報（submitted_reports）の数値と明細を、提出時にサーバーが作り直す  【下書き・未適用】
--
-- 背景（README「既知の課題」の最初の項目 / STATUS.md §2d の 🔴）:
--   DailyReportConfirm.tsx が submitted_reports へ直接 INSERT し、合計待機時間・待機料・
--   車格・明細（timeline_snapshot）・差異フラグを端末から送っていた。提出後は書き換え
--   られない（20260414000005 のトリガー）が、偽の内容もそのまま固定され、荷主の共有帳票
--   （get_shared_report → ReportDocument）には、source が 'gps' の行が
--   「等級A：サーバー検証済」と出る。
--
-- 方針: BEFORE INSERT トリガーで、端末が送った数値と明細を捨て、サーバーが持つ
--   wait_logs から作り直した値で上書きする。フロントの変更は要らない（端末はこれまで通り
--   値を送るが、無視される）。UPDATE・DELETE は 20260414000005 が今も全ロールで止める。
--
-- 【数え方の定義】 ※ここは本人が決める事項。下書きは次の定義にしている:
--   - 数えるもの: その日（日本時間）に到着した、取り消されていない wait_logs の訪問だけ。
--   - 荷待ち時間: 到着 → 荷役開始。waitLogToTimeline.ts の effectiveArrival / loadingStartedAt と
--     同じ優先順位。到着 = COALESCE(claimed_at, arrival_time)、
--     終端 = COALESCE(claimed_loading_at, work_start_time, called_time)。終端が無ければ算定不能で 0 分。
--     訪問ごとに分へ四捨五入し、0 未満は 0（diffMinutes と同じ）。
--     ※ wait_logs.waiting_minutes（GENERATED 列）は「到着〜作業完了」の滞在時間で、荷待ち時間ではない。使わない。
--   - 待機料: 訪問ごとに GREATEST(分 - 30, 0) × 単価。合計に 1 回だけ控除しない（sumWaitCost と同じ）。
--     単価は profiles.vehicle_class（サーバーの値）から 2t=40 / 4t=50 / 10t=60 / それ以外=50。
--     src/lib/waitCostCalc.ts の RATE_MAP と 20260803110000 の VIEW と同じ値。変えるときは3箇所同時に。
--   - 数えないもの（今の画面は足している）: 旧 compliance_logs と音声日報（daily_reports）の待機分。
--     compliance_logs は authenticated が INSERT できるポリシーが残っており（20260211 のベース）、
--     音声日報は本人申告なので、「サーバー検証済」の数値には入れられない。
--     音声日報の行だけは明細に残す（待機分は declaredWaitMinutes として保持。合計には入れない）。
--     旧 compliance_logs 由来の行と、端末が付けた wait_log 由来の行は明細から外れる。
--   - 変えないもの: formal_report / original_ai_output / is_edited / organization_id / report_date は
--     端末が送った値のまま（報告書の文面は本人が直せる設計。E13）。
--
-- 【失敗したときの影響】 このトリガーが例外を出すと、日報の提出が全部止まる（フェイルクローズ。
--   偽の値を黙って通すよりよい、という判断）。戻し方（データは消えない。提出済みの行はそのまま）:
--     ALTER TABLE public.submitted_reports DISABLE TRIGGER trg_recompute_submitted_report_numbers;
--   完全に戻すなら:
--     DROP TRIGGER IF EXISTS trg_recompute_submitted_report_numbers ON public.submitted_reports;
--     DROP FUNCTION IF EXISTS public.recompute_submitted_report_numbers();
--
-- 【既存データ】 INSERT 時だけ動く。既存の提出済みの日報と、発行済みの共有リンクは変わらない。
--   get_shared_report は変更しない（保存された値を返すだけ）。
-- =============================================================================

CREATE OR REPLACE FUNCTION public.recompute_submitted_report_numbers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_vc      text;
  v_rate    integer;
  v_start   timestamptz;
  v_end     timestamptz;
  v_total   integer;
  v_cost    integer;
  v_entries jsonb;
  v_voice   jsonb := '[]'::jsonb;
  v_disc    boolean := false;
  v_el      jsonb;
  v_ts      timestamptz;
  v_decl    numeric;
  n         integer := 0;
BEGIN
  -- 車格はサーバーの値。プロフィールが無い・空なら画面と同じ既定値 4t。
  SELECT NULLIF(p.vehicle_class, '') INTO v_vc FROM public.profiles p WHERE p.user_id = NEW.user_id;
  v_vc := COALESCE(v_vc, '4t');
  v_rate := CASE v_vc WHEN '2t' THEN 40 WHEN '4t' THEN 50 WHEN '10t' THEN 60 ELSE 50 END;

  -- 日本の暦日（jstDayRange と同じ。上限は翌日 0 時の手前）
  v_start := NEW.report_date::timestamp AT TIME ZONE 'Asia/Tokyo';
  v_end   := (NEW.report_date + 1)::timestamp AT TIME ZONE 'Asia/Tokyo';

  -- 訪問ごとの荷待ち時間（分）と、サーバーが作る明細
  WITH w AS (
    SELECT wl.ticket_number,
           COALESCE(f.name, '不明な施設')                                 AS facility_name,
           wl.evidence_grade,
           wl.self_approved,
           COALESCE(wl.claimed_at, wl.arrival_time)                       AS arr_at,
           COALESCE(wl.claimed_loading_at, wl.work_start_time, wl.called_time) AS load_at,
           COALESCE(wl.claimed_end_at, wl.work_end_time)                  AS end_at
    FROM public.wait_logs wl
    LEFT JOIN public.facilities f ON f.id = wl.facility_id
    WHERE wl.user_id = NEW.user_id
      AND wl.arrival_time >= v_start
      AND wl.arrival_time <  v_end
      AND wl.status IS DISTINCT FROM 'cancelled'
  ), m AS (
    SELECT w.*,
           CASE WHEN w.load_at IS NOT NULL
                THEN GREATEST(round((EXTRACT(EPOCH FROM (w.load_at - w.arr_at))::numeric) / 60), 0)::integer
           END AS wait_min
    FROM w
  ), tot AS (
    SELECT COALESCE(sum(m.wait_min), 0)::integer                                   AS total_min,
           COALESCE(sum(GREATEST(COALESCE(m.wait_min, 0) - 30, 0) * v_rate), 0)::integer AS total_cost
    FROM m
  ), ev AS (
    SELECT m.arr_at AS ts, 1 AS ord,
           jsonb_build_object('source', 'gps', 'timestamp', to_char(m.arr_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                              'eventType', 'arrival', 'locationName', m.facility_name, 'ticketNumber', m.ticket_number)
           || CASE WHEN m.evidence_grade = 'C'
                   THEN jsonb_build_object('evidenceGrade', 'C', 'selfApproved', COALESCE(m.self_approved, false))
                   ELSE '{}'::jsonb END AS e
    FROM m
    UNION ALL
    SELECT m.load_at, 2,
           jsonb_build_object('source', 'gps', 'timestamp', to_char(m.load_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                              'eventType', 'waiting_start', 'locationName', m.facility_name, 'ticketNumber', m.ticket_number,
                              'waitMinutes', m.wait_min)
           || CASE WHEN m.evidence_grade = 'C'
                   THEN jsonb_build_object('evidenceGrade', 'C', 'selfApproved', COALESCE(m.self_approved, false))
                   ELSE '{}'::jsonb END
    FROM m WHERE m.load_at IS NOT NULL
    UNION ALL
    SELECT m.end_at, 3,
           jsonb_build_object('source', 'gps', 'timestamp', to_char(m.end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                              'eventType', 'departure', 'locationName', m.facility_name, 'ticketNumber', m.ticket_number)
           || CASE WHEN m.evidence_grade = 'C'
                   THEN jsonb_build_object('evidenceGrade', 'C', 'selfApproved', COALESCE(m.self_approved, false))
                   ELSE '{}'::jsonb END
    FROM m WHERE m.end_at IS NOT NULL
  )
  SELECT (SELECT total_min FROM tot),
         (SELECT total_cost FROM tot),
         COALESCE((SELECT jsonb_agg(ev.e ORDER BY ev.ts, ev.ord) FROM ev), '[]'::jsonb)
  INTO v_total, v_cost, v_entries;

  -- 音声日報（本人申告）の行だけ、端末が送ったものを残す。使う項目は決まったものだけに絞り、
  -- source は 'voice' に固定する（'gps' を名乗って「サーバー検証済」と出させない）。最大20行。
  IF jsonb_typeof(NEW.timeline_snapshot) = 'array' THEN
    FOR v_el IN SELECT e FROM jsonb_array_elements(NEW.timeline_snapshot) AS e LOOP
      EXIT WHEN n >= 20;
      CONTINUE WHEN v_el->>'source' IS DISTINCT FROM 'voice' OR v_el->>'eventType' IS DISTINCT FROM 'voice_report';
      BEGIN
        v_ts := (v_el->>'timestamp')::timestamptz;
      EXCEPTION WHEN others THEN
        CONTINUE;  -- 時刻が読めない行は捨てる
      END;
      v_decl := NULL;
      BEGIN
        v_decl := (v_el->>'waitMinutes')::numeric;
      EXCEPTION WHEN others THEN
        v_decl := NULL;
      END;
      n := n + 1;
      v_voice := v_voice || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'source', 'voice',
        'timestamp', to_char(v_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'eventType', 'voice_report',
        'label', '音声日報',
        'shipperName', left(v_el->>'shipperName', 100),
        'summary', left(v_el->>'summary', 500),
        'declaredWaitMinutes', CASE WHEN v_decl BETWEEN 0 AND 1440 THEN round(v_decl)::integer END
      )));
      -- GPS 記録（サーバーの打刻）から 15 分より離れた音声申告があれば差異あり（useDailyTimeline と同じ）
      IF jsonb_array_length(v_entries) > 0 AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_entries) g
        WHERE abs(EXTRACT(EPOCH FROM ((g->>'timestamp')::timestamptz - v_ts))) <= 15 * 60
      ) THEN
        v_disc := true;
      END IF;
    END LOOP;
  END IF;

  NEW.vehicle_class       := v_vc;
  NEW.total_wait_minutes  := v_total;
  NEW.estimated_wait_cost := v_cost;
  NEW.has_discrepancy     := v_disc;
  SELECT COALESCE(jsonb_agg(s.e ORDER BY (s.e->>'timestamp')::timestamptz, s.n), '[]'::jsonb)
  INTO NEW.timeline_snapshot
  FROM jsonb_array_elements(v_entries || v_voice) WITH ORDINALITY AS s(e, n);

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.recompute_submitted_report_numbers() IS
  '提出時に submitted_reports の数値・車格・明細・差異フラグを、wait_logs（サーバーの打刻）から作り直して上書きする。端末が送った値は使わない。音声日報の行だけ残す（合計には入れない）。';

-- トリガー関数は直接呼べない。念のため、誰にも実行権限を与えない（新しい関数は既定で誰も実行できない方針）。
REVOKE ALL ON FUNCTION public.recompute_submitted_report_numbers() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_recompute_submitted_report_numbers ON public.submitted_reports;
CREATE TRIGGER trg_recompute_submitted_report_numbers
  BEFORE INSERT ON public.submitted_reports
  FOR EACH ROW
  EXECUTE FUNCTION public.recompute_submitted_report_numbers();
