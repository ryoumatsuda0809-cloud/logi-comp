import { jstDateString, jstDayRange } from "@/lib/jstDate";
import { ArrowLeft, MapPin, Clock, Package, Home, Mic, AlertTriangle, Satellite, CheckCircle2, Info, Minus, Plus } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useNavigate } from "react-router-dom";
import { toast } from "@/hooks/use-toast";
import { useDailyTimeline, type UnifiedTimelineItem } from "@/hooks/useDailyTimeline";
import { useOrganization } from "@/hooks/useOrganization";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useState, useRef, useCallback, useEffect } from "react";
import { convertWaitLogsToTimeline } from "@/lib/waitLogToTimeline";
import type { Json } from "@/integrations/supabase/types";

// ---------- 定型文生成関数 ----------
function generateFormalReport(waitMinutes: number, hasExtraWork: boolean, shipperName: string): string {
  const now = new Date();
  const timeStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return `■ 業務報告\n・報告日時：${timeStr}\n・荷主様　：${shipperName}\n・待機時間：${waitMinutes}分\n・附帯作業：${hasExtraWork ? "あり" : "なし"}\n\n上記の通り、特定受託事業者取引適正化法に基づく業務記録をご報告いたします。よろしくお願い申し上げます。`;
}

const FALLBACK_ORG_ID = "00000000-0000-0000-0000-000000000000";
const HOLD_DURATION_MS = 1000;

// ---------- Icon per event type ----------
function typeIcon(eventType: string) {
  switch (eventType) {
    case "arrival":
      return <MapPin className="h-5 w-5" />;
    case "waiting_start":
      return <Clock className="h-5 w-5" />;
    case "loading_start":
      return <Package className="h-5 w-5" />;
    case "departure":
      return <Home className="h-5 w-5" />;
    case "voice_report":
      return <Mic className="h-5 w-5" />;
    default:
      return <Info className="h-5 w-5" />;
  }
}

// ---------- Dot colour ----------
function dotColor(item: UnifiedTimelineItem) {
  if (item.eventType === "waiting_start") return "bg-destructive";
  if (item.source === "voice") return "bg-accent";
  return "bg-primary";
}

function ringColor(item: UnifiedTimelineItem) {
  if (item.eventType === "waiting_start") return "ring-destructive";
  if (item.source === "voice") return "ring-accent";
  return "ring-primary";
}

function iconColor(item: UnifiedTimelineItem) {
  if (item.eventType === "waiting_start") return "text-destructive";
  if (item.source === "voice") return "text-accent-foreground";
  return "text-primary";
}

