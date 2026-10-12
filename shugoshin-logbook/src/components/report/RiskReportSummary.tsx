import { NoticeMark } from "@/components/NoticeMark";
import type { RiskReportRow } from "./RiskReportDocument";

export interface RiskReportSummaryData {
  shipperCount: number;
  totalVisits: number;
  totalWaitMinutes: number;
  totalLossJpy: number;
  /** 推定逸失利益が最も大きい行。全行が0円なら null（「最も大きい」と言えないので出さない） */
  top: RiskReportRow | null;
  unmeasuredVisits: number;
  approvedClaimVisits: number;
}

/**
 * 警告レポートの行から、要約の数値を作る。表と同じ行を足し合わせるだけで、AI も追加の計算もしない。
 * 金額と分数は言い間違えが許されないので、表の合計と必ず一致させる（テストで確かめる）。
 */
export function summarizeRiskRows(rows: RiskReportRow[]): RiskReportSummaryData {
  let top: RiskReportRow | null = null;
  for (const row of rows) {
    const loss = row.estimated_loss_jpy ?? 0;
    if (loss <= 0) continue;
    const topLoss = top?.estimated_loss_jpy ?? 0;
    const longer = (row.total_wait_minutes ?? 0) > (top?.total_wait_minutes ?? 0);
    if (!top || loss > topLoss || (loss === topLoss && longer)) top = row;
  }
  return {
    shipperCount: new Set(rows.map((r) => r.client_organization_name ?? "")).size,
    totalVisits: rows.reduce((s, r) => s + (r.total_visits ?? 0), 0),
    totalWaitMinutes: rows.reduce((s, r) => s + (r.total_wait_minutes ?? 0), 0),
    totalLossJpy: rows.reduce((s, r) => s + (r.estimated_loss_jpy ?? 0), 0),
    top,
    unmeasuredVisits: rows.reduce((s, r) => s + (r.unmeasured_visits ?? 0), 0),
    approvedClaimVisits: rows.reduce((s, r) => s + (r.approved_claim_visits ?? 0), 0),
  };
}

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

/**
 * 表の上に置く2〜3行の要約。行が無いときは出さない（呼び出し側で rows.length > 0 を確かめる）。
 * 文面は決まった型にデータを流し込むだけ。実際の画面（Report.tsx）と /demo/warning の両方、印刷にも出る。
 */
export function RiskReportSummary({ rows, monthLabel }: { rows: RiskReportRow[]; monthLabel: string }) {
  const s = summarizeRiskRows(rows);
  const caveats = [
    s.unmeasuredVisits > 0 && `算定不可 ${s.unmeasuredVisits} 件（待機が無かったことを意味しません）`,
    s.approvedClaimVisits > 0 && `圏外承認 ${s.approvedClaimVisits} 件（時刻の自動検証なし）`,
  ].filter(Boolean);

  return (
    <section
      aria-label="要約"
      className="mb-4 space-y-1 rounded-xl border border-border bg-card p-4 text-sm leading-relaxed print:mb-4 print:border-black print:bg-white print:text-black"
    >
      <p className="font-semibold">
        {monthLabel}：{s.shipperCount}荷主で待機は計 {s.totalWaitMinutes}分、推定逸失利益は計 {yen(s.totalLossJpy)} です。
      </p>
      {s.top && (
        <p>
          最も大きいのは {s.top.client_organization_name || "不明な荷主"}（{s.top.total_wait_minutes ?? 0}分・
          {yen(s.top.estimated_loss_jpy ?? 0)}
          {s.top.gmen_risk_level ? `・リスク${s.top.gmen_risk_level}` : ""}）です。
        </p>
      )}
      {caveats.length > 0 && (
        <p className="flex items-start gap-1 text-xs text-muted-foreground print:text-gray-700">
          <NoticeMark className="mt-0.5" />
          <span>※ {caveats.join("、")}を含みます。</span>
        </p>
      )}
    </section>
  );
}
