import type { ReactNode } from "react";
import { FileText } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead,
  TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { NoticeMark } from "@/components/NoticeMark";
import { RiskReportSummary } from "./RiskReportSummary";

/** monthly_wait_risk_reports ビューの1行（荷主 × 拠点 × 月） */
export interface RiskReportRow {
  client_organization_name: string | null;
  location_name: string | null;
  report_month: string | null;
  total_visits: number | null;
  /** 荷待ち時間を算定できなかった訪問数（荷役開始が未記録） */
  unmeasured_visits: number | null;
  /** 等級C＝通信圏外の申告を運行管理者が承認した訪問数 */
  approved_claim_visits: number | null;
  total_wait_minutes: number | null;
  estimated_loss_jpy: number | null;
  gmen_risk_level: string | null;
}

function formatMonth(val: string | null): string {
  if (!val) return "—";
  // "2026-09-01" を new Date に通すと端末のタイムゾーンで前月にずれることがあるので、文字から読む
  const m = /^(\d{4})-(\d{2})/.exec(val);
  if (m) return `${m[1]}年${Number(m[2])}月`;
  const d = new Date(val);
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

function formatJpy(val: number | null): string {
  if (val === null || val === undefined) return "¥0";
  return `¥${val.toLocaleString("ja-JP")}`;
}

/**
 * 遅延利息の1日あたりの目安。年率14.6%を仮定し、未払額に乗じて365で割る。
 * この帳票には支払済みの記録も遅延日数も無いので、日数1日分だけを出す。
 */
function calcDailyLateInterest(unpaidJpy: number | null): number {
  if (!unpaidJpy) return 0;
  return Math.round((unpaidJpy * 0.146) / 365);
}

function RiskBadge({ level }: { level: string | null }) {
  if (!level) return <span>—</span>;
  const styles: Record<string, string> = {
    // 画面は青の濃さで3段階（濃い=高、中くらい=中、うすい=低）。文字の「高・中・低」も必ず出す。印刷は白黒
    高: "border-blue-700 bg-blue-700 text-white hover:bg-blue-700 print:bg-transparent print:text-black print:border-2 print:border-black print:font-bold",
    中: "border-blue-200 bg-blue-200 text-blue-900 hover:bg-blue-200 print:bg-transparent print:text-black print:border-2 print:border-black",
    低: "border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-50 print:bg-transparent print:text-black print:border-2 print:border-black",
  };
  return (
    <Badge className={`px-3 py-1 text-sm ${styles[level] || ""}`}>{level}</Badge>
  );
}

/**
 * 判定のもとになる、訪問1回あたりの平均待機（分）。算定できた訪問だけの平均で、DBビューの
 * avg(wait_minutes) と同じ対象。列の合計は整数に丸められているので、判定の境目で食い違わないよう切り捨てる。
 * 算定できた訪問が1件も無ければ null。表示専用で、判定そのものはビュー側で行われる。
 */
function averageMeasuredWait(row: RiskReportRow): number | null {
  const measured = (row.total_visits ?? 0) - (row.unmeasured_visits ?? 0);
  if (measured <= 0) return null;
  return Math.floor((row.total_wait_minutes ?? 0) / measured);
}

/** リスク判定のバッジと、その根拠になった平均待機を並べる。表とカードの両方で使う。 */
function RiskCell({ row, align, dot = false }: { row: RiskReportRow; align: "end" | "center"; dot?: boolean }) {
  const avg = averageMeasuredWait(row);
  if (dot && row.gmen_risk_level) {
    // 一覧の行用: 小さな点（濃さで高・中・低）と文字。平均は括弧で添える
    const dotColor = { 高: "bg-blue-700", 中: "bg-blue-400", 低: "bg-blue-200" }[row.gmen_risk_level] ?? "bg-muted";
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm">
        <span className={`h-2.5 w-2.5 rounded-full ${dotColor}`} aria-hidden />
        <span className="font-bold text-foreground">{row.gmen_risk_level}</span>
        <span className="text-xs text-muted-foreground">{avg === null ? "平均 —" : `平均 ${avg}分`}</span>
      </span>
    );
  }
  return (
    <div className={`flex flex-col gap-1 ${align === "center" ? "items-center" : "items-end"}`}>
      <RiskBadge level={row.gmen_risk_level} />
      {row.gmen_risk_level && (
        <span className="whitespace-nowrap text-xs text-muted-foreground print:text-[10pt] print:text-black">
          {avg === null ? "平均 —" : `平均 ${avg}分`}
        </span>
      )}
    </div>
  );
}

