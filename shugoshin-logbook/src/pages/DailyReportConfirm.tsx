import { toDisplayMessage } from "@/lib/dbErrors";
import { jstDateString, jstDayRange } from "@/lib/jstDate";
import { MapPin, Clock, Package, Home, Mic, AlertTriangle, Satellite, CheckCircle2, Info, Minus, Plus } from "lucide-react";
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
import { BottomNav } from "@/components/BottomNav";
import { useState, useRef, useCallback, useEffect } from "react";
import { convertWaitLogsToTimeline } from "@/lib/waitLogToTimeline";
import type { Json } from "@/integrations/supabase/types";
import { PageHeader } from "@/components/PageHeader";

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
  // ダイアログ内では下書きを編集し、「確定」したときだけ反映する（×や外側タップは取り消し）
  const [draftWaitMinutes, setDraftWaitMinutes] = useState(0);
  const [draftExtraWork, setDraftExtraWork] = useState(false);
  const openEditor = () => {
    setDraftWaitMinutes(editWaitMinutes);
    setDraftExtraWork(hasExtraWork);
    setDialogOpen(true);
  };
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
  const isWaitEdited = editWaitMinutes !== totalWaitMinutes;
  const draftReportText = generateFormalReport(draftWaitMinutes, draftExtraWork, derivedShipper);
  const hasRecords = !loading && timeline.length > 0;

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

    const { data: inserted, error } = await supabase.from("submitted_reports").insert([{
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
    }]).select("id").single();

    setSubmitting(false);

    if (error) {
      if (error.code === "23505") {
        toast({ title: "⚠️ 既に提出済みです", description: "本日の日報は提出済みです。", variant: "destructive" });
      } else {
        toast({ title: "エラー", description: toDisplayMessage(error), variant: "destructive" });
      }
      return;
    }

    if (navigator.vibrate) {
      navigator.vibrate(200);
    }

    toast({ title: "✅ 日報を提出しました！", description: "荷主に送る場合は、次の画面でリンクを作れます。" });
    navigate(inserted?.id ? `/shared-report/${inserted.id}` : "/");
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
    <div className="min-h-screen bg-background pb-44">
      <PageHeader title="日報" className="print:hidden" />

      {/* ========== 1. Header ========== */}
      {!loading && !hasRecords && (
        <div className="px-4 pt-2 pb-6">
          <Card className="border-dashed">
            <CardContent className="py-10 text-center space-y-3">
              <h1 className="text-xl font-bold text-foreground">本日の記録はまだありません</h1>
              <p className="text-base text-muted-foreground">
                現場に着いたら到着打刻をしてください。打刻の記録から日報が作られます。
              </p>
              <button
                onClick={() => navigate("/check-in")}
                className="inline-flex min-h-[48px] items-center gap-2 rounded-xl bg-primary px-6 text-base font-bold text-primary-foreground hover:bg-primary/90"
              >
                <MapPin className="h-5 w-5" />
                打刻画面へ
              </button>
            </CardContent>
          </Card>
        </div>
      )}
      {hasRecords && (
      <div className="px-4 pt-2 pb-6">
        <Card className="border-success/40 bg-success/10">
          <CardContent className="py-6 text-center">
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
      )}

      {/* ========== 2. Formal Report — Button + Dialog ========== */}
      {hasRecords && (
        <div className="px-4 pb-6">
          <Card className="border-border">
            <CardContent className="py-4 px-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-lg font-bold text-foreground">法定乗務記録</span>
                {isEdited && (
                  <Badge variant="outline" className="text-xs border-primary/40 text-primary">
                    修正済み
                  </Badge>
                )}
              </div>

              {/* E13: 手修正は報告書の文面だけ。提出する待機時間（証拠）は GPS の記録のまま */}
              {isWaitEdited && (
                <div className="mb-3 rounded-lg border border-border bg-muted/50 p-3 text-sm text-foreground">
                  <p className="font-semibold">待機時間を手で修正しています</p>
                  <p className="text-muted-foreground">
                    GPSの記録 {totalWaitMinutes}分（変更不可）／ 報告書の記載 {editWaitMinutes}分。
                    提出する記録には両方が残り、修正したことも記録されます。
                  </p>
                </div>
              )}

              {/* Preview snippet */}
              <div className="bg-muted rounded-lg p-3 mb-3">
                <pre className="whitespace-pre-wrap text-sm font-mono text-foreground leading-relaxed">{formalReportText}</pre>
              </div>

              <button
                onClick={openEditor}
                disabled={alreadySubmitted}
                className="w-full h-16 rounded-xl text-xl font-bold bg-primary text-primary-foreground shadow-md transition-all hover:bg-primary/90 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed select-none"
              >
                報告書を確認・修正する
              </button>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ========== Dialog: Verify & Edit ========== */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-xl">報告書の確認・修正</DialogTitle>
            <DialogDescription>
              ここで変えられるのは報告書の文面です。GPSで記録した待機時間（{totalWaitMinutes}分）は変わりません。
            </DialogDescription>
          </DialogHeader>

          {/* Preview */}
          <div className="bg-muted rounded-lg p-4">
            <pre className="whitespace-pre-wrap text-lg font-mono text-foreground leading-relaxed">{draftReportText}</pre>
          </div>

          {/* Parameter controls */}
          <div className="space-y-6 py-2">
            {/* Wait minutes */}
            <div>
              <label className="text-base font-bold text-foreground mb-1 block">荷待ち時間（報告書の記載）</label>
              <p className="mb-2 text-sm text-muted-foreground">
                GPSの記録：{totalWaitMinutes}分
                {draftWaitMinutes !== totalWaitMinutes && `（${draftWaitMinutes - totalWaitMinutes > 0 ? "+" : ""}${draftWaitMinutes - totalWaitMinutes}分 修正）`}
              </p>
              <div className="flex items-center justify-center gap-6">
                <button
                  onClick={() => setDraftWaitMinutes((v) => Math.max(0, v - 15))}
                  className="h-14 w-20 rounded-xl text-base font-bold border-2 border-border bg-card text-foreground shadow-sm active:scale-95 transition-transform select-none"
                >
                  <Minus className="h-6 w-6 mx-auto" />
                  -15分
                </button>
                <span className="text-4xl font-bold text-foreground min-w-[5rem] text-center tabular-nums">
                  {draftWaitMinutes}<span className="text-lg">分</span>
                </span>
                <button
                  onClick={() => setDraftWaitMinutes((v) => v + 15)}
                  className="h-14 w-20 rounded-xl text-base font-bold border-2 border-border bg-card text-foreground shadow-sm active:scale-95 transition-transform select-none"
                >
                  <Plus className="h-6 w-6 mx-auto" />
                  +15分
                </button>
              </div>
            </div>

            {/* Extra work toggle */}
            <label className="flex min-h-[48px] cursor-pointer items-center justify-between gap-4 rounded-lg border border-border px-4">
              <span className="text-base font-bold text-foreground">附帯作業（無償荷役）</span>
              <span className="flex items-center gap-3">
                <span className="text-base text-muted-foreground">{draftExtraWork ? "あり" : "なし"}</span>
                <Switch checked={draftExtraWork} onCheckedChange={setDraftExtraWork} />
              </span>
            </label>
          </div>

          {/* Submit from dialog */}
          <button
            onClick={() => {
              setEditWaitMinutes(draftWaitMinutes);
              setHasExtraWork(draftExtraWork);
              setDialogOpen(false);
              toast({ title: "報告書を確定しました", description: "下の提出ボタンを長押しすると提出できます。" });
            }}
            className="w-full h-16 rounded-xl text-xl font-bold bg-primary text-primary-foreground shadow-md transition-all hover:bg-primary/90 active:scale-[0.98] select-none"
          >
            この内容で確定する
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
        ) : timeline.length === 0 ? null : (
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
                              {item.waitMinutes > 30 ? "無償待機" : "待機"}：{item.waitMinutes}分
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
      <div className="fixed bottom-[calc(60px+env(safe-area-inset-bottom))] left-0 right-0 z-20 bg-background/95 backdrop-blur border-t border-border px-4 py-2">
        {alreadySubmitted ? (
          <div className="flex flex-col items-center justify-center h-14 gap-0.5">
            <div className="flex items-center gap-2 text-xl text-muted-foreground font-bold">
              <CheckCircle2 className="h-6 w-6" />
              本日は提出済みです
            </div>
            <p className="text-xs text-muted-foreground">送信済みの法定記録のため変更できません</p>
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
              className="relative w-full h-14 rounded-xl text-xl font-bold overflow-hidden border-2 border-primary bg-primary text-primary-foreground disabled:opacity-50 disabled:cursor-not-allowed"
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
            {/* 無効のときは理由を出す（灰色のまま理由が分からない状態を避ける） */}
            {!submitting && isSubmitDisabled && (
              <p className="mt-1 text-center text-xs text-muted-foreground">
                {loading ? "記録を読み込み中です" : "本日の打刻記録がないため、提出できません"}
              </p>
            )}
            {/* Progress indicator below button */}
            {holdProgress > 0 && holdProgress < 100 && (
              <Progress value={holdProgress} className="mt-2 h-1.5" />
            )}
          </div>
        )}
      </div>

      <div className="print:hidden">
        <BottomNav />
      </div>
    </div>
  );
}
