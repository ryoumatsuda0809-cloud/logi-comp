/**
 * /demo/risk 用の架空の1か月分（2026年9月）。実在の荷主・拠点とは無関係。
 *
 * 数値は手書きせず、訪問ごとの待機分数から実際の算定ロジックで求める。
 *   - 逸失額: 待機1回ごとに30分を控除（sumWaitCost）
 *   - リスク判定: 実際のビュー（monthly_wait_risk_reports）と同じ基準。
 *     算定できた訪問の平均待機が 60分以上=高 / 30分以上=中 / それ未満=低
 */
import type { ReportRow } from "@/components/report/RiskReportDocument";
import { sumWaitCost } from "@/lib/waitCostCalc";
import { DEMO_VEHICLE_CLASS } from "./demoData";

export const DEMO_RISK_MONTH = "2026-09-01";
export const DEMO_RISK_MONTH_LABEL = "2026年9月";
export const DEMO_RISK_ISSUE_DATE = "2026年10月1日";
export const DEMO_RISK_CARRIER = "架空運送株式会社";

interface DemoSite {
  shipper: string;
  site: string;
  /** 荷待ち時間を算定できた訪問の待機分数 */
  waits: number[];
  /** 荷役開始が未記録で算定できなかった訪問数 */
  unmeasured?: number;
  /** 通信圏外の申告を管理者が承認した訪問数（waits に含まれる分） */
  approvedClaims?: number;
}

export const DEMO_RISK_SITES: DemoSite[] = [
  { shipper: "架空水産", site: "第2荷捌き場", waits: [72, 65, 48, 100, 35, 55, 80, 28] },
  { shipper: "架空物産", site: "配送センター", waits: [55, 62, 30, 45, 70, 38], approvedClaims: 1 },
  { shipper: "架空冷蔵", site: "本社倉庫", waits: [25, 40, 18, 33, 22], unmeasured: 1 },
  { shipper: "架空商事", site: "港倉庫", waits: [15, 20, 10, 25] },
];

export function riskLevel(avgWaitMinutes: number): "高" | "中" | "低" {
  if (avgWaitMinutes >= 60) return "高";
  if (avgWaitMinutes >= 30) return "中";
  return "低";
}

export function buildDemoRiskRows(): ReportRow[] {
  return DEMO_RISK_SITES.map((s) => {
    const total = s.waits.reduce((a, b) => a + b, 0);
    const avg = s.waits.length > 0 ? total / s.waits.length : 0;
    return {
      client_organization_name: s.shipper,
      location_name: s.site,
      report_month: DEMO_RISK_MONTH,
      total_visits: s.waits.length + (s.unmeasured ?? 0),
      unmeasured_visits: s.unmeasured ?? 0,
      approved_claim_visits: s.approvedClaims ?? 0,
      total_wait_minutes: total,
      estimated_loss_jpy: sumWaitCost(s.waits, DEMO_VEHICLE_CLASS),
      gmen_risk_level: riskLevel(avg),
    };
  });
}
