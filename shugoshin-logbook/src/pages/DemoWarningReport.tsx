import { useMemo } from "react";
import { Printer } from "lucide-react";
import { FieldButton } from "@/components/ui/field-button";
import { PageHeader } from "@/components/PageHeader";
import { DemoBottomNav } from "@/components/demo/DemoBottomNav";
import { DEMO_SAMPLE_PDF, DemoPdfLink } from "@/components/demo/DemoPdfLink";
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
      className="demo-app min-h-screen bg-background print:bg-white print:text-black"
      style={{ WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" } as React.CSSProperties}
    >
      <PageHeader title="警告レポート" subtitle="デモ" backTo="/demo" className="print:hidden" />

      <div className="border-b bg-muted px-4 py-2 text-center text-xs text-muted-foreground print:hidden">
        架空のデータです。実在の施設・人物・取引とは無関係です。
      </div>

      <RiskReportDocument
        rows={rows}
        orgName={DEMO_REPORT_ORG_NAME}
        issueDate={DEMO_REPORT_ISSUE_DATE}
        monthLabel={DEMO_REPORT_MONTH_LABEL}
        controls={
          <div className="mb-6 flex flex-col items-center gap-3 print:hidden">
            <p className="text-sm font-semibold text-foreground">対象月: {DEMO_REPORT_MONTH_LABEL}</p>
            <FieldButton fullWidth={false} className="gap-3" onClick={() => window.print()}>
              <Printer />
              レポートを印刷 / PDF保存
            </FieldButton>
            <DemoPdfLink href={DEMO_SAMPLE_PDF.warning} fullWidth={false}>
              PDFの見本を開く
            </DemoPdfLink>
            <p className="text-center text-xs text-muted-foreground">
              印刷が動かない端末（ホーム画面から開いたアプリなど）では、PDFの見本を開いてください。
            </p>
          </div>
        }
      />

      <div className="print:hidden">
        <DemoBottomNav />
      </div>
    </div>
  );
}
