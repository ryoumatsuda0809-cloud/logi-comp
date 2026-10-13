import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RiskReportDocument } from "@/components/report/RiskReportDocument";
import {
  buildDemoRiskRows,
  DEMO_RISK_CARRIER,
  DEMO_RISK_ISSUE_DATE,
  DEMO_RISK_MONTH_LABEL,
} from "@/demo/demoRiskReport";

/**
 * /demo の「警告レポート」。
 * 運送会社の管理者が、荷主別・拠点別に待機の実態と取適法上のリスクを見るレポートを、
 * 架空の1か月分で見せる。実際の画面（/report）と同じ紙面（RiskReportDocument）を使い、
 * 本番 DB には一切アクセスしない。
 */
export default function DemoRisk() {
  const rows = useMemo(() => buildDemoRiskRows(), []);

  return (
    <div
      className="min-h-screen bg-background print:bg-white print:text-black"
      style={{ WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" } as React.CSSProperties}
    >
      <div className="border-b bg-muted px-4 py-2 text-center text-xs text-muted-foreground print:hidden">
        表示しているのは架空のデータです。実在の施設・人物・取引とは関係ありません。
      </div>

      <main className="mx-auto max-w-4xl p-4 pb-16 print:max-w-none print:p-0">
        <Button asChild variant="ghost" size="sm" className="mb-2 gap-2 text-muted-foreground print:hidden">
          <Link to="/demo">
            <ArrowLeft className="h-4 w-4" />
            デモに戻る
          </Link>
        </Button>

        <RiskReportDocument
          rows={rows}
          orgName={DEMO_RISK_CARRIER}
          issueDate={DEMO_RISK_ISSUE_DATE}
          selectedMonthLabel={DEMO_RISK_MONTH_LABEL}
          controls={
            <div className="mb-6 flex flex-col items-center gap-3 print:hidden">
              <p className="text-center text-sm text-muted-foreground">
                運送会社の管理者が、荷主ごと・拠点ごとの待機の実態を月ごとに確認するレポートです（{DEMO_RISK_MONTH_LABEL}）。
              </p>
              <button
                onClick={() => window.print()}
                className="flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-base font-bold text-primary-foreground shadow-md hover:opacity-90 active:scale-[0.98]"
              >
                <Printer className="h-5 w-5" />
                レポートを印刷 / PDF保存
              </button>
            </div>
          }
        />
      </main>
    </div>
  );
}
