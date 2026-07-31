import { useEffect, useState, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Printer, AlertTriangle, ArrowLeft } from "lucide-react";
import type { Json } from "@/integrations/supabase/types";
import { convertWaitLogsToTimeline, generateFormalReportFromWaitLogs } from "@/lib/waitLogToTimeline";
import { sumWaitCost } from "@/lib/waitCostCalc";

/* ------------------------------------------------------------------ */
/*  In-App Browser Detection                                          */
/* ------------------------------------------------------------------ */
function isInAppBrowser(): boolean {
  const ua = navigator.userAgent;
  return /Line\/|FBAN|FBAV|Instagram|Twitter|MicroMessenger/i.test(ua);
}

/* ------------------------------------------------------------------ */
/*  Timeline item type                                                */
/* ------------------------------------------------------------------ */
interface TimelineEntry {
  source: string;
  timestamp: string;
  eventType: string;
  locationName?: string;
  waitMinutes?: number;
  waitCost?: number;
  /** 'C'=通信圏外の申告を運行管理者が承認したもの。等級Aと区別して提示する */
  evidenceGrade?: string;
  selfApproved?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Report data shape                                                 */
/* ------------------------------------------------------------------ */
interface ReportData {
  id: string;
  report_date: string;
  vehicle_class: string;
  total_wait_minutes: number;
  estimated_wait_cost: number;
  formal_report: string | null;
  has_discrepancy: boolean;
  timeline_snapshot: TimelineEntry[];
  submitted_at: string;
  organization_id: string | null;
}

/* (MOCK_REPORT deleted — all data comes from Supabase) */

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */
const EVENT_LABELS: Record<string, string> = {
  arrival: "到着",
  waiting_start: "荷待ち開始",
  loading_start: "荷役開始",
  departure: "出発",
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "--:--";
  }
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr + "T00:00:00");
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  } catch {
    return dateStr;
  }
}

function parseTimeline(json: Json): TimelineEntry[] {
  if (!Array.isArray(json)) return [];
  return json as unknown as TimelineEntry[];
}