function formatTime(iso: string) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ---------- Component ----------
export default function DailyReportConfirm() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { orgId } = useOrganization();
  const { timeline, vehicleClass, totalWaitMinutes, totalWaitCost, hasDiscrepancy, loading, alreadySubmitted, latestFormalReport } = useDailyTimeline();
  const [submitting, setSubmitting] = useState(false);

  // Dialog & editable parameters
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editWaitMinutes, setEditWaitMinutes] = useState(0);
  const [hasExtraWork, setHasExtraWork] = useState(false);
  // Derive shipper name from timeline data (first location found)
  const derivedShipper = timeline.find((t) => t.location)?.location ?? "（荷主未記録）";

  // Sync hook data into editable state
  useEffect(() => {
    setEditWaitMinutes(totalWaitMinutes);
  }, [totalWaitMinutes]);

  // Generate formal report text from parameters
  const formalReportText = generateFormalReport(editWaitMinutes, hasExtraWork, derivedShipper);
  const originalAiOutput = generateFormalReport(totalWaitMinutes, false, derivedShipper);
  const isEdited = editWaitMinutes !== totalWaitMinutes || hasExtraWork;

  // ---------- Press-and-hold logic ----------
  const [holdProgress, setHoldProgress] = useState(0);
  const holdTimerRef = useRef<number | null>(null);
  const holdStartRef = useRef<number>(0);
  const animFrameRef = useRef<number | null>(null);

  const cancelHold = useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    setHoldProgress(0);
  }, []);

  const updateProgress = useCallback(() => {
    const elapsed = Date.now() - holdStartRef.current;
    const pct = Math.min((elapsed / HOLD_DURATION_MS) * 100, 100);
    setHoldProgress(pct);
    if (pct < 100) {
      animFrameRef.current = requestAnimationFrame(updateProgress);
    }
  }, []);

  const handleSubmit = async () => {
    if (!user) {
      toast({ title: "エラー", description: "ログイン情報が取得できません。", variant: "destructive" });
      return;
    }

    setSubmitting(true);

    const resolvedOrgId = orgId || FALLBACK_ORG_ID;

    // Fetch today's wait_logs to include real data in snapshot
    const todayStr = jstDateString();
    const { start: dayStart, end: dayEnd } = jstDayRange(todayStr);
    const [logsRes, facilitiesRes] = await Promise.all([
      supabase
        .from("wait_logs")
        .select("*")
        .eq("user_id", user.id)
        .gte("arrival_time", dayStart)
        .lte("arrival_time", dayEnd)
        .order("arrival_time", { ascending: true }),
      supabase.from("facilities").select("id, name"),
    ]);

    // Build enriched timeline snapshot
    let snapshotData: Json[] = JSON.parse(JSON.stringify(timeline));
    if (logsRes.data && logsRes.data.length > 0) {
      const facilityMap: Record<string, string> = {};
      for (const f of facilitiesRes.data ?? []) {
        facilityMap[f.id] = f.name;
      }
      const { entries } = convertWaitLogsToTimeline(logsRes.data, facilityMap);
      // Merge: existing timeline + wait_logs entries (deduplicated by adding source prefix)
      snapshotData = [...snapshotData, ...entries.map(e => ({ ...e, source: "wait_log" }))];
    }

    const { error } = await supabase.from("submitted_reports").insert([{
      user_id: user.id,
      organization_id: resolvedOrgId,
      report_date: todayStr,
      vehicle_class: vehicleClass,
      total_wait_minutes: totalWaitMinutes,
      estimated_wait_cost: totalWaitCost,
      has_discrepancy: hasDiscrepancy,
      timeline_snapshot: snapshotData,
      original_ai_output: originalAiOutput || null,
      is_edited: isEdited,
      formal_report: formalReportText || null,
    }]);

    setSubmitting(false);

    if (error) {
      if (error.code === "23505") {
        toast({ title: "⚠️ 既に提出済みです", description: "本日の日報は提出済みです。", variant: "destructive" });
      } else {
        toast({ title: "エラー", description: error.message, variant: "destructive" });
      }
      return;
    }

    if (navigator.vibrate) {
      navigator.vibrate(200);
    }

    toast({ title: "✅ 日報を提出しました！", description: "本日もお疲れ様でした。" });
    navigate("/");
  };

  const onPointerDown = useCallback(() => {
    if (submitting || loading || timeline.length === 0 || alreadySubmitted) return;
    if (navigator.vibrate) navigator.vibrate(50);
    holdStartRef.current = Date.now();
    animFrameRef.current = requestAnimationFrame(updateProgress);
    holdTimerRef.current = window.setTimeout(() => {
      setHoldProgress(100);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (navigator.vibrate) navigator.vibrate(200);
      handleSubmit();
    }, HOLD_DURATION_MS);
  }, [submitting, loading, timeline, alreadySubmitted, updateProgress, handleSubmit]);

  const onPointerUpOrLeave = useCallback(() => {
    cancelHold();
  }, [cancelHold]);

  const isSubmitDisabled = submitting || loading || timeline.length === 0;

  return (
    <div className="min-h-screen bg-background pb-32">
      {/* Back button (print:hidden) */}
      <div className="sticky top-0 z-10 bg-background/80 backdrop-blur px-4 py-3 print:hidden">
        <button
          onClick={() => navigate("/")}
          className="inline-flex items-center gap-1 text-muted-foreground text-base min-h-[48px] min-w-[48px] select-none"
        >
          <ArrowLeft className="h-5 w-5" />
          ホームに戻る
        </button>
      </div>

      {/* ========== 1. Header ========== */}
      <div className="px-4 pt-2 pb-6">
        <Card className="border-success/40 bg-success/10">
          <CardContent className="py-6 text-center">
            <p className="text-3xl mb-2">🟢</p>
            <h1 className="text-xl font-bold text-foreground leading-relaxed">
              今日もお疲れ様でした！
            </h1>
            <p className="text-base text-muted-foreground mt-1">
              法定乗務記録です。内容を確認して提出してください。
            </p>
            {totalWaitMinutes > 0 && (
              <div className="mt-3 text-sm text-destructive font-semibold">
                合計待機：{totalWaitMinutes}分 ／ 推定待機料：¥{totalWaitCost.toLocaleString()}
              </div>
            )}
            {hasDiscrepancy && (
              <div className="mt-2 inline-flex items-center gap-1 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4" />
                GPS記録と音声申告に時間差があります（提出は可能です）
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ========== 2. Formal Report — Button + Dialog ========== */}
      {!loading && (
        <div className="px-4 pb-6">
          <Card className="border-border">
            <CardContent className="py-4 px-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-lg font-bold text-foreground">📋 法定乗務記録</span>
                {isEdited && (
                  <Badge variant="outline" className="text-xs border-primary/40 text-primary">
                    修正済み
                  </Badge>
                )}
              </div>

              {/* Preview snippet */}
              <div className="bg-muted rounded-lg p-3 mb-3">
                <pre className="whitespace-pre-wrap text-sm font-mono text-foreground leading-relaxed">{formalReportText}</pre>
              </div>

              <button
                onClick={() => setDialogOpen(true)}
                disabled={alreadySubmitted}
                className="w-full h-16 rounded-xl text-xl font-bold bg-primary text-primary-foreground shadow-md transition-all hover:bg-primary/90 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed select-none"
              >
                📝 報告書を確認・修正する
              </button>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ========== Dialog: Verify & Edit ========== */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-xl">📋 報告書の確認・修正</DialogTitle>
            <DialogDescription>パラメータを修正すると、報告書がリアルタイムで更新されます。</DialogDescription>
          </DialogHeader>

          {/* Preview */}
          <div className="bg-muted rounded-lg p-4">
            <pre className="whitespace-pre-wrap text-lg font-mono text-foreground leading-relaxed">{formalReportText}</pre>
          </div>

          {/* Parameter controls */}
          <div className="space-y-6 py-2">
            {/* Wait minutes */}
            <div>
              <label className="text-base font-bold text-foreground mb-2 block">⏱ 荷待ち時間</label>
              <div className="flex items-center justify-center gap-6">
                <button
                  onClick={() => setEditWaitMinutes((v) => Math.max(0, v - 15))}
                  className="h-14 w-20 rounded-xl text-xl font-bold bg-destructive text-destructive-foreground shadow active:scale-95 transition-transform select-none"
                >
                  <Minus className="h-6 w-6 mx-auto" />
                  -15分
                </button>
                <span className="text-4xl font-bold text-foreground min-w-[5rem] text-center tabular-nums">
                  {editWaitMinutes}<span className="text-lg">分</span>
                </span>
                <button
                  onClick={() => setEditWaitMinutes((v) => v + 15)}
                  className="h-14 w-20 rounded-xl text-xl font-bold bg-primary text-primary-foreground shadow active:scale-95 transition-transform select-none"
                >
                  <Plus className="h-6 w-6 mx-auto" />
                  +15分
                </button>
              </div>
            </div>

            {/* Extra work toggle */}
            <div className="flex flex-col items-start gap-3">
              <label className="text-base font-bold text-foreground">🔧 附帯作業（無償荷役）</label>
              <div className="flex items-center gap-6">
                <span className="text-base text-muted-foreground">{hasExtraWork ? "あり" : "なし"}</span>
                <Switch
                  checked={hasExtraWork}
                  onCheckedChange={setHasExtraWork}
                  className="scale-150 origin-right"
                />
              </div>
            </div>
          </div>

          {/* Submit from dialog */}
          <button
            onClick={() => {
              setDialogOpen(false);
              toast({ title: "✅ 報告書を確定しました", description: "送信ボタンで提出できます。" });
            }}
            className="w-full h-16 rounded-xl text-xl font-bold bg-primary text-primary-foreground shadow-md transition-all hover:bg-primary/90 active:scale-[0.98] select-none"
          >
            🚀 この内容で確定する
          </button>
        </DialogContent>
      </Dialog>

      {/* ========== 3. Timeline ========== */}
      <div className="px-4">
        {loading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex gap-0">
                <div className="w-[4.5rem] shrink-0 pt-3 pr-2">
                  <Skeleton className="h-4 w-12 ml-auto" />
                </div>
                <div className="flex flex-col items-center w-8 shrink-0">
                  <Skeleton className="mt-3.5 h-4 w-4 rounded-full" />
                  <Skeleton className="flex-1 w-0.5 mt-1" />
                </div>
                <div className="flex-1 pb-6 pt-1">
                  <Skeleton className="h-24 rounded-lg" />
                </div>
              </div>
            ))}
          </div>
        ) : timeline.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground text-lg">本日の記録がありません</p>
              <p className="text-muted-foreground text-sm mt-2">
                GPS打刻または音声日報を記録してから確認できます。
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="relative">
            {timeline.map((item, idx) => {
              const isLast = idx === timeline.length - 1;
              const isWaiting = item.eventType === "waiting_start";

              return (
                <div key={item.id} className="flex gap-0">
                  {/* Left — time */}
                  <div className="w-[4.5rem] shrink-0 pt-3 pr-2 text-right">
                    <span className="text-sm font-semibold text-muted-foreground leading-tight">
                      {formatTime(item.timestamp)}
                    </span>
                  </div>

                  {/* Center — dot + line */}
                  <div className="flex flex-col items-center w-8 shrink-0">
                    <div
                      className={`mt-3.5 h-4 w-4 rounded-full border-2 border-background ring-2 ${ringColor(item)} ${dotColor(item)}`}
                    />
                    {!isLast && <div className="flex-1 w-0.5 bg-border" />}
                  </div>

                  {/* Right — card */}
                  <div className="flex-1 pb-6 pt-1">
                    <Card
                      className={
                        isWaiting
                          ? "border-destructive/40 bg-destructive/5"
                          : "border bg-card"
                      }
                    >
                      <CardContent className="py-4 px-4">
                        {/* Label row */}
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className={iconColor(item)}>
                            {typeIcon(item.eventType)}
                          </span>
                          <span className="text-lg font-bold text-foreground">
                            【{item.label}】
                          </span>
                          {item.location && (
                            <span className="text-base text-muted-foreground">
                              {item.location}
                            </span>
                          )}
                          {item.discrepancy && (
                            <Badge variant="outline" className="text-destructive border-destructive/40 text-xs">
                              <AlertTriangle className="h-3 w-3 mr-0.5" />
                              要確認
                            </Badge>
                          )}
                        </div>

                        {/* Source badge + metadata */}
                        <div className="flex items-center gap-2 mt-1">
                          <Badge
                            variant={item.source === "gps" ? "default" : "secondary"}
                            className="text-[10px] px-1.5 py-0"
                          >
                            {item.source === "gps" ? (
                              <><Satellite className="h-3 w-3 mr-0.5" />GPS</>
                            ) : (
                              <><Mic className="h-3 w-3 mr-0.5" />音声</>
                            )}
                          </Badge>
                          {item.isManual && (
                            <span className="text-[10px] text-muted-foreground">手動入力</span>
                          )}
                          {item.accuracy && (
                            <span className="text-[10px] text-muted-foreground truncate max-w-[120px]">
                              {item.accuracy}
                            </span>
                          )}
                        </div>

                        {/* Waiting highlight */}
                        {isWaiting && item.waitMinutes != null && item.waitMinutes > 0 && (
                          <div className="mt-2 space-y-1.5">
                            <Badge variant="destructive" className="text-sm px-3 py-1">
                              <AlertTriangle className="h-4 w-4 mr-1" />
                              {item.waitMinutes > 30 ? "⚠️ 無償待機" : "待機"}：{item.waitMinutes}分
                            </Badge>
                            {item.estimatedCost != null && item.estimatedCost > 0 && (
                              <p className="text-base font-semibold text-destructive">
                                推定待機料：¥{item.estimatedCost.toLocaleString()}
                              </p>
                            )}
                          </div>
                        )}

                        {/* Voice report details */}
                        {item.source === "voice" && (
                          <div className="mt-2 space-y-1">
                            {item.shipperName && (
                              <p className="text-sm text-muted-foreground">
                                荷主：{item.shipperName}
                              </p>
                            )}
                            {item.summary && (
                              <p className="text-sm text-foreground bg-muted/50 rounded p-2">
                                {item.summary}
                              </p>
                            )}
                            {item.waitMinutes != null && item.waitMinutes > 0 && (
                              <div className="mt-1">
                                <Badge variant="destructive" className="text-sm px-3 py-1">
                                  申告待機：{item.waitMinutes}分
                                </Badge>
                                {item.estimatedCost != null && item.estimatedCost > 0 && (
                                  <p className="text-base font-semibold text-destructive mt-1">
                                    推定待機料：¥{item.estimatedCost.toLocaleString()}
                                  </p>
                                )}
                              </div>
                            )}
                            {item.uncompensatedWork && (
                              <Badge variant="destructive" className="text-xs">
                                無償荷役あり
                              </Badge>
                            )}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ========== 4. Fixed footer with press-hold button ========== */}
      <div className="fixed bottom-0 left-0 right-0 z-20 bg-background/95 backdrop-blur border-t border-border px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        {alreadySubmitted ? (
          <div className="flex flex-col items-center justify-center h-24 gap-1">
            <div className="flex items-center gap-2 text-2xl text-muted-foreground font-bold">
              <CheckCircle2 className="h-8 w-8" />
              本日は提出済みです
            </div>
            <p className="text-sm text-muted-foreground">🔒 送信済みの法定記録のため変更できません</p>
          </div>
        ) : (
          <div className="relative">
            <button
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUpOrLeave}
              onPointerCancel={onPointerUpOrLeave}
              onPointerLeave={onPointerUpOrLeave}
              onContextMenu={(e) => e.preventDefault()}
              disabled={isSubmitDisabled}
              className="relative w-full h-20 rounded-xl text-2xl font-bold overflow-hidden border-2 border-primary bg-primary text-primary-foreground disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                userSelect: "none",
                WebkitTouchCallout: "none",
                touchAction: "manipulation",
              } as React.CSSProperties}
            >
              {/* Progress fill */}
              <div
                className="absolute inset-0 bg-primary-foreground/20 origin-left transition-none"
                style={{
                  transform: `scaleX(${holdProgress / 100})`,
                }}
              />
              <span className="relative z-10">
                {submitting ? "提出中..." : holdProgress > 0 ? "長押し中..." : "ヨシ！（長押しで提出）➔"}
              </span>
            </button>
            {/* Progress indicator below button */}
            {holdProgress > 0 && holdProgress < 100 && (
              <Progress value={holdProgress} className="mt-2 h-1.5" />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
