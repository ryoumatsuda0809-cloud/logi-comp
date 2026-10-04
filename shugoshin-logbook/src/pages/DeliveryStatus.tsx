import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, MapPin, Check, Truck, Package, Clock, User, AlertCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { BottomNav } from "@/components/BottomNav";
import { useOrganization } from "@/hooks/useOrganization";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import type { Database } from "@/integrations/supabase/types";
import { displayText } from "@/lib/orderContent";

type ComplianceEvent = Database["public"]["Enums"]["compliance_event"];

// ── Step definitions ─────────────────────────────────────────
const STEP_LABELS = ["向かっています", "現場待機中", "荷役作業中", "配達完了"] as const;

interface StepData {
  label: string;
  time: string | null;
}

function resolveStep(
  logs: { event_type: ComplianceEvent; recorded_at: string }[] | null,
  orderStatus: string
): number {
  if (orderStatus === "delivered") return 3;
  if (!logs || logs.length === 0) return 0;
  const lastEvent = logs[logs.length - 1].event_type;
  switch (lastEvent) {
    case "departure": return 3;
    case "loading_start": return 2;
    case "waiting_start":
    case "arrival": return 1;
    default: return 0;
  }
}

function buildSteps(
  logs: { event_type: ComplianceEvent; recorded_at: string }[] | null
): StepData[] {
  const eventToStep: Record<string, number> = {
    arrival: 1,
    waiting_start: 1,
    loading_start: 2,
    departure: 3,
  };

  const times: (string | null)[] = [null, null, null, null];

  if (logs) {
    for (const log of logs) {
      const stepIdx = eventToStep[log.event_type];
      if (stepIdx !== undefined && !times[stepIdx]) {
        const d = new Date(log.recorded_at);
        times[stepIdx] = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      }
    }
  }

  return STEP_LABELS.map((label, i) => ({ label, time: times[i] }));
}

// ── Sub-components ───────────────────────────────────────────

