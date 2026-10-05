import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { convertWaitLogsToTimeline } from "@/lib/waitLogToTimeline";
import { sumWaitCost } from "@/lib/waitCostCalc";
import { DEMO_FACILITY_NAMES, DEMO_VEHICLE_CLASS, DEMO_WAIT_LOGS } from "@/demo/demoData";

/** 実際の日報（DailyReportConfirm）と同じ長押しの長さ */
export const HOLD_DURATION_MS = 1000;
/** /demo/report の提出日時と同じ（デモは常に 10/3 の 18:30 に提出する） */
const SUBMITTED_AT_LABEL = "2026年10月3日 18:30";

/**
 * /demo の「日報の提出」。
 * 長押しで提出すると「提出済み・変更不可」になり、修正を試しても拒否される様子を見せる。
 * 状態はこの画面の中だけ。Supabase にも AI にもアクセスしない。
 */
export function DemoSubmitPanel() {
  const [submitted, setSubmitted] = useState(false);
  const [holdProgress, setHoldProgress] = useState(0);
  const [editAttempted, setEditAttempted] = useState(false);
  const holdStartRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);

  const summary = useMemo(() => {
    const { totalWaitMinutes, waitMinutesPerEvent } = convertWaitLogsToTimeline(
      DEMO_WAIT_LOGS,
      DEMO_FACILITY_NAMES,
    );
    return {
      visits: DEMO_WAIT_LOGS.length,
      totalWaitMinutes,
      fee: sumWaitCost(waitMinutesPerEvent, DEMO_VEHICLE_CLASS),
    };
  }, []);

  const cancelHold = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    timerRef.current = null;
    frameRef.current = null;
    setHoldProgress(0);
  }, []);

  useEffect(() => cancelHold, [cancelHold]);

  const tick = useCallback(() => {
    const ratio = Math.min(1, (Date.now() - holdStartRef.current) / HOLD_DURATION_MS);
    setHoldProgress(Math.round(ratio * 100));
    if (ratio < 1) frameRef.current = requestAnimationFrame(tick);
  }, []);

  const startHold = () => {
    if (submitted || timerRef.current !== null) return;
    holdStartRef.current = Date.now();
    frameRef.current = requestAnimationFrame(tick);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      setHoldProgress(0);
      setSubmitted(true);
    }, HOLD_DURATION_MS);
  };

  const reset = () => {
    cancelHold();
    setSubmitted(false);
    setEditAttempted(false);
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">日報の提出</CardTitle>
        <p className="text-xs text-muted-foreground">
          1日の記録をまとめて提出します。提出すると、あとから書き換えられません。
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="grid grid-cols-3 gap-2 text-center text-sm">
          <div className="rounded-lg border p-2">
            <dt className="text-xs text-muted-foreground">訪問</dt>
            <dd className="font-semibold tabular-nums">{summary.visits}件</dd>
          </div>
          <div className="rounded-lg border p-2">
            <dt className="text-xs text-muted-foreground">待機の合計</dt>
            <dd className="font-semibold tabular-nums">{summary.totalWaitMinutes}分</dd>
          </div>
          <div className="rounded-lg border p-2">
            <dt className="text-xs text-muted-foreground">待機料</dt>
            <dd className="whitespace-nowrap font-semibold tabular-nums">{summary.fee.toLocaleString()}円</dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">
          待機時間はGPSの記録です（変更不可）。
        </p>

        {submitted ? (
          <div className="space-y-3">
            <div className="flex flex-col items-center justify-center gap-0.5 rounded-xl border bg-muted/40 py-3">
              <div className="flex items-center gap-2 text-lg font-bold text-muted-foreground">
                <CheckCircle2 className="h-5 w-5" />
                本日は提出済みです
              </div>
              <p className="text-xs text-muted-foreground">送信済みの法定記録のため変更できません</p>
              <p className="text-xs tabular-nums text-muted-foreground">提出 {SUBMITTED_AT_LABEL}</p>
            </div>

            <Button
              variant="outline"
              className="w-full gap-2"
              onClick={() => setEditAttempted(true)}
            >
              <Lock className="h-4 w-4" />
              待機時間を修正してみる
            </Button>
            {editAttempted && (
              <p role="alert" className="rounded-lg border p-3 text-sm">
                提出済みのため変更できません。管理者の権限でも、変更・削除はできません。
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button asChild>
                <Link to="/demo/report">提出した報告書を見る</Link>
              </Button>
              <Button variant="outline" size="sm" onClick={reset}>
                最初の状態に戻す
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <button
              type="button"
              onPointerDown={startHold}
              onPointerUp={cancelHold}
              onPointerCancel={cancelHold}
              onPointerLeave={cancelHold}
              onContextMenu={(e) => e.preventDefault()}
              className="relative h-14 w-full overflow-hidden rounded-xl border-2 border-primary bg-primary text-xl font-bold text-primary-foreground"
              style={
                {
                  userSelect: "none",
                  WebkitTouchCallout: "none",
                  touchAction: "manipulation",
                } as React.CSSProperties
              }
            >
              <div
                className="absolute inset-0 origin-left bg-primary-foreground/20"
                style={{ transform: `scaleX(${holdProgress / 100})` }}
              />
              <span className="relative z-10">
                {holdProgress > 0 ? "長押し中..." : "ヨシ！（長押しで提出）➔"}
              </span>
            </button>
            {holdProgress > 0 && <Progress value={holdProgress} className="mt-2 h-1.5" />}
            <p className="mt-1 text-center text-xs text-muted-foreground">
              ボタンを1秒間、押し続けてください。途中で離すと提出されません。
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
