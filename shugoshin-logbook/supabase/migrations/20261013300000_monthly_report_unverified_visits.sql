-- =============================================================================
-- 月次の警告レポートに「位置が未確認の施設での訪問数」を足す
--
-- 運送会社の管理者が登録した施設は「未確認」（verification_status='unverified'）で、
-- 位置は運営者に確認されていない。荷主へ渡る文書で、そうした訪問が、確認済みの施設の
-- 訪問と同じ重みに見えないよう、行ごとに件数を出す（画面に注記する）。
--
-- 20261013200000（wait_rates を使う版）のビューに、列を1つ末尾に足しただけ。
-- 既存の列の順序・型・値は変えない（CREATE OR REPLACE VIEW は末尾への列追加のみ可能）。
-- security_invoker は維持する。適用順序: 20261013100000（verification_status 列）→ 20261013200000 → これ。
-- =============================================================================

CREATE OR REPLACE VIEW public.monthly_wait_risk_reports
WITH (security_invoker = true) AS
WITH visit AS (
  SELECT
    f.client_name AS client_organization_name,
    f.name        AS location_name,
    date_trunc('month', w.work_end_time AT TIME ZONE 'Asia/Tokyo')
      AT TIME ZONE 'Asia/Tokyo' AS report_month,
    w.evidence_grade,
    f.verification_status,
    -- 単価（円/分）。wait_rates を引く。該当なし・未設定は既定行。
    COALESCE(r.yen_per_minute, d.yen_per_minute) AS rate_jpy_per_min,
    -- 荷待ち時間（分）。到着から荷役開始まで。
    -- 等級Cでは claimed_* が実際の時刻、arrival_time / work_start_time は承認時刻。
    -- 終端が一つも無い場合は NULL（算定不能）とし、作業完了へはフォールバックしない。
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
  WHERE w.status = 'completed'
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
  COALESCE(sum(GREATEST(wait_minutes - 30, 0) * rate_jpy_per_min), 0)::integer
                                                       AS estimated_loss_jpy,
  CASE
    WHEN COALESCE(avg(wait_minutes), 0) >= 60 THEN '高'
    WHEN COALESCE(avg(wait_minutes), 0) >= 30 THEN '中'
    ELSE '低'
  END                                                  AS gmen_risk_level,
  -- 追加（末尾）: 位置が運営者に確認されていない施設での訪問数
  count(*) FILTER (WHERE verification_status = 'unverified') AS unverified_visits
FROM visit
GROUP BY client_organization_name, location_name, report_month;

COMMENT ON VIEW public.monthly_wait_risk_reports IS
  '荷主別・拠点別・月別の待機の集計（security_invoker）。料率は wait_rates。unverified_visits は、位置が未確認の施設での訪問数。';
