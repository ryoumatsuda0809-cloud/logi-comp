/**
 * 乗務記録 兼 待機時間報告書（A4 の紙面）。
 * 共有リンク（SharedReportView）と /demo の両方が同じ紙面を使う。データの取得はここでは行わない。
 */
/* ------------------------------------------------------------------ */
/*  Timeline item type                                                */
/* ------------------------------------------------------------------ */
export interface TimelineEntry {
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
export interface ReportData {
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
  /** 荷主名を打刻の施設IDから引くために使う。共有リンク経由では持たない */
  user_id: string | null;
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

/** 記録方法の表示。証拠の強さが読み手に伝わるよう、記録の出どころを明記する */
function recordMethodLabel(item: TimelineEntry): string {
  if (item.evidenceGrade === "C") return "等級C：承認済みの申告";
  return item.source === "gps" ? "等級A：サーバー検証済" : "音声（本人申告）";
}


export interface ReportParties {
  carrier: string | null;
  shippers: string[];
}

export function ReportDocument({
  report,
  parties,
  showViewNote = true,
}: {
  report: ReportData;
  parties: ReportParties;
  /** 共有リンクの閲覧記録の注記（画面のみ）。/demo では実際の記録をしないので出さない */
  showViewNote?: boolean;
}) {
  // 等級C（通信圏外の申告を管理者が承認したもの）の件数。
  // 到着イベントで数えることで、1回の待機を1件として数える。
  const approvedClaimCount = report.timeline_snapshot.filter(
    (t) => t.evidenceGrade === "C" && t.eventType === "arrival"
  ).length;
  const selfApprovedCount = report.timeline_snapshot.filter(
    (t) => t.evidenceGrade === "C" && t.eventType === "arrival" && t.selfApproved
  ).length;

  const cellClass = "border border-gray-800 px-3 py-2 print:px-2 print:py-1 text-sm";
  const thClass = "border border-gray-800 px-3 py-2 print:px-2 print:py-1 text-sm font-bold bg-gray-200 print:bg-gray-200 text-left whitespace-nowrap";

  return (
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
              中小受託取引適正化法（取適法）準拠
            </p>
          </div>

          {/* Two-column: To/From + Meta */}
          <div className="flex justify-between items-start gap-8 mb-4 print:gap-2 print:mb-2">
            {/* Left: To / From */}
            <div className="space-y-3">
              <div>
                <p className="text-xs text-gray-500">提出先</p>
                <p className="text-lg font-bold text-black border-b-2 border-black pb-0.5 inline-block">
                  {parties.shippers.length > 0
                    ? `${parties.shippers.join("、")}　御中`
                    : "（提出先未設定）"}
                </p>
              </div>
              <div className="flex items-center gap-4">
                <div>
                  <p className="text-xs text-gray-500">提出元</p>
                  <p className="text-base font-bold text-black">{parties.carrier ?? "（提出元未設定）"}</p>
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
                <span className="text-gray-500">{report.id.startsWith("live-") ? "作成日時: " : "提出日時: "}</span>
                <span className="font-bold text-black">{new Date(report.submitted_at).toLocaleString("ja-JP")}</span>
              </div>
              <div>
                <span className="text-gray-500">報告書番号: </span>
                <span className="font-bold text-black">{report.id.slice(0, 8).toUpperCase()}</span>
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
            <div className="overflow-x-auto print:overflow-visible">
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
                        {recordMethodLabel(item)}
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
            </div>
          </section>
        )}

        {/* ══════════════════════════════════════════════ */}
        {/*  FOOTER — Legal Disclaimer                     */}
        {/* ══════════════════════════════════════════════ */}
        <footer className="border-t-2 border-black mt-12 pt-4 print:mt-4 print:pt-2 break-inside-avoid">
          {showViewNote && (
            <p className="text-xs text-gray-700 font-mono leading-relaxed print:hidden">
              ※共有リンクで開かれた回数と最終閲覧日時は記録されます。
            </p>
          )}
          <p className="text-xs text-gray-400 mt-3 font-mono text-right">
            — 本書は電子的に生成されました —
          </p>
        </footer>
      </article>
  );
}