/**
 * 算定不能・等級Cが混ざっていることを帳票上で明示する。
 * 注記がないと「0円＝待機がなかった」と誤読される。表とカードの両方で使う。
 */
function VisitBreakdown({ row }: { row: RiskReportRow }) {
  const unmeasured = row.unmeasured_visits ?? 0;
  const approved = row.approved_claim_visits ?? 0;
  if (unmeasured <= 0 && approved <= 0) return null;
  return (
    <div className="whitespace-nowrap text-xs text-muted-foreground print:text-[10pt] print:text-black">
      {unmeasured > 0 && (
        <div>
          <span className="inline-flex items-center gap-1">
            <NoticeMark />
            うち算定不可 {row.unmeasured_visits}
          </span>
        </div>
      )}
      {approved > 0 && (
        <div>
          <span className="inline-flex items-center gap-1">
            <NoticeMark />
            うち圏外承認 {row.approved_claim_visits}
          </span>
        </div>
      )}
    </div>
  );
}

interface RiskReportDocumentProps {
  rows: RiskReportRow[];
  loading?: boolean;
  /** 提出元。null は読み込み中（スケルトンを出す） */
  orgName: string | null;
  issueDate: string;
  /** 「2026年9月」のような対象月の表示 */
  monthLabel: string;
  /** タイトルと表の間に置く操作部（対象月の選択・印刷ボタン）。印刷には出ない */
  controls?: ReactNode;
}

/**
 * 警告レポート（荷主別 待機時間リスクレポート）の紙面。
 * 実際の画面（Report.tsx）と /demo/warning の両方が使う。データの取得は呼び出し側の仕事。
 */
