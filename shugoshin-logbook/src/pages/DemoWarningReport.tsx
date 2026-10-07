import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RiskReportDocument } from "@/components/report/RiskReportDocument";
import {
  DEMO_REPORT_ISSUE_DATE,
  DEMO_REPORT_MONTH_LABEL,
  DEMO_REPORT_ORG_NAME,
  buildMonthlyRiskRows,
} from "@/demo/demoMonthlyReport";

/**
 * /demo の「警告レポート」。
 * 実際の画面（/report）と同じ紙面（RiskReportDocument）を、架空の1か月分の記録から作って見せる。
 * 本番 DB には一切アクセスしない。
 */
export default function DemoWarningReport() {
  const rows = useMemo(() => buildMonthlyRiskRows(), []);

  return (
    <div
      className="min-h-screen bg-background print:bg-white print:text-black"
      style={{ WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" } as React.CSSProperties}
    >
      <div className="border-b bg-muted px-4 py-2 text-center text-xs text-muted-foreground print:hidden">
        表示しているのは架空のデータです。実在の施設・人物・取引とは関係ありません。
      </div>

      <div className="mx-auto max-w-4xl px-4 pt-4 print:hidden">
        <Button asChild variant="ghost" size="sm" className="gap-2 text-muted-foreground">
          <Link to="/demo">
            <ArrowLeft className="h-4 w-4" />
            デモに戻る
          </Link>
        </Button>
        <p className="mt-3 text-sm text-muted-foreground">
          荷主ごとの待機の状況を、1か月分まとめたレポートです。算定できなかった訪問と、電波圏外で申告して承認された訪問は、
          「0円」が「待機がなかった」と読まれないよう、件数と注記で示します。
        </p>
      </div>

      <RiskReportDocument
        rows={rows}
        orgName={DEMO_REPORT_ORG_NAME}
        issueDate={DEMO_REPORT_ISSUE_DATE}
        monthLabel={DEMO_REPORT_MONTH_LABEL}
        controls={
          <div className="mb-6 flex flex-col items-center gap-3 print:hidden">
            <p className="text-sm font-semibold text-foreground">対象月: {DEMO_REPORT_MONTH_LABEL}</p>
            <Button size="lg" className="h-12 gap-2 px-6 text-base" onClick={() => window.print()}>
              <Printer className="h-5 w-5" />
              レポートを印刷 / PDF保存
            </Button>
          </div>
        }
      />
    </div>
  );
}
