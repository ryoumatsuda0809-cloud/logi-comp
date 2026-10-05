import { useEffect, useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { BottomNav } from "@/components/BottomNav";
import { Printer } from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/PageHeader";
import { RiskReportDocument, type RiskReportRow } from "@/components/report/RiskReportDocument";

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
  const { orgId } = useOrganization();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<RiskReportRow[]>([]);
  const [orgName, setOrgName] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState(getCurrentMonthValue());

  const monthOptions = useMemo(() => generateMonthOptions(), []);

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
        const fetched = (data as RiskReportRow[]) || [];
        setRows(fetched);
        setLoading(false);
      });
  }, [selectedMonth]);

  const today = new Date();
  const issueDate = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;

  // 選択月の表示用ラベル
  const selectedMonthLabel = monthOptions.find((o) => o.value === selectedMonth)?.label ?? selectedMonth;

  return (
    <div className="min-h-screen bg-background print:bg-white print:text-black">
      {/* App Header — hidden on print */}
      <PageHeader title="警告レポート" className="print:hidden" />

      <RiskReportDocument
        rows={rows}
        loading={loading}
        orgName={orgName}
        issueDate={issueDate}
        monthLabel={selectedMonthLabel}
        controls={
          /* Month Selector + Print Button */
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
        }
      />

      {/* Bottom Nav — hidden on print */}
      <div className="print:hidden">
        <BottomNav />
      </div>
    </div>
  );
}
