import { useMemo } from "react";
import { Printer } from "lucide-react";
import { FieldButton } from "@/components/ui/field-button";
import { PageHeader } from "@/components/PageHeader";
import { DemoBottomNav } from "@/components/demo/DemoBottomNav";
import { DEMO_SAMPLE_PDF, DemoPdfLink } from "@/components/demo/DemoPdfLink";
import { ReportDocument, type ReportData, type ReportParties } from "@/components/report/ReportDocument";
import { convertWaitLogsToTimeline, generateFormalReportFromWaitLogs } from "@/lib/waitLogToTimeline";
import { calcWaitCost, sumWaitCost } from "@/lib/waitCostCalc";
import { DEMO_FACILITY_NAMES, DEMO_VEHICLE_CLASS, DEMO_WAIT_LOGS } from "@/demo/demoData";
import { groupTimelineByVisit } from "@/demo/groupTimelineByVisit";

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

  // 要点の欄に出す、施設ごとの待機時間（打刻タイムラインと同じまとめ方）
  const visits = useMemo(() => groupTimelineByVisit(report.timeline_snapshot), [report]);

  return (
    <div
      className="demo-app min-h-screen bg-gray-100 pb-28 print:bg-white print:pb-0"
      style={{ WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" } as React.CSSProperties}
    >
      {/* PC では左のサイドバーで移動できるので、上のヘッダーは出さない */}
      <PageHeader title="報告書" subtitle="荷主に届く報告書（デモ）" backTo="/demo" className="print:hidden lg:hidden" />

      <div className="border-b bg-muted px-4 py-2 text-center text-xs text-muted-foreground print:hidden">
        架空のデータです。実在の施設・人物・取引とは無関係です。
      </div>

      {/* スマホ: ボタン → 紙面の縦並び。PC: 左に紙面、右に要点とボタン（スクロールしても右は残る） */}
      <div className="lg:mx-auto lg:grid lg:max-w-6xl lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-6 lg:px-6 print:block">
        <aside className="mx-auto flex max-w-4xl flex-col gap-3 px-4 pt-4 print:hidden lg:sticky lg:top-6 lg:order-2 lg:mx-0 lg:max-w-none lg:px-0 lg:pt-6">
          {/* PC だけ: 紙面を下まで読まなくても分かる要点 */}
          <section className="hidden rounded-2xl border bg-card p-4 shadow-sm lg:block" aria-label="この報告書の要点">
            <p className="text-sm text-muted-foreground">この日の待機料（目安）</p>
            <p className="text-4xl font-extrabold tracking-tight tabular-nums">
              ¥{report.estimated_wait_cost.toLocaleString()}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              総待機 {report.total_wait_minutes.toLocaleString()}分・{DEMO_PARTIES.shippers.length}荷主
            </p>
            <ul className="mt-3 space-y-1.5 border-t pt-3 text-sm">
              {visits.map((v) => (
                <li key={v.key} className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate">{v.locationName}</span>
                  <span className="shrink-0 font-semibold tabular-nums">
                    {v.waitMinutes === null ? "算定不能" : `${v.waitMinutes}分`}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <FieldButton className="gap-3 lg:px-4 lg:text-base" onClick={() => window.print()}>
            <Printer />
            この報告書を印刷・PDF保存する
          </FieldButton>
          <DemoPdfLink href={DEMO_SAMPLE_PDF.report}>PDFの見本を開く</DemoPdfLink>
          <p className="text-xs text-muted-foreground lg:hidden">
            印刷が動かない端末（ホーム画面から開いたアプリなど）では、PDFの見本を開いてください。
          </p>
        </aside>

        <div className="lg:order-1">
          <ReportDocument report={report} parties={DEMO_PARTIES} showViewNote={false} />
        </div>
      </div>

      <div className="print:hidden">
        <DemoBottomNav />
      </div>
    </div>
  );
}
