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
    高: "bg-destructive text-destructive-foreground print:bg-transparent print:text-black print:border-2 print:border-black print:font-bold",
    中: "bg-amber-500 text-white print:bg-transparent print:text-black print:border-2 print:border-black",
    低: "bg-emerald-500 text-white print:bg-transparent print:text-black print:border-2 print:border-black",
  };
  return (
    <Badge className={`text-sm px-3 py-1 ${styles[level] || ""}`}>
      <span className="print:hidden">{level === "高" ? "🔴 " : level === "中" ? "🟡 " : "🟢 "}</span>{level}
    </Badge>
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
    <div className="whitespace-nowrap text-xs text-muted-foreground print:text-gray-600">
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

  return (
    <main className="mx-auto max-w-4xl p-4 pb-28 print:max-w-none print:p-0 print:pb-0 print:font-serif-jp">
      {/* Report Title */}
      <div className="mb-6 text-center print:mb-8">
        {/* 発行元情報 */}
        <div className="mb-4 print:mb-6">
          <p className="text-sm text-muted-foreground print:text-gray-600">
            提出元:
            {orgName ? (
              <span className="ml-2 text-base font-bold text-foreground print:text-black">
                {orgName}
              </span>
            ) : (
              <Skeleton className="ml-2 inline-block h-5 w-40 align-middle print:hidden" />
            )}
          </p>
          <p className="mt-1 text-sm text-muted-foreground print:text-gray-600">
            発行日: {issueDate}
          </p>
        </div>
        {/* レポートタイトル */}
        <h1 className="text-balance text-xl font-extrabold text-foreground sm:text-2xl print:text-black print:text-3xl">
          <span className="inline-block">荷主別</span> <span className="inline-block">待機時間リスクレポート</span>
        </h1>
        <p className="mt-0.5 text-xs text-muted-foreground print:text-gray-500">
          守護神 — 物流コンプライアンス管理システム
        </p>
      </div>

      {controls}

      {/* 印刷時のみ: 対象月の表示 */}
      <div className="hidden print:block print:mb-4 print:text-center">
        <p className="text-base font-bold text-black">対象月: {monthLabel}</p>
      </div>

      {!loading && rows.length > 0 && <RiskReportSummary rows={rows} monthLabel={monthLabel} />}

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
        <div className="rounded-xl border border-border bg-card shadow-sm print:border-black print:bg-white print:shadow-none">
          {/* 狭い画面（md 未満）は、7列の表を横にスクロールさせず、1行ずつのカードにする。
              印刷は紙の幅が md 未満でも表のまま（print: で表を出し、カードを隠す）。 */}
          <ul className="divide-y divide-border md:hidden print:hidden">
            {rows.map((row, i) => (
              <li key={i} className="space-y-2 p-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 font-semibold">
                    {row.client_organization_name || "不明な荷主"}
                    {row.location_name && (
                      <span className="block text-xs font-normal text-muted-foreground">
                        ＠ {row.location_name}
                      </span>
                    )}
                  </p>
                  <RiskBadge level={row.gmen_risk_level} />
                </div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">対象月</dt>
                    <dd>{formatMonth(row.report_month)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">訪問回数</dt>
                    <dd>
                      {row.total_visits ?? 0}
                      <VisitBreakdown row={row} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">総待機時間</dt>
                    <dd className="font-semibold">{row.total_wait_minutes ?? 0}分</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">推定逸失利益</dt>
                    <dd className="font-bold text-destructive">{formatJpy(row.estimated_loss_jpy)}</dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-xs text-muted-foreground">遅延利息の目安（1日あたり）</dt>
                    <dd className="font-bold text-destructive">
                      {formatJpy(calcDailyLateInterest(row.estimated_loss_jpy))}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
          <Table className="hidden min-w-[40rem] md:table print:table print:min-w-0">
            <TableHeader>
              <TableRow className="print:border-black">
                <TableHead className="font-bold print:text-black">荷主名 / 拠点</TableHead>
                <TableHead className="font-bold print:text-black">対象月</TableHead>
                <TableHead className="text-right font-bold print:text-black">訪問回数</TableHead>
                <TableHead className="text-right font-bold print:text-black">総待機時間</TableHead>
                <TableHead className="text-right font-bold print:text-black">推定逸失利益</TableHead>
                <TableHead className="text-right font-bold print:text-black">遅延利息の目安（1日あたり）</TableHead>
                <TableHead className="text-center font-bold print:text-black">リスク判定</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, i) => (
                <TableRow key={i} className="print:border-black">
                  <TableCell className="print:text-black">
                    <span className="font-semibold">
                      {row.client_organization_name || "不明な荷主"}
                    </span>
                    {row.location_name && (
                      <span className="ml-1 text-xs text-muted-foreground print:text-gray-500">
                        ＠ {row.location_name}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap print:text-black">{formatMonth(row.report_month)}</TableCell>
                  <TableCell className="text-right print:text-black">
                    {row.total_visits ?? 0}
                    <VisitBreakdown row={row} />
                  </TableCell>
                  <TableCell className="text-right font-semibold print:text-black">
                    {row.total_wait_minutes ?? 0}分
                  </TableCell>
                  <TableCell className="text-right font-bold text-destructive print:text-black">
                    {formatJpy(row.estimated_loss_jpy)}
                  </TableCell>
                  <TableCell className="text-right font-bold text-destructive print:text-black">
                    {formatJpy(calcDailyLateInterest(row.estimated_loss_jpy))}
                  </TableCell>
                  <TableCell className="text-center">
                    <RiskBadge level={row.gmen_risk_level} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {rows.length > 0 && (
        <div className="mt-3 space-y-1 text-xs text-muted-foreground print:text-gray-600">
          <p>
            ※ 待機料は待機1回ごとに30分を控除して算定しています。
          </p>
          <p>
            ※ 遅延利息の目安は、推定逸失利益が未払のままのとき、1日遅れるごとに加わる額（推定逸失利益 × 年率14.6% ÷ 365日）です。実際の額は、未払額と遅れた日数で決まります。
          </p>
          {totalUnmeasured > 0 && (
            <p className="flex items-start gap-1">
              <NoticeMark className="mt-0.5" />
              <span>
                ※「算定不可」は荷役開始が記録されておらず荷待ち時間を確定できなかった訪問です。
                待機が無かったことを意味しません（{totalUnmeasured}件）。
              </span>
            </p>
          )}
          {totalApprovedClaims > 0 && (
            <p className="flex items-start gap-1">
              <NoticeMark className="mt-0.5" />
              <span>
                ※「圏外承認」は通信圏外で端末に記録され、運行管理者が承認した訪問です（
                {totalApprovedClaims}件）。GPS座標は打刻時点のものですが、
                時刻についてはサーバーによる自動検証が行われていません。
              </span>
            </p>
          )}
        </div>
      )}

      {/* Legal Disclaimer Footer */}
      <footer className="mt-8 border-t border-border pt-4 print:mt-12 print:border-black">
        <p className="text-sm font-semibold leading-relaxed text-foreground print:text-black">
          本資料は記録データをもとにした参考資料です。
          {totalApprovedClaims > 0
            ? "記録された待機時間は、GPSおよび端末ログにより担保されたもの（サーバー時刻で検証済み）と、通信圏外のため運行管理者が承認したもの（時刻の自動検証なし）で構成されています。後者は上記の「圏外承認」件数をご確認ください。"
            : "記録された待機時間は、到着時の位置情報（GPS）とサーバー時刻にもとづく記録です。荷主との協議や待機料の請求の際の資料としてご利用いただけます。"}
        </p>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground print:text-gray-600">
          遅延利息の目安は、年率14.6%を仮定して計算した参考値です。法的助言ではありません。
        </p>
        <p className="mt-2 text-xs text-muted-foreground print:text-gray-500">
          Generated by 守護神 — {issueDate}
        </p>
      </footer>
    </main>
  );
}