function VerticalStepper({ currentStep, steps }: { currentStep: number; steps: StepData[] }) {
  return (
    <div className="space-y-0">
      {steps.map((step, i) => {
        const isCompleted = i < currentStep;
        const isCurrent = i === currentStep;
        const isLast = i === steps.length - 1;

        return (
          <div key={step.label} className="flex gap-4">
            <div className="flex flex-col items-center">
              <div
                className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 transition-all ${
                  isCompleted
                    ? "border-primary bg-primary text-primary-foreground"
                    : isCurrent
                    ? "border-accent bg-accent text-accent-foreground"
                    : "border-muted bg-muted text-muted-foreground"
                }`}
              >
                {isCompleted ? (
                  <Check className="h-5 w-5" />
                ) : isCurrent ? (
                  <>
                    <div className="absolute inset-0 animate-pulse rounded-full bg-accent/30" />
                    <Truck className="relative h-5 w-5" />
                  </>
                ) : (
                  <Clock className="h-5 w-5" />
                )}
              </div>
              {!isLast && (
                <div
                  className={`w-0.5 flex-1 min-h-[32px] ${
                    isCompleted ? "bg-primary" : "border-l-2 border-dashed border-muted-foreground/30"
                  }`}
                />
              )}
            </div>
            <div className="flex flex-1 items-start justify-between pb-8">
              <div>
                <p
                  className={`text-base ${
                    isCurrent
                      ? "font-extrabold text-foreground"
                      : isCompleted
                      ? "font-semibold text-foreground"
                      : "font-medium text-muted-foreground"
                  }`}
                >
                  {step.label}
                </p>
                {isCurrent && (
                  <span className="mt-0.5 inline-block text-xs font-semibold text-accent">
                    現在のステータス
                  </span>
                )}
              </div>
              <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                {step.time ?? "--:--"}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StepperSkeleton() {
  return (
    <div className="space-y-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex gap-4 items-center">
          <Skeleton className="h-10 w-10 rounded-full shrink-0" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-12" />
          </div>
        </div>
      ))}
    </div>
  );
}

function CardSkeleton() {
  return (
    <Card className="rounded-2xl shadow-sm">
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center gap-4">
          <Skeleton className="h-14 w-14 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
        <Skeleton className="h-px w-full" />
        <div className="space-y-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-44" />
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main Page ────────────────────────────────────────────────

export default function DeliveryStatus() {
  const navigate = useNavigate();
  const { orgId, loading: orgLoading } = useOrganization();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [order, setOrder] = useState<any>(null);
  const [logs, setLogs] = useState<{ event_type: ComplianceEvent; recorded_at: string }[] | null>(null);
  const [driverName, setDriverName] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (orgLoading || !orgId) return;

    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(false);

      try {
        // Query A: latest approved/delivered order with embedded compliance_logs
        const { data: orderData, error: orderErr } = await supabase
          .from("transport_orders")
          .select("*, compliance_logs(event_type, recorded_at, driver_id)")
          .eq("organization_id", orgId)
          .in("status", ["approved", "delivered"])
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (cancelled) return;

        if (orderErr) {
          console.error("Order fetch error:", orderErr);
          setError(true);
          toast({ title: "データ取得エラー", description: "配送情報の取得に失敗しました", variant: "destructive" });
          setLoading(false);
          return;
        }

        if (!orderData) {
          setOrder(null);
          setLoading(false);
          return;
        }

        setOrder(orderData);

        // Sort logs by recorded_at ascending
        const sortedLogs = (orderData.compliance_logs ?? [])
          .sort((a: any, b: any) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime());
        setLogs(sortedLogs);

        // Query B: driver profile (parallel-safe, runs after we know driver ID)
        const driverId = sortedLogs[0]?.driver_id ?? orderData.created_by;
        if (driverId) {
          const { data: profile } = await supabase
            .from("profiles")
            .select("display_name")
            .eq("user_id", driverId)
            .maybeSingle();
          if (!cancelled) {
            setDriverName(profile?.display_name ?? null);
          }
        }
      } catch (e) {
        if (!cancelled) {
          console.error("Unexpected fetch error:", e);
          setError(true);
          toast({ title: "データ取得エラー", description: "予期しないエラーが発生しました", variant: "destructive" });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [orgId, orgLoading, toast]);

  const contentJson = order?.content_json as Record<string, any> | undefined;
  const itemName = displayText(contentJson?.item_name ?? contentJson?.itemName);
  const origin = displayText(contentJson?.origin);
  const destination = displayText(contentJson?.destination);
  const shipperName = displayText(contentJson?.shipper_name ?? contentJson?.shipperName);

  const currentStep = order ? resolveStep(logs, order.status) : 0;
  const steps = buildSteps(logs);
  const displayName = driverName ?? "ドライバー";

  const isDataReady = !loading && !orgLoading;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="bg-primary px-4 py-4 shadow-lg">
        <div className="mx-auto flex max-w-4xl items-center">
          <button
            onClick={() => navigate(-1)}
            className="mr-3 flex h-10 w-10 items-center justify-center rounded-xl text-primary-foreground hover:bg-primary-foreground/10"
            aria-label="戻る"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent">
              <img src="/icon-192.png" alt="守護神" className="h-4 w-4 rounded" />
            </div>
            <h1 className="text-lg font-bold text-primary-foreground">配送ステータス</h1>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-6 p-4 pb-28">
        {/* Stepper */}
        <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          {!isDataReady ? (
            <StepperSkeleton />
          ) : order ? (
            <VerticalStepper currentStep={currentStep} steps={steps} />
          ) : null}
        </section>

        {/* Empty / Error states */}
        {isDataReady && !order && !error && (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-border bg-card p-8 text-center">
            <Truck className="h-12 w-12 text-muted-foreground mb-3" />
            <p className="text-lg font-bold text-foreground">現在追跡中の配送はありません</p>
            <p className="text-sm text-muted-foreground mt-1">承認済みの配送が作成されると、ここに表示されます。</p>
            <button
              onClick={() => navigate("/")}
              className="mt-4 rounded-lg bg-primary px-6 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
            >
              ダッシュボードへ戻る
            </button>
          </div>
        )}

        {isDataReady && error && (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-destructive/30 bg-destructive/5 p-8 text-center">
            <AlertCircle className="h-12 w-12 text-destructive mb-3" />
            <p className="text-lg font-bold text-foreground">データの取得に失敗しました</p>
            <p className="text-sm text-muted-foreground mt-1">ネットワーク接続を確認して、再度お試しください。</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 rounded-lg bg-primary px-6 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
            >
              再読み込み
            </button>
          </div>
        )}

        {/* Delivery Info Card */}
        {!isDataReady ? (
          <CardSkeleton />
        ) : order ? (
          <Card className="rounded-2xl shadow-sm">
            <CardContent className="p-5">
              <div className="flex items-center gap-4">
                <Avatar className="h-14 w-14 border-2 border-primary/20">
                  <AvatarFallback className="bg-primary/10 text-lg font-bold text-primary">
                    {displayName.charAt(0)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="text-lg font-bold text-card-foreground">{displayName}</p>
                  <p className="text-sm text-muted-foreground">
                    <User className="mr-1 inline h-3.5 w-3.5" />
                    ドライバー
                  </p>
                </div>
                <Badge className="shrink-0">{steps[currentStep].label}</Badge>
              </div>

              <Separator className="my-4" />

              <div className="space-y-2 text-sm">
                <div className="flex items-start gap-2">
                  <Package className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div>
                    <span className="text-muted-foreground">品目: </span>
                    <span className="font-semibold text-card-foreground">{itemName}</span>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <Truck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div>
                    <span className="text-muted-foreground">荷主: </span>
                    <span className="font-semibold text-card-foreground">{shipperName}</span>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div>
                    <span className="font-semibold text-card-foreground">
                      {origin} → {destination}
                    </span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </main>

      <BottomNav />
    </div>
  );
}
