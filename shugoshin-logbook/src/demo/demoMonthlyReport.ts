/**
 * /demo/warning 用の架空の1か月分の訪問記録と、荷主 × 拠点の月次集計。
 *
 * 実在の施設・人物・取引とは無関係。本番DBには一切アクセスしない。
 * 集計の規則は DB の monthly_wait_risk_reports ビュー
 * （supabase/migrations/20260803110000_fix_monthly_wait_risk_view.sql）をそのまま写している:
 *   - 待機料は待機1回ごとに30分を控除（calcWaitCost）
 *   - 荷待ち時間を算定できない訪問（wait が null）は件数に数えるが、合計と平均には入れない
 *   - リスク判定は算定できた訪問の平均待機分: 60分以上=高／30分以上=中／それ未満=低
 */
import { calcWaitCost } from "@/lib/waitCostCalc";
import { DEMO_VEHICLE_CLASS } from "@/demo/demoData";
import type { RiskReportRow } from "@/components/report/RiskReportDocument";

export const DEMO_REPORT_MONTH = "2026-09-01";
export const DEMO_REPORT_MONTH_LABEL = "2026年9月";
export const DEMO_REPORT_ISSUE_DATE = "2026年10月3日";
export const DEMO_REPORT_ORG_NAME = "架空運送株式会社";

export interface DemoMonthlyVisit {
  client: string;
  location: string;
  /** 荷待ち時間（分）。荷役開始が記録されず算定できなかった訪問は null */
  waitMinutes: number | null;
  /** C＝通信圏外の申告を運行管理者が承認した訪問 */
  grade: "A" | "C";
}

const visits = (
  client: string,
  location: string,
  waits: (number | null)[],
  gradeC: number[] = [],
): DemoMonthlyVisit[] =>
  waits.map((waitMinutes, i) => ({
    client,
    location,
    waitMinutes,
    grade: gradeC.includes(i) ? "C" : "A",
  }));

export const DEMO_MONTHLY_VISITS: DemoMonthlyVisit[] = [
  // 長い待機が続く荷主 → 高
  ...visits("架空水産", "第2荷捌き場", [72, 25, 95, 48, 66, 110, 35]),
  // 平均がちょうど中くらい。算定できなかった訪問が1件混ざる → 中
  ...visits("架空冷蔵", "本社倉庫", [25, 40, 18, 52, null, 33]),
  // 短い待機が中心。圏外で申告し承認された訪問が1件（55分）→ 低
  ...visits("架空物産", "配送センター", [15, 22, 12, 28, 55], [4]),
];

export function riskLevelFor(avgWaitMinutes: number): "高" | "中" | "低" {
  if (avgWaitMinutes >= 60) return "高";
  if (avgWaitMinutes >= 30) return "中";
  return "低";
}

export function buildMonthlyRiskRows(
  all: DemoMonthlyVisit[] = DEMO_MONTHLY_VISITS,
  vehicleClass: string = DEMO_VEHICLE_CLASS,
  month: string = DEMO_REPORT_MONTH,
): RiskReportRow[] {
  const groups = new Map<string, DemoMonthlyVisit[]>();
  for (const v of all) {
    const key = `${v.client}\u0000${v.location}`;
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }
  return [...groups.values()].map((g) => {
    const measured = g.map((v) => v.waitMinutes).filter((m): m is number => m !== null);
    const sum = measured.reduce((s, m) => s + m, 0);
    const avg = measured.length > 0 ? sum / measured.length : 0;
    return {
      client_organization_name: g[0].client,
      location_name: g[0].location,
      report_month: month,
      total_visits: g.length,
      unmeasured_visits: g.length - measured.length,
      approved_claim_visits: g.filter((v) => v.grade === "C").length,
      total_wait_minutes: Math.round(sum),
      estimated_loss_jpy: measured.reduce((s, m) => s + calcWaitCost(m, vehicleClass), 0),
      gmen_risk_level: riskLevelFor(avg),
    };
  });
}
