import { jstDateString, jstDayRange } from "@/lib/jstDate";
import { useEffect, useState, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Printer, AlertTriangle, ArrowLeft, Link2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import type { Json } from "@/integrations/supabase/types";
import { convertWaitLogsToTimeline, generateFormalReportFromWaitLogs } from "@/lib/waitLogToTimeline";
import { sumWaitCost } from "@/lib/waitCostCalc";
import { ReportDocument, type ReportData, type TimelineEntry } from "@/components/report/ReportDocument";

/* ------------------------------------------------------------------ */
/*  In-App Browser Detection                                          */
/* ------------------------------------------------------------------ */
function isInAppBrowser(): boolean {
  const ua = navigator.userAgent;
  return /Line\/|FBAN|FBAV|Instagram|Twitter|MicroMessenger/i.test(ua);
}

function parseTimeline(json: Json): TimelineEntry[] {
  if (!Array.isArray(json)) return [];
  return json as unknown as TimelineEntry[];
}

/* ================================================================== */
/*  SharedReportView Component                                        */
/* ================================================================== */
export default function SharedReportView() {
  const { id, token } = useParams<{ id: string; token: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [report, setReport] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [parties, setParties] = useState<{ carrier: string | null; shippers: string[] }>({
    carrier: null,
    shippers: [],
  });
  const inApp = useMemo(() => isInAppBrowser(), []);

  /* ---------- Data fetch with wait_logs fallback ---------- */
  useEffect(() => {
    async function load() {
      setLoading(true);

      // Case 0: 共有リンク（荷主・ログイン不要）。専用 RPC だけが入口。
      if (token) {
        const { data, error } = await supabase.rpc("get_shared_report", { p_token: token });
        const r = data as unknown as (Omit<ReportData, "organization_id" | "user_id" | "timeline_snapshot"> & {
          timeline_snapshot: Json;
          carrier_name: string | null;
          shipper_names: string[];
        }) | null;
        if (!error && r) {
          setReport({
            id: r.id,
            report_date: r.report_date,
            vehicle_class: r.vehicle_class,
            total_wait_minutes: r.total_wait_minutes,
            estimated_wait_cost: r.estimated_wait_cost,
            formal_report: r.formal_report ?? null,
            has_discrepancy: r.has_discrepancy,
            timeline_snapshot: parseTimeline(r.timeline_snapshot),
            submitted_at: r.submitted_at,
            organization_id: null,
            user_id: null,
          });
          setParties({ carrier: r.carrier_name ?? null, shippers: r.shipper_names ?? [] });
        } else {
          setReport(null);
        }
        setLoading(false);
        return;
      }

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
            user_id: data.user_id,
          });
          setLoading(false);
          setLoading(false);
          return;
        }
      }

      // Case 2: No ID or not found → fetch today's wait_logs for logged-in user
      if (user) {
        const todayStr = jstDateString();
        const { start: todayStart, end: todayEnd } = jstDayRange(todayStr);

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
            user_id: user.id,
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
  }, [id, token, user]);

  /* ---------- 提出元（運送会社）と提出先（荷主）を実データから引く ---------- */
  useEffect(() => {
    if (!report || token) return;
    let cancelled = false;
    (async () => {
      let orgId = report.organization_id;
      if (!orgId && user) {
        const { data } = await supabase
          .from("profiles")
          .select("organization_id")
          .eq("user_id", user.id)
          .maybeSingle();
        orgId = data?.organization_id ?? null;
      }
      // 荷主名は、提出者がその日に打刻した記録の施設IDから引く。
      // タイムラインの施設「名」で照合すると、同名の施設があるとき関係のない荷主名が載る。
      const { start, end } = jstDayRange(report.report_date);
      const [orgRes, logRes] = await Promise.all([
        orgId
          ? supabase.from("organizations").select("name").eq("id", orgId).maybeSingle()
          : Promise.resolve({ data: null }),
        report.user_id
          ? supabase
              .from("wait_logs")
              .select("facility_id")
              .eq("user_id", report.user_id)
              .gte("arrival_time", start)
              .lte("arrival_time", end)
          : Promise.resolve({ data: [] as { facility_id: string }[] }),
      ]);
      const facilityIds = Array.from(new Set((logRes.data ?? []).map((l) => l.facility_id)));
      const facRes = facilityIds.length
        ? await supabase.from("facilities").select("client_name").in("id", facilityIds)
        : { data: [] as { client_name: string | null }[] };
      const shippers = Array.from(
        new Set((facRes.data ?? []).map((f) => f.client_name).filter((n): n is string => !!n)),
      );
      if (!cancelled) setParties({ carrier: orgRes.data?.name ?? null, shippers });
    })();
    return () => {
      cancelled = true;
    };
  }, [report, user, token]);

  /* ---------- 共有リンクの発行 ---------- */
  const handleShare = async () => {
    if (!id) return;
    const { data, error } = await supabase.rpc("create_report_share_link", { p_report_id: id, p_days: 30 });
    if (error || !data) {
      toast({ title: "リンクを作れませんでした", description: "日報の持ち主のみ共有できます。", variant: "destructive" });
      return;
    }
    const url = `${window.location.origin}/shared/${data}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: "待機時間報告書", url });
      } else {
        await navigator.clipboard.writeText(url);
        toast({ title: "リンクをコピーしました", description: "30日間、ログインなしで閲覧できます。" });
      }
    } catch {
      /* 共有シートのキャンセルは無視 */
    }
  };

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
          <p className="text-muted-foreground text-base">
            {token
              ? "このリンクは無効か、有効期限が切れています。送付元の運送会社にご確認ください。"
              : "本日の乗務記録はまだありません。"}
          </p>
          <a href="/" className="inline-block mt-4 px-6 py-3 bg-primary text-primary-foreground rounded-lg font-bold">
            トップページへ戻る
          </a>
        </div>
      </div>
    );
  }

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
      {!token && (
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
      )}

      {/* ---- Print button ---- */}
      <div className="mx-auto max-w-4xl px-4 pt-6 print:hidden">
        <Button
          size="lg"
          className="w-full text-lg gap-3 h-14"
          onClick={() => window.print()}
        >
          <Printer className="h-6 w-6" />
          この報告書を印刷・PDF保存する
        </Button>
      </div>

      {/* ---- 荷主への共有リンク（提出済みの日報の持ち主のみ） ---- */}
      {!token && id && !id.startsWith("live-") && user && (
        <div className="mx-auto max-w-4xl px-4 pt-3 print:hidden">
          <Button variant="outline" size="lg" className="w-full gap-3 h-12" onClick={handleShare}>
            <Link2 className="h-5 w-5" />
            荷主に送る閲覧リンクを作る（30日間有効）
          </Button>
        </div>
      )}

      <ReportDocument report={report} parties={parties} />
    </div>
  );
}
