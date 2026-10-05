import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
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
      className="min-h-screen bg-gray-100 print:bg-white"
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
      </div>

      <div className="mx-auto max-w-4xl px-4 pt-4 print:hidden">
        <p className="mb-3 text-sm text-muted-foreground">
          荷主に届く報告書です。実際の画面では、運送会社が作る閲覧リンクから、荷主がログインなしで開きます。
          等級A（サーバー検証済）と等級C（承認済みの申告）は、記録方法の列と注記で区別して示します。
        </p>
        <Button size="lg" className="h-14 w-full gap-3 text-lg" onClick={() => window.print()}>
          <Printer className="h-6 w-6" />
          この報告書を印刷・PDF保存する
        </Button>
      </div>

      <ReportDocument report={report} parties={DEMO_PARTIES} showViewNote={false} />
    </div>
  );
}
