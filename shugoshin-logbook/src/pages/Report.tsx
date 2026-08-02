import { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { BottomNav } from "@/components/BottomNav";
import { ArrowLeft, Printer, FileText } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead,
  TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

interface ReportRow {
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

/** 直近12ヶ月の選択肢を生成 */
function generateMonthOptions(): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    // YYYY-MM-01 形式（JSTベース）
    const value = `${y}-${String(m).padStart(2, "0")}-01`;
    const label = `${y}年${m}月`;
    options.push({ value, label });
  }
  return options;
}

function getCurrentMonthValue(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

export default function Report() {
  const navigate = useNavigate();
  const { orgId } = useOrganization();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [orgName, setOrgName] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState(getCurrentMonthValue());

  const monthOptions = useMemo(() => generateMonthOptions(), []);

  // 帳票全体での内訳。0円や少ない金額が「待機が無かった」と読まれないよう、
  // 算定できなかった訪問と時刻未検証の訪問を注記で明示するために集計する。
  const totalUnmeasured = rows.reduce((s, r) => s + (r.unmeasured_visits ?? 0), 0);
  const totalApprovedClaims = rows.reduce((s, r) => s + (r.approved_claim_visits ?? 0), 0);

  useEffect(() => {
    if (!orgId) return;
    supabase
      .from("organizations")
      .select("name")
      .eq("id", orgId)
      .maybeSingle()
      .then(({ data }) => setOrgName(data?.name ?? null));
  }, [orgId]);

  useEffect(() => {
    setLoading(true);
    supabase
      .from("monthly_wait_risk_reports")
      .select("*")
      .eq("report_month", selectedMonth)
      .then(({ data }) => {
        const fetched = (data as ReportRow[]) || [];
        setRows(fetched);
        setLoading(false);

        // 検算ログ
        console.log(`[検算] 荷主別リスク診断レポート (${selectedMonth}):`);
        fetched.forEach((r) => {
          console.log(
            `  荷主: ${r.client_organization_name ?? "不明"} | 拠点: ${r.location_name ?? "-"} | 月: ${r.report_month} | 件数: ${r.total_visits} | 待機: ${r.total_wait_minutes}分 | 損失: ¥${r.estimated_loss_jpy}`
          );
        });
        console.log(`[検算] 合計行数: ${fetched.length}`);
      });
  }, [selectedMonth]);

  const today = new Date();
  const issueDate = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;

  // 選択月の表示用ラベル
  const selectedMonthLabel = monthOptions.find((o) => o.value === selectedMonth)?.label ?? selectedMonth;

  return (
    <div className="min-h-screen bg-background print:bg-white print:text-black">
      {/* App Header — hidden on print */}
      <header className="bg-primary px-4 py-4 shadow-lg print:hidden">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate("/")}
              className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-foreground/10 hover:bg-primary-foreground/20"
            >
              <ArrowLeft className="h-5 w-5 text-primary-foreground" />
            </button>
            <div className="flex items-center gap-2">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent">
                <img src="/icon-192.png" alt="守護神" className="h-5 w-5 rounded-md" />
              </div>
              <h1 className="text-lg font-bold text-primary-foreground">守護神</h1>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl p-4 pb-28 print:max-w-none print:p-0 print:pb-0">
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

        {/* Month Selector + Print Button */}
        <div className="mb-6 flex flex-col items-center gap-3 print:hidden">
          <div className="flex items-center gap-3">
            <label className="text-sm font-semibold text-foreground">対象月:</label>
            <Select value={selectedMonth} onValueChange={setSelectedMonth}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {monthOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <button
            onClick={() => window.print()}
            className="flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-base font-bold text-primary-foreground shadow-md hover:opacity-90 active:scale-[0.98]"
          >
            <Printer className="h-5 w-5" />
            レポートを印刷 / PDF保存
          </button>
        </div>

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
          <div className="rounded-xl border border-border bg-card shadow-sm print:border-black print:bg-white print:shadow-none">
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
                        (row.approved_claim_visits ?? 0) > 0) && (
                        <div className="text-xs text-muted-foreground print:text-gray-600">
                          {(row.unmeasured_visits ?? 0) > 0 && (
                            <div>うち算定不可 {row.unmeasured_visits}</div>
                          )}
                          {(row.approved_claim_visits ?? 0) > 0 && (
                            <div>うち圏外承認 {row.approved_claim_visits}</div>
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
            本資料は、2026年施行の「中小受託取引適正化法」および国土交通省の監視基準に基づき生成されています。
            {totalApprovedClaims > 0
              ? "記録された待機時間は、GPSおよび端末ログにより担保されたもの（サーバー時刻で検証済み）と、通信圏外のため運行管理者が承認したもの（時刻の自動検証なし）で構成されています。後者は上記の「圏外承認」件数をご確認ください。"
              : "記録された待機時間はGPSおよび端末ログにより担保されており、法的な支払督促の根拠資料として有効です。"}
          </p>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground print:text-gray-600">
            取適法により、役務提供完了日から60日を超える支払遅延には年率14.6%の遅延利息が課されます。本レポートの数値はシステムが自動計算した参考値であり、法的助言を構成するものではありません。
          </p>
          <p className="mt-2 text-xs text-muted-foreground print:text-gray-500">
            Generated by 守護神 — {issueDate}
          </p>
        </footer>
      </main>

      {/* Bottom Nav — hidden on print */}
      <div className="print:hidden">
        <BottomNav />
      </div>
    </div>
  );
}