export function RiskReportDocument({
  rows,
  loading = false,
  orgName,
  issueDate,
  monthLabel,
  controls,
}: RiskReportDocumentProps) {
  // 帳票全体での内訳。0円や少ない金額が「待機が無かった」と読まれないよう、
  // 算定できなかった訪問と時刻未検証の訪問を注記で明示するために集計する。
  const totalUnmeasured = rows.reduce((s, r) => s + (r.unmeasured_visits ?? 0), 0);
  const totalApprovedClaims = rows.reduce((s, r) => s + (r.approved_claim_visits ?? 0), 0);

  // 折りたたみの見出し。中身にある注記の種類だけを挙げる
  const notesLabel = [
    "注記：金額の算定方法",
    totalUnmeasured > 0 && "算定不可",
    totalApprovedClaims > 0 && "圏外承認",
  ].filter(Boolean).join("・");

  const notes = (
    <div className="space-y-1">
      <p>
        ※ 推定逸失利益は、待機料の考え方にもとづき、待機1回ごとに30分を差し引いた時間に車格別の単価を乗じて算定した額です。
      </p>
      {/* 遅延利息は紙にだけ出す列なので、その注記も紙にだけ出す */}
      <p className="hidden print:block">
        ※ 遅延利息の目安は、推定逸失利益が未払のままのとき、1日遅れるごとに加わる額（推定逸失利益 × 年率14.6% ÷ 365日）です。実際の額は、未払額と遅れた日数で決まります。
      </p>
      {totalUnmeasured > 0 && (
        <p className="flex items-start gap-1">
          <NoticeMark className="mt-0.5" />
          <span>
            ※「算定不可」は荷役開始が記録されておらず、荷待ち時間を確定できなかった訪問です（{totalUnmeasured}件）。
          </span>
        </p>
      )}
      {totalApprovedClaims > 0 && (
        <p className="flex items-start gap-1">
          <NoticeMark className="mt-0.5" />
          <span>
            {`※「圏外承認」は通信圏外で端末に記録され、運行管理者が承認した訪問です（${totalApprovedClaims}件）。GPS座標は打刻時点のものですが、時刻についてはサーバーによる自動検証が行われていません。`}
          </span>
        </p>
      )}
    </div>
  );

  return (
    <main className="mx-auto max-w-4xl p-4 pb-28 [line-break:strict] [text-wrap:pretty] [word-break:auto-phrase] print:max-w-none print:p-0 print:pb-0 print:font-serif-jp">
      {/* Report Title */}
      <div className="mb-4 text-center print:mb-8">
        {/* 発行元情報 */}
        <div className="hidden print:mb-6 print:block">
          <p className="text-sm text-muted-foreground print:text-black">
            提出元:
            {orgName ? (
              <span className="ml-2 text-base font-bold text-foreground print:text-black">
                {orgName}
              </span>
            ) : (
              <Skeleton className="ml-2 inline-block h-5 w-40 align-middle print:hidden" />
            )}
          </p>
          <p className="mt-1 text-sm text-muted-foreground print:text-black">
            発行日: {issueDate}
          </p>
        </div>
        {/* レポートタイトル */}
        <h1 className="text-balance text-xl font-extrabold text-foreground sm:text-2xl print:text-black print:text-3xl">
          <span className="inline-block">荷主別</span> <span className="inline-block">待機時間リスクレポート</span>
        </h1>
        <p className="hidden print:mt-0.5 print:block print:text-[10pt] print:text-black">
          守護神 — 物流記録管理システム
        </p>
      </div>

      {controls}

      {/* 印刷時のみ: 対象月の表示 */}
      <div className="hidden print:block print:mb-4 print:text-center">
        <p className="text-base font-bold text-black">対象月: {monthLabel}</p>
      </div>

      {!loading && rows.length > 0 && <RiskReportSummary rows={rows} monthLabel={monthLabel} />}

      {!loading && rows.length > 0 && (
        <>
          {/* 画面: 判定の基準だけを1行で。紙: 判定のしかたの説明も付ける */}
          <p className="mb-3 px-1 text-xs text-muted-foreground print:hidden">
            判定（訪問1回の平均待機）：
            <strong className="font-semibold text-foreground">60分以上＝高、30分以上＝中、30分未満＝低</strong>
          </p>
          <p className="mb-3 hidden print:block print:p-0 print:text-[10.5pt] print:leading-relaxed print:text-black">
            リスク判定の見かた：荷主・拠点ごとに、訪問1回あたりの平均待機時間（待機時間を測れなかった訪問は除く）で判定します。
            <strong className="font-semibold print:text-black">60分以上＝高、30分以上＝中、30分未満＝低</strong>。
          </p>
        </>
      )}

      {/* Data Table */}
      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 rounded-xl" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center print:border-black">
          <FileText className="mx-auto mb-3 h-12 w-12 text-muted-foreground" />
          <p className="text-lg font-semibold text-card-foreground">データがありません</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {monthLabel}の完了済み打刻データがありません。対象月を変更するか、打刻データが蓄積されるのをお待ちください。
          </p>
        </div>
      ) : (
        <div className="border-y border-border bg-card print:rounded-xl print:border print:border-black print:bg-white print:shadow-none">
          {/* 画面の表は5列（対象月と遅延利息の目安は紙だけ。対象月は上に出ていて、遅延利息は年率を仮定した参考値のため）。
              狭い画面（md 未満）は、表を横にスクロールさせず、1行ずつのカードにする。
              印刷は紙の幅が md 未満でも表のまま（print: で表を出し、カードを隠す）。 */}
          <ul className="divide-y divide-border/70 md:hidden print:hidden">
            {rows.map((row, i) => (
              <li key={i} className="space-y-1.5 py-3.5">
                {/* iPhone の一覧のように、左に名前、右に金額。判定は小さな点と文字 */}
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 text-base font-semibold">
                    {row.client_organization_name || "不明な荷主"}
                    {row.location_name && (
                      <span className="block text-sm font-normal text-muted-foreground">
                        ＠ {row.location_name}
                      </span>
                    )}
                  </p>
                  <span className="shrink-0 text-right">
                    <span className="block text-xl font-bold tabular-nums text-blue-900">
                      {formatJpy(row.estimated_loss_jpy)}
                    </span>
                    <span className="block text-xs text-muted-foreground">推定逸失利益</span>
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground tabular-nums">
                  <span>
                    待機 <span className="font-semibold text-foreground">{row.total_wait_minutes ?? 0}分</span>
                    <span className="mx-1.5">・</span>
                    訪問 <span className="font-semibold text-foreground">{row.total_visits ?? 0}</span>
                  </span>
                  <RiskCell row={row} align="end" dot />
                </div>
                <VisitBreakdown row={row} />
              </li>
            ))}
          </ul>
          <Table className="hidden md:table print:table print:min-w-0 print:text-[10pt] print:[&_td]:px-2 print:[&_th]:px-2">
            <TableHeader>
              <TableRow className="print:border-black">
                <TableHead className="whitespace-nowrap font-bold print:text-black">荷主名 / 拠点</TableHead>
                <TableHead className="hidden whitespace-nowrap font-bold print:table-cell print:text-black">対象月</TableHead>
                <TableHead className="whitespace-nowrap text-right font-bold print:text-black">訪問回数</TableHead>
                <TableHead className="whitespace-nowrap text-right font-bold print:text-black">総待機時間</TableHead>
                <TableHead className="whitespace-nowrap text-right font-bold print:text-black">推定逸失利益</TableHead>
                <TableHead className="hidden text-right font-bold print:table-cell print:text-black">遅延利息の目安<br />（1日あたり）</TableHead>
                <TableHead className="whitespace-nowrap text-center font-bold print:text-black">リスク判定</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, i) => (
                <TableRow key={i} className="print:break-inside-avoid print:border-black">
                  <TableCell className="print:text-black">
                    <span className="font-semibold">
                      {row.client_organization_name || "不明な荷主"}
                    </span>
                    {row.location_name && (
                      <span className="block whitespace-nowrap text-xs text-muted-foreground print:text-[10pt] print:text-black">
                        ＠ {row.location_name}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap print:table-cell print:text-black">{formatMonth(row.report_month)}</TableCell>
                  <TableCell className="text-right print:text-black">
                    {row.total_visits ?? 0}
                    <VisitBreakdown row={row} />
                  </TableCell>
                  <TableCell className="text-right font-semibold print:text-black">
                    {row.total_wait_minutes ?? 0}分
                  </TableCell>
                  <TableCell className="text-right font-bold text-blue-900 print:text-black">
                    {formatJpy(row.estimated_loss_jpy)}
                  </TableCell>
                  <TableCell className="hidden text-right font-bold text-blue-900 print:table-cell print:text-black">
                    {formatJpy(calcDailyLateInterest(row.estimated_loss_jpy))}
                  </TableCell>
                  <TableCell>
                    <RiskCell row={row} align="center" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {rows.length > 0 && (
        <>
          {/* 長い注記は画面では折りたたむ。<details> は閉じていると印刷に出ないので、
              紙・PDF には同じ内容を展開した形で別に出す（注記を紙から落とさないため）。 */}
          <details className="mt-3 rounded-lg border border-border bg-card text-xs text-muted-foreground print:hidden">
            <summary className="cursor-pointer select-none px-3 py-2 font-semibold text-foreground">
              {notesLabel}
            </summary>
            <div className="border-t border-border px-3 py-2">{notes}</div>
          </details>
          <div className="mt-3 hidden text-xs text-muted-foreground print:block print:break-inside-avoid print:text-[10pt] print:leading-relaxed print:text-black">
            <p className="mb-1 font-semibold print:text-black">注記</p>
            {notes}
          </div>
        </>
      )}

      {/* Legal Disclaimer Footer */}
      <footer className="mt-6 border-t border-border pt-3 print:mt-8 print:break-inside-avoid print:border-black print:pt-4">
        <p className="text-xs text-muted-foreground print:hidden">
          記録データをもとにした参考資料です。法的助言ではありません。
        </p>
        <div className="hidden print:block">
          <p className="print:text-sm print:font-semibold print:leading-relaxed print:text-black">
            本資料は記録データをもとにした参考資料です。
            {totalApprovedClaims > 0
              ? "記録された待機時間は、GPSおよび端末ログにより担保されたもの（サーバー時刻で検証済み）と、通信圏外のため運行管理者が承認したもの（時刻の自動検証なし）で構成されています。後者は上記の「圏外承認」件数をご確認ください。"
              : "記録された待機時間は、到着時の位置情報（GPS）とサーバー時刻にもとづく記録です。荷主との協議や待機料の請求の際の資料としてご利用いただけます。"}
          </p>
          <p className="mt-3 print:text-[10pt] print:leading-relaxed print:text-black">
            遅延利息の目安は、年率14.6%を仮定して計算した参考値です。法的助言ではありません。
          </p>
        </div>
      </footer>
    </main>
  );
}
