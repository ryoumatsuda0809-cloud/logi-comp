-- =============================================================================
-- monthly_wait_risk_reports VIEW の算定是正
--
-- 【なぜ急ぐか】
--   この VIEW は Report.tsx の月次帳票の元データで、同画面は帳票を
--   「法的な支払督促の根拠資料として有効」と明記している。
--
--   これまでは待機時間の終端 COALESCE(called_time, work_start_time) が常に NULL
--   だったため（advance_wait_status を呼べる者がおらず両カラムが埋まらなかった）、
--   結果は常に0で誤りが表面化していなかった。
--   20260731110000 で start_loading を追加し work_start_time が埋まるようになったため、
--   **この VIEW は今後実際に金額を出す**。誤った算定のまま法的文書として
--   提示される状態になるので先に是正する。
--
-- 【是正する4点】
--   ① 30分控除がない
--      待機1回ごとに30分を控除する（標準貨物自動車運送約款の待機時間料は
--      集貨地・配達地ごとの待機について算定するため）。旧定義は1分目から課金しており
--      過大。src/lib/waitCostCalc.ts の sumWaitCost() と同じ考え方に揃える。
--   ② 単価がフロントと不一致
--      旧: 10t=70 / trailer=90。src/lib/waitCostCalc.ts は 2t=40 / 4t=50 / 10t=60、
--      それ以外は既定値50。請求に実際に使われるのはフロント側の算定
--      （submitted_reports / SharedReportView）なので、そちらに合わせる。
--      ※ 'trailer' がフロントの単価表に無く50円扱いになる点は業務判断が必要。
--        単価を変えるなら waitCostCalc.ts と本VIEWの両方を必ず同時に直すこと。
--   ③ 待機時間の終端の優先順位が逆
--      旧: COALESCE(called_time, work_start_time)。呼出は荷役開始までの途中に
--      置かれる中間イベントにすぎず、呼出から荷役開始までもドライバーは
--      荷役を待っている。src/lib/waitLogToTimeline.ts の loadingStartedAt() と同じく
--      work_start_time を優先する。
--   ④ 主張時刻を見ていない
--      等級C（圏外申告を管理者が承認したもの）では arrival_time / work_start_time が
--      承認処理を行ったサーバー時刻になる。claimed_* を優先しないと
--      承認が翌日なら負の値になるなど壊れた値が出る。
--
-- 【あわせて追加する列】
--   - unmeasured_visits    : 荷待ち時間を算定できなかった訪問数
--   - approved_claim_visits: 等級Cの訪問数
--   どちらも「0円」が「待機がなかった」と誤読されるのを防ぐために出す。
--   算定不能や未検証の記録が混ざっていることを、帳票を読む側が分かる必要がある。
--
-- 【この migration で直さないこと】
--   security_invoker = true は維持する。wait_logs の SELECT ポリシーが本人限定の
--   ため、この帳票は現状「閲覧者本人の記録」しか集計しない。荷主向け帳票としては
--   不十分だが、その是正は facilities と organizations の紐付け
--   （client_name の文字列一致を FK に直す）とセットで行う必要があり別作業とする。
--   ここで security_definer に変えると、権限モデルを整える前に全社のデータが
--   見えてしまう。
-- =============================================================================

DROP VIEW IF EXISTS public.monthly_wait_risk_reports;

CREATE VIEW public.monthly_wait_risk_reports
WITH (security_invoker = true) AS
WITH visit AS (
  SELECT
    f.client_name AS client_organization_name,
    f.name        AS location_name,
    date_trunc('month', w.work_end_time AT TIME ZONE 'Asia/Tokyo')
      AT TIME ZONE 'Asia/Tokyo' AS report_month,
    w.evidence_grade,
    -- 単価（円/分）。src/lib/waitCostCalc.ts の RATE_MAP と一致させること。
    CASE p.vehicle_class
      WHEN '2t'  THEN 40
      WHEN '4t'  THEN 50
      WHEN '10t' THEN 60
      ELSE 50
    END AS rate_jpy_per_min,
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
  '荷主別・拠点別の月次待機集計。荷待ち時間は到着〜荷役開始で算定し、待機料は待機1回ごとに30分を控除する。単価は src/lib/waitCostCalc.ts と一致させること。等級C（圏外申告の承認記録）と算定不能の件数を別列で示す。';