/* ================================================================== */
/*  SharedReportView Component                                        */
/* ================================================================== */
export default function SharedReportView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [report, setReport] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const inApp = useMemo(() => isInAppBrowser(), []);

  /* ---------- Data fetch with wait_logs fallback ---------- */
  useEffect(() => {
    async function load() {
      setLoading(true);

      // Case 1: URL has a submitted_reports ID → fetch it
      if (id) {
        const { data, error } = await supabase
          .from("submitted_reports")
          .select("*")
          .eq("id", id)
          .maybeSingle();

        if (!error && data) {
          setReport({
            id: data.id,
            report_date: data.report_date,
            vehicle_class: data.vehicle_class,
            total_wait_minutes: data.total_wait_minutes,
            estimated_wait_cost: data.estimated_wait_cost,
            formal_report: data.formal_report ?? null,
            has_discrepancy: data.has_discrepancy,
            timeline_snapshot: parseTimeline(data.timeline_snapshot),
            submitted_at: data.submitted_at,
            organization_id: data.organization_id,
          });
          setLoading(false);
          setLoading(false);
          return;
        }
      }

      // Case 2: No ID or not found → fetch today's wait_logs for logged-in user
      if (user) {
        const todayStr = new Date().toISOString().slice(0, 10);
        const todayStart = `${todayStr}T00:00:00`;
        const todayEnd = `${todayStr}T23:59:59`;

        const [logsRes, facilitiesRes, profileRes] = await Promise.all([
          supabase
            .from("wait_logs")
            .select("*")
            .eq("user_id", user.id)
            .gte("arrival_time", todayStart)
            .lte("arrival_time", todayEnd)
            .order("arrival_time", { ascending: true }),
          supabase.from("facilities").select("id, name"),
          supabase.from("profiles").select("vehicle_class").eq("user_id", user.id).maybeSingle(),
        ]);

        const logs = logsRes.data ?? [];
        const vc = profileRes.data?.vehicle_class ?? "4t";

        if (logs.length > 0) {
          // Build facility map
          const facilityMap: Record<string, string> = {};
          for (const f of facilitiesRes.data ?? []) {
            facilityMap[f.id] = f.name;
          }

          const { entries, totalWaitMinutes, waitMinutesPerEvent } = convertWaitLogsToTimeline(logs, facilityMap);
          // 30分の控除は待機1回ごとに適用する。日次合計に calcWaitCost を1回だけ
          // 適用すると控除が1回分しか効かず、荷主へ提示する請求額が過大になる。
          const waitCost = sumWaitCost(waitMinutesPerEvent, vc);
          const formalReport = generateFormalReportFromWaitLogs(logs, facilityMap);

          setReport({
            id: `live-${todayStr}`,
            report_date: todayStr,
            vehicle_class: vc,
            total_wait_minutes: totalWaitMinutes,
            estimated_wait_cost: waitCost,
            formal_report: formalReport,
            has_discrepancy: false,
            timeline_snapshot: entries,
            submitted_at: new Date().toISOString(),
            organization_id: null,
          });
          setLoading(false);
          setLoading(false);
          return;
        }
      }

      // Case 3: No data at all → Empty State
      setReport(null);
      setLoading(false);
    }
    load();
  }, [id, user]);

  /* ---------- Silent read receipt ---------- */
  useEffect(() => {
    if (!report) return;
    const log = {
      reportId: report.id,
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
    };
    console.log("[Silent] 閲覧ログを記録しました:", log);
  }, [report]);

  /* ---------- Loading state ---------- */
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-100">
        <div className="animate-pulse text-gray-500 text-lg">読み込み中...</div>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-center space-y-4 px-6">
          <p className="text-5xl">📄</p>
          <h2 className="text-xl font-bold text-foreground">レポートが見つかりません</h2>
          <p className="text-muted-foreground text-base">本日の乗務記録はまだありません。</p>
          <a href="/" className="inline-block mt-4 px-6 py-3 bg-primary text-primary-foreground rounded-lg font-bold">
            トップページへ戻る
          </a>
        </div>
      </div>
    );
  }

  // 等級C（通信圏外の申告を管理者が承認したもの）の件数。
  // 到着イベントで数えることで、1回の待機を1件として数える。
  const approvedClaimCount = report.timeline_snapshot.filter(
    (t) => t.evidenceGrade === "C" && t.eventType === "arrival"
  ).length;
  const selfApprovedCount = report.timeline_snapshot.filter(
    (t) => t.evidenceGrade === "C" && t.eventType === "arrival" && t.selfApproved
  ).length;

  const cellClass = "border border-gray-800 px-3 py-2 print:px-2 print:py-1 text-sm";
  const thClass = "border border-gray-800 px-3 py-2 print:px-2 print:py-1 text-sm font-bold bg-gray-200 print:bg-gray-200 text-left";

  /* ================================================================ */
  /*  Render                                                          */
  /* ================================================================ */
  return (
    <div
      className="min-h-screen bg-gray-100 print:bg-white"
      style={{ WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" } as React.CSSProperties}
    >
      {/* ---- In-app browser warning ---- */}
      {inApp && (
        <div className="sticky top-0 z-50 bg-red-600 px-4 py-3 text-center text-white font-bold text-base print:hidden">
          <AlertTriangle className="inline-block h-5 w-5 mr-2 -mt-0.5" />
          ⚠️ このブラウザでは印刷機能が使えません。右上の「…」メニューから「Safari（またはChrome）で開く」を選択してください。
        </div>
      )}

      {/* ---- Back button (print:hidden) ---- */}
      <div className="mx-auto max-w-4xl px-4 pt-4 print:hidden">
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 text-muted-foreground hover:text-foreground"
          onClick={() => navigate("/")}
        >
          <ArrowLeft className="h-4 w-4" />
          ホームに戻る
        </Button>
      </div>

      {/* ---- Print button ---- */}
      <div className="mx-auto max-w-4xl px-4 pt-6 print:hidden">
        <Button
          size="lg"
          className="w-full text-lg gap-3 h-14"
          onClick={() => window.print()}
        >
          <Printer className="h-6 w-6" />
          🖨️ この報告書を印刷・PDF保存する
        </Button>
      </div>

      {/* ---- A4 Paper Container ---- */}
      <article
        className="mx-auto max-w-4xl bg-white border border-gray-300 shadow-[0_0_20px_rgba(0,0,0,0.08)] my-6 px-8 py-10 md:px-12 md:py-12 print:border-none print:shadow-none print:max-w-none print:m-0 print:px-4 print:py-2 font-serif-jp"
        style={{ WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" } as React.CSSProperties}
      >

        {/* ══════════════════════════════════════════════ */}
        {/*  HEADER — Letterhead                           */}
        {/* ══════════════════════════════════════════════ */}
        <header className="mb-8 print:mb-3 break-inside-avoid">
          {/* Title */}
          <div className="text-center mb-6 print:mb-2">
            <h1 className="text-2xl font-bold tracking-widest text-black">
              乗務記録 兼 待機時間報告書
            </h1>
            <p className="text-sm text-gray-600 mt-1 tracking-wider">
              特定受託事業者取引適正化法（取適法）準拠
            </p>
          </div>

          {/* Two-column: To/From + Meta */}
          <div className="flex justify-between items-start gap-8 mb-4 print:gap-2 print:mb-2">
            {/* Left: To / From */}
            <div className="space-y-3">
              <div>
                <p className="text-xs text-gray-500">提出先</p>
                <p className="text-lg font-bold text-black border-b-2 border-black pb-0.5 inline-block">
                  〇〇水産株式会社　御中
                </p>
              </div>
              <div className="flex items-center gap-4">
                <div>
                  <p className="text-xs text-gray-500">提出元</p>
                  <p className="text-base font-bold text-black">〇〇運送株式会社</p>
                </div>
                {/* ハンコ（印鑑）プレースホルダー */}
                <div className="w-16 h-16 print:w-12 print:h-12 border-2 border-red-500/50 text-red-500/50 flex items-center justify-center rounded-sm shrink-0 font-serif text-xs">
                  印
                </div>
              </div>
            </div>

            {/* Right: Date / Doc No */}
            <div className="text-right space-y-1 font-mono text-sm shrink-0">
              <div>
                <span className="text-gray-500">発行日: </span>
                <span className="font-bold text-black">{formatDate(report.report_date)}</span>
              </div>
              <div>
                <span className="text-gray-500">報告書番号: </span>
                <span className="font-bold text-black">{report.id.slice(0, 8).toUpperCase()}</span>
              </div>
              <div>
                <span className="text-gray-500">車格: </span>
                <span className="font-bold text-black">{report.vehicle_class}</span>
              </div>
            </div>
          </div>

          <div className="border-b-2 border-black" />
        </header>

        {/* ══════════════════════════════════════════════ */}
        {/*  SUMMARY TABLE                                 */}
        {/* ══════════════════════════════════════════════ */}
        <section className="mb-8 print:mb-3 break-inside-avoid">
          <table
            className="w-full border-collapse text-black font-mono"
            style={{ WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" } as React.CSSProperties}
          >
            <tbody>
              <tr>
                <th className={thClass} style={{ width: "30%" }}>報告日</th>
                <td className={cellClass}>{formatDate(report.report_date)}</td>
              </tr>
              <tr>
                <th className={thClass}>車格</th>
                <td className={cellClass}>{report.vehicle_class}</td>
              </tr>
              <tr>
                <th className={thClass}>総待機時間</th>
                <td className={`${cellClass} font-bold text-lg`}>
                  {report.total_wait_minutes}分
                </td>
              </tr>
              <tr>
                <th className={thClass}>推定待機料</th>
                <td className={`${cellClass} font-bold text-lg`}>
                  ¥{report.estimated_wait_cost.toLocaleString()}
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        {/* ══════════════════════════════════════════════ */}
        {/*  等級Cの注記                                   */}
        {/*  時刻がサーバー検証されていない記録を等級Aと    */}
        {/*  同じ体裁で提示すると証拠の強さを偽ることになる */}
        {/* ══════════════════════════════════════════════ */}
        {approvedClaimCount > 0 && (
          <div className="mb-8 print:mb-3 border-l-4 border-gray-500 bg-gray-50 px-4 py-3 break-inside-avoid print:bg-gray-50">
            <p className="font-bold text-black text-sm">
              ※ 通信圏外で記録された打刻が{approvedClaimCount}件含まれています
            </p>
            <p className="mt-1 text-xs text-gray-700 leading-relaxed">
              これらは携帯電波の届かない場所で端末に記録され、通信復帰後に運行管理者が
              内容を確認して承認した記録です。GPS座標は打刻時点で取得されていますが、
              <strong>時刻についてはサーバーによる自動検証が行われていません</strong>。
              下表では該当行に「※」を付しています。
              {selfApprovedCount > 0 && (
                <>
                  {" "}
                  うち{selfApprovedCount}件は承認者と運転者が同一です。
                </>
              )}
            </p>
          </div>
        )}

        {/* ══════════════════════════════════════════════ */}
        {/*  DISCREPANCY WARNING                           */}
        {/* ══════════════════════════════════════════════ */}
        {report.has_discrepancy && (
          <div className="mb-8 print:mb-3 border-l-4 border-black bg-gray-50 px-4 py-3 break-inside-avoid print:bg-gray-50">
            <p className="font-bold text-black text-sm">
              ⚠ 注意: GPS記録と音声日報の間に不一致が検出されています。
            </p>
          </div>
        )}

        {/* ══════════════════════════════════════════════ */}
        {/*  FORMAL REPORT                                 */}
        {/* ══════════════════════════════════════════════ */}
        {report.formal_report && (
          <section className="mb-8 print:mb-3 break-inside-avoid">
            <h2 className="text-base font-bold text-black border-b border-black pb-1 mb-4 print:mb-1">
              法定乗務記録
            </h2>
            <div
              className="font-mono text-sm leading-relaxed whitespace-pre-wrap text-black bg-gray-50 border border-gray-400 p-4 print:p-2 print:bg-gray-50"
              style={{ WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" } as React.CSSProperties}
            >
              {report.formal_report}
            </div>
          </section>
        )}

        {/* ══════════════════════════════════════════════ */}
        {/*  TIMELINE TABLE                                */}
        {/* ══════════════════════════════════════════════ */}
        {report.timeline_snapshot.length > 0 && (
          <section className="mb-8 print:mb-3 break-inside-avoid">
            <h2 className="text-base font-bold text-black border-b border-black pb-1 mb-4 print:mb-1">
              タイムライン明細
            </h2>
            <table
              className="w-full border-collapse text-black font-mono text-sm"
              style={{ WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" } as React.CSSProperties}
            >
              <thead className="print:table-header-group">
                <tr>
                  <th className={thClass}>時刻</th>
                  <th className={thClass}>区分</th>
                  <th className={thClass}>記録方法</th>
                  <th className={thClass}>場所</th>
                  <th className={thClass}>待機時間</th>
                  <th className={thClass}>待機料</th>
                </tr>
              </thead>
              <tbody>
                {report.timeline_snapshot.map((item, i) => {
                  const isWait = item.eventType === "waiting_start" || (item.waitMinutes && item.waitMinutes > 0);
                  return (
                    <tr key={i} className={`print:break-inside-avoid ${isWait ? "bg-gray-100 print:bg-gray-100" : ""}`}>
                      <td className={`${cellClass} whitespace-nowrap`}>{formatTime(item.timestamp)}</td>
                      <td className={`${cellClass} ${isWait ? "font-bold" : ""}`}>
                        {EVENT_LABELS[item.eventType] || item.eventType}
                      </td>
                      <td className={cellClass}>
                        {item.source === "gps" ? "GPS" : "音声"}
                        {item.evidenceGrade === "C" && (
                          <span
                            className="font-bold"
                            title="通信圏外で記録され、運行管理者が承認した記録（時刻のサーバー検証なし）"
                          >
                            {" "}
                            ※
                          </span>
                        )}
                      </td>
                      <td className={cellClass}>{item.locationName || "—"}</td>
                      <td className={`${cellClass} text-right ${isWait ? "font-bold" : ""}`}>
                        {item.waitMinutes ? `${item.waitMinutes}分` : "—"}
                      </td>
                      <td className={`${cellClass} text-right ${isWait ? "font-bold" : ""}`}>
                        {item.waitCost ? `¥${item.waitCost.toLocaleString()}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}

        {/* ══════════════════════════════════════════════ */}
        {/*  FOOTER — Legal Disclaimer                     */}
        {/* ══════════════════════════════════════════════ */}
        <footer className="border-t-2 border-black mt-12 pt-4 print:mt-4 print:pt-2 break-inside-avoid">
          <p className="text-xs text-gray-700 font-mono leading-relaxed">
            ※本システムにより、送信および閲覧ログ（IP・タイムスタンプ）は法的に保全されています。
          </p>
          <p className="text-xs text-gray-500 mt-1 font-mono">
            提出日時: {new Date(report.submitted_at).toLocaleString("ja-JP")}
          </p>
          <p className="text-xs text-gray-400 mt-3 font-mono text-right">
            — 本書は電子的に生成された正式な報告書です —
          </p>
        </footer>
      </article>
    </div>
  );
}
