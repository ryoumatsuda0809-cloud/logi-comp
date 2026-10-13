import type { ReactNode } from "react";
import { FileText } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead,
  TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export interface ReportRow {
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
  /** 位置が運営者に確認されていない施設（運送会社が登録）での訪問数 */
  unverified_visits?: number | null;
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

function calcPenalty(monthlyLoss: number | null): number {
  if (!monthlyLoss) return 0;
  return Math.round(monthlyLoss * 12 * 0.146);
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


export interface RiskReportDocumentProps {
  rows: ReportRow[];
  loading?: boolean;
  /** 提出元（運送会社名）。未取得の間は null（スケルトンを出す） */
  orgName: string | null;
  issueDate: string;
  selectedMonthLabel: string;
  /** 対象月の選択・印刷ボタンなど（印刷時は非表示にすること） */
  controls?: ReactNode;
}

/**
 * 「荷主別 取適法リスク診断レポート」の紙面。
 * 実画面（/report）と、架空データのデモ（/demo/risk）で共用する。
 * データ取得・ヘッダー・ナビは呼び出し側が持ち、ここは表示だけを担う。
 */
export function RiskReportDocument({
  rows,
  loading = false,
  orgName,
  issueDate,
  selectedMonthLabel,
  controls,
}: RiskReportDocumentProps) {
  // 帳票全体での内訳。0円や少ない金額が「待機が無かった」と読まれないよう、
  // 算定できなかった訪問と時刻未検証の訪問を注記で明示するために集計する。
  const totalUnmeasured = rows.reduce((s, r) => s + (r.unmeasured_visits ?? 0), 0);
  const totalApprovedClaims = rows.reduce((s, r) => s + (r.approved_claim_visits ?? 0), 0);
  const totalUnverified = rows.reduce((s, r) => s + (r.unverified_visits ?? 0), 0);

  return (
    <>
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
          <h1 className="text-2xl font-extrabold text-foreground print:text-black print:text-3xl">
            荷主別 取適法リスク診断レポート
          </h1>
          <p className="mt-0.5 text-xs text-muted-foreground print:text-gray-500">
            守護神 — 物流コンプライアンス管理システム
          </p>
        </div>

        {controls}

        {/* 印刷時のみ: 対象月の表示 */}
        <div className="hidden print:block print:mb-4 print:text-center">
          <p className="text-base font-bold text-black">対象月: {selectedMonthLabel}</p>
        </div>

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
              {selectedMonthLabel}の完了済み打刻データがありません。対象月を変更するか、打刻データが蓄積されるのをお待ちください。
            </p>
          </div>
        ) : (
          <>
            {/* スマホ幅: 表は列がつぶれて読めないため、行ごとのカードで見せる（印刷時は表） */}
            <ul className="space-y-3 md:hidden print:hidden">
              {rows.map((row, i) => {
                const unmeasured = row.unmeasured_visits ?? 0;
                const approved = row.approved_claim_visits ?? 0;
                const unverified = row.unverified_visits ?? 0;
                return (
                  <li key={i} className="rounded-xl border border-border bg-card p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-foreground">
                          {row.client_organization_name || "不明な荷主"}
                        </p>
                        {row.location_name && (
                          <p className="text-xs text-muted-foreground">＠ {row.location_name}</p>
                        )}
                      </div>
                      <RiskBadge level={row.gmen_risk_level} />
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                      <div>
                        <dt className="text-xs text-muted-foreground">対象月</dt>
                        <dd>{formatMonth(row.report_month)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">訪問回数</dt>
                        <dd>
                          {row.total_visits ?? 0}
                          {(unmeasured > 0 || approved > 0 || unverified > 0) && (
                            <span className="ml-1 text-xs text-muted-foreground">
                              {unmeasured > 0 && `（うち算定不可 ${unmeasured}）`}
                              {approved > 0 && `（うち圏外承認 ${approved}）`}
                              {unverified > 0 && `（うち位置未確認 ${unverified}）`}
                            </span>
                          )}
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
                        <dt className="text-xs text-muted-foreground">遅延損害金（年率14.6%）</dt>
                        <dd className="font-bold text-destructive">
                          {formatJpy(calcPenalty(row.estimated_loss_jpy))}
                        </dd>
                      </div>
                    </dl>
                  </li>
                );
              })}
            </ul>

          <div className="hidden rounded-xl border border-border bg-card shadow-sm md:block print:block print:border-black print:bg-white print:shadow-none">
            <Table>
              <TableHeader>
                <TableRow className="print:border-black">
                  <TableHead className="font-bold print:text-black">荷主名 / 拠点</TableHead>
                  <TableHead className="font-bold print:text-black">対象月</TableHead>
                  <TableHead className="text-right font-bold print:text-black">訪問回数</TableHead>
                  <TableHead className="text-right font-bold print:text-black">総待機時間</TableHead>
                  <TableHead className="text-right font-bold print:text-black">推定逸失利益</TableHead>
                  <TableHead className="text-right font-bold print:text-black">遅延損害金(年率14.6%)</TableHead>
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
                    <TableCell className="print:text-black">{formatMonth(row.report_month)}</TableCell>
                    <TableCell className="text-right print:text-black">
                      {row.total_visits ?? 0}
                      {/* 算定不能・等級Cが混ざっていることを帳票上で明示する。
                          注記がないと「0円＝待機がなかった」と誤読される。 */}
                      {((row.unmeasured_visits ?? 0) > 0 ||
                        (row.approved_claim_visits ?? 0) > 0 ||
                        (row.unverified_visits ?? 0) > 0) && (
                        <div className="text-xs text-muted-foreground print:text-gray-600">
                          {(row.unmeasured_visits ?? 0) > 0 && (
                            <div>うち算定不可 {row.unmeasured_visits}</div>
                          )}
                          {(row.approved_claim_visits ?? 0) > 0 && (
                            <div>うち圏外承認 {row.approved_claim_visits}</div>
                          )}
                          {(row.unverified_visits ?? 0) > 0 && (
                            <div>うち位置未確認 {row.unverified_visits}</div>
                          )}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-semibold print:text-black">
                      {row.total_wait_minutes ?? 0}分
                    </TableCell>
                    <TableCell className="text-right font-bold text-destructive print:text-black">
                      {formatJpy(row.estimated_loss_jpy)}
                    </TableCell>
                    <TableCell className="text-right font-bold text-destructive print:text-black">
                      {formatJpy(calcPenalty(row.estimated_loss_jpy))}
                    </TableCell>
                    <TableCell className="text-center">
                      <RiskBadge level={row.gmen_risk_level} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          </>
        )}

        {rows.length > 0 && (
          <div className="mt-3 space-y-1 text-xs text-muted-foreground print:text-gray-600">
            <p>
              ※ 待機料は待機1回ごとに30分を控除して算定しています。
            </p>
            <p>
              ※ 遅延損害金は月次推定損失を年換算し、取適法に定める年率14.6%を適用した参考値です。
            </p>
            {totalUnmeasured > 0 && (
              <p>
                ※「算定不可」は荷役開始が記録されておらず荷待ち時間を確定できなかった訪問です。
                待機が無かったことを意味しません（{totalUnmeasured}件）。
              </p>
            )}
            {totalUnverified > 0 && (
              <p>
                ※「位置未確認」は、運送会社が登録した施設で、その位置を運営者がまだ確認していない訪問です（
                {totalUnverified}件）。記録の時刻はサーバー時刻ですが、施設の位置は登録者の申告にもとづきます。
              </p>
            )}
            {totalApprovedClaims > 0 && (
              <p>
                ※「圏外承認」は通信圏外で端末に記録され、運行管理者が承認した訪問です（
                {totalApprovedClaims}件）。GPS座標は打刻時点のものですが、
                時刻についてはサーバーによる自動検証が行われていません。
              </p>
            )}
          </div>
        )}

        {/* Legal Disclaimer Footer */}
        <footer className="mt-8 border-t border-border pt-4 print:mt-12 print:border-black">
          <p className="text-sm font-semibold leading-relaxed text-foreground print:text-black">
            本資料は、2026年施行の「中小受託取引適正化法」および国土交通省の監視基準を参考に作成しています。
            {totalApprovedClaims > 0
              ? "記録された待機時間は、GPSおよび端末ログにより担保されたもの（サーバー時刻で検証済み）と、通信圏外のため運行管理者が承認したもの（時刻の自動検証なし）で構成されています。後者は上記の「圏外承認」件数をご確認ください。"
              : "記録された待機時間は、到着時の位置情報（GPS）とサーバー時刻にもとづく記録です。荷主との協議や待機料の請求の際の資料としてご利用いただけます。"}
          </p>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground print:text-gray-600">
            取適法により、役務提供完了日から60日を超える支払遅延には年率14.6%の遅延利息が課されます。本レポートの数値はシステムが自動計算した参考値であり、法的助言を構成するものではありません。
          </p>
          <p className="mt-2 text-xs text-muted-foreground print:text-gray-500">
            Generated by 守護神 — {issueDate}
          </p>
        </footer>
    </>
  );
}
