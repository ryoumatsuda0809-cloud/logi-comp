import { useMemo } from "react";
import { Printer } from "lucide-react";
import { FieldButton } from "@/components/ui/field-button";
import { PageHeader } from "@/components/PageHeader";
import { DemoBottomNav } from "@/components/demo/DemoBottomNav";
import { ReportDocument, type ReportData, type ReportParties } from "@/components/report/ReportDocument";
import { convertWaitLogsToTimeline, generateFormalReportFromWaitLogs } from "@/lib/waitLogToTimeline";
import { calcWaitCost, sumWaitCost } from "@/lib/waitCostCalc";
import { DEMO_FACILITY_NAMES, DEMO_VEHICLE_CLASS, DEMO_WAIT_LOGS } from "@/demo/demoData";

/** 架空の運送会社と荷主。実在の団体名は使わない */
const DEMO_PARTIES: ReportParties = {
  carrier: "架空運送株式会社",
  shippers: ["架空水産", "架空冷蔵", "架空物産"],
};

/**
 * /demo の「荷主に渡す報告書」。
 * 実際の共有リンク（/shared/:token）と同じ紙面（ReportDocument）を、架空の打刻記録から作って見せる。
 * 本番 DB には一切アクセスしない。
 */
export default function DemoReport() {
  const report = useMemo<ReportData>(() => {
    const { entries, totalWaitMinutes, waitMinutesPerEvent } = convertWaitLogsToTimeline(
      DEMO_WAIT_LOGS,
      DEMO_FACILITY_NAMES,
    );
    return {
      id: "demo-report-0001",
      report_date: "2026-10-03",
      vehicle_class: DEMO_VEHICLE_CLASS,
      total_wait_minutes: totalWaitMinutes,
      estimated_wait_cost: sumWaitCost(waitMinutesPerEvent, DEMO_VEHICLE_CLASS),
      formal_report: generateFormalReportFromWaitLogs(DEMO_WAIT_LOGS, DEMO_FACILITY_NAMES),
      has_discrepancy: false,
      // 待機の行には、同じ算定ロジックで行ごとの待機料を入れる
      timeline_snapshot: entries.map((e) =>
        e.waitMinutes ? { ...e, waitCost: calcWaitCost(e.waitMinutes, DEMO_VEHICLE_CLASS) } : e,
      ),
      submitted_at: "2026-10-03T18:30:00+09:00",
      organization_id: null,
      user_id: null,
    };
  }, []);

  return (
    <div
      className="min-h-screen bg-gray-100 pb-24 print:bg-white print:pb-0"
      style={{ WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" } as React.CSSProperties}
    >
      <PageHeader title="報告書" subtitle="荷主に届く報告書（デモ）" backTo="/demo" className="print:hidden" />

      <div className="border-b bg-muted px-4 py-2 text-center text-xs text-muted-foreground print:hidden">
        表示しているのは架空のデータです。実在の施設・人物・取引とは関係ありません。
      </div>

      <div className="mx-auto max-w-4xl px-4 pt-4 print:hidden">
        <FieldButton className="gap-3" onClick={() => window.print()}>
          <Printer />
          この報告書を印刷・PDF保存する
        </FieldButton>
      </div>

      <ReportDocument report={report} parties={DEMO_PARTIES} showViewNote={false} />

      <div className="print:hidden">
        <DemoBottomNav />
      </div>
    </div>
  );
}
