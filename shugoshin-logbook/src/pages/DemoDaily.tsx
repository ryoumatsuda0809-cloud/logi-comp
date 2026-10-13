import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Lock, Minus, Plus, RotateCcw, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { convertWaitLogsToTimeline, generateFormalReportFromWaitLogs } from "@/lib/waitLogToTimeline";
import { sumWaitCost } from "@/lib/waitCostCalc";
import { DEMO_FACILITY_NAMES, DEMO_VEHICLE_CLASS, DEMO_WAIT_LOGS } from "@/demo/demoData";

/** 実際の日報画面（DailyReportConfirm）と同じ長押しの長さ */
const HOLD_DURATION_MS = 1000;
/** デモの提出日時は固定（日本時間）。実際はサーバー時刻が付く */
const DEMO_SUBMITTED_AT = "2026/10/3 18:30";

/**
 * /demo の「日報を提出する」。
 * 実際の日報画面と同じ流れ（今日の合計 → 法定乗務記録 → 文面の修正 → 長押しで提出）を、
 * 架空の打刻記録で再現する。DB・AI には一切アクセスしない。
 * 提出後は「提出済み・変更不可」になり、荷主向けの報告書（/demo/report）につながる。
 */
export default function DemoDaily() {
  const summary = useMemo(
    () => convertWaitLogsToTimeline(DEMO_WAIT_LOGS, DEMO_FACILITY_NAMES),
    [],
  );
  const totalWait = summary.totalWaitMinutes;
  const totalCost = useMemo(
    () => sumWaitCost(summary.waitMinutesPerEvent, DEMO_VEHICLE_CLASS),
    [summary],
  );
  const formalText = useMemo(
    () => generateFormalReportFromWaitLogs(DEMO_WAIT_LOGS, DEMO_FACILITY_NAMES),
    [],
  );

  const [editWait, setEditWait] = useState(totalWait);
  const [submitted, setSubmitted] = useState(false);
  const [holdPct, setHoldPct] = useState(0);
  const holdStart = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const timer = useRef<number | null>(null);

  const cancelHold = useCallback(() => {
    holdStart.current = null;
    if (frame.current) cancelAnimationFrame(frame.current);
    if (timer.current) window.clearTimeout(timer.current);
    frame.current = null;
    timer.current = null;
    setHoldPct(0);
  }, []);

  useEffect(() => cancelHold, [cancelHold]);

  const tick = useCallback(() => {
    if (holdStart.current === null) return;
    const pct = Math.min(((Date.now() - holdStart.current) / HOLD_DURATION_MS) * 100, 100);
    setHoldPct(pct);
    if (pct < 100) frame.current = requestAnimationFrame(tick);
  }, []);

  const startHold = useCallback(() => {
    if (submitted || holdStart.current !== null) return;
    holdStart.current = Date.now();
    frame.current = requestAnimationFrame(tick);
    timer.current = window.setTimeout(() => {
      cancelHold();
      setSubmitted(true);
    }, HOLD_DURATION_MS);
  }, [submitted, tick, cancelHold]);

  const reset = () => {
    cancelHold();
    setEditWait(totalWait);
    setSubmitted(false);
  };

  const waitEdited = editWait !== totalWait;
  const diff = editWait - totalWait;

  return (
    <div className="min-h-screen bg-background pb-16">
      <header className="border-b bg-primary px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-primary-foreground">日報</h1>
            <p className="text-xs text-primary-foreground/70">守護神 デモ</p>
          </div>
        </div>
      </header>
      <div className="border-b bg-muted px-4 py-2 text-center text-xs text-muted-foreground">
        表示しているのは架空のデータです。実在の施設・人物・取引とは関係ありません。
      </div>

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-4">
        <Button asChild variant="ghost" size="sm" className="gap-2 text-muted-foreground">
          <Link to="/demo">
            <ArrowLeft className="h-4 w-4" />
            デモに戻る
          </Link>
        </Button>

        {/* 今日の合計 */}
        <Card className="border-success/40 bg-success/10">
          <CardContent className="py-6 text-center">
            <h2 className="text-xl font-bold text-foreground">今日もお疲れ様でした！</h2>
            <p className="mt-1 text-base text-muted-foreground">
              法定乗務記録です。内容を確認して提出してください。
            </p>
            <div className="mt-3 text-sm font-semibold text-destructive tabular-nums">
              合計待機：{totalWait}分 ／ 推定待機料：¥{totalCost.toLocaleString()}
            </div>
          </CardContent>
        </Card>

        {/* 法定乗務記録 + 文面の修正 */}
        <Card>
          <CardContent className="space-y-3 py-4">
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold text-foreground">法定乗務記録</span>
              {waitEdited && (
                <Badge variant="outline" className="border-primary/40 text-xs text-primary">
                  修正済み
                </Badge>
              )}
              {submitted && (
                <Badge variant="secondary" className="gap-1 text-xs">
                  <Lock className="h-3 w-3" />
                  変更不可
                </Badge>
              )}
            </div>

            <div className="rounded-lg bg-muted p-3">
              <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground">
                {formalText}
              </pre>
            </div>

            <div className="rounded-lg border p-3">
              <p className="text-base font-bold text-foreground">荷待ち時間（報告書の記載）</p>
              <p className="mt-1 text-sm text-muted-foreground">
                ここで変えられるのは報告書の文面だけです。GPS で記録した待機時間（{totalWait}分）は変わりません。
              </p>
              <div className="mt-3 flex items-center justify-center gap-2">
                <Button
                  variant="outline"
                  className="h-12 px-3"
                  disabled={submitted || editWait <= 0}
                  onClick={() => setEditWait((v) => Math.max(0, v - 15))}
                  aria-label="15分減らす"
                >
                  <Minus className="mr-1 h-4 w-4" />
                  15分
                </Button>
                <span className="min-w-[4.5rem] whitespace-nowrap text-center text-3xl font-bold tabular-nums text-foreground">
                  {editWait}
                  <span className="text-lg">分</span>
                </span>
                <Button
                  variant="outline"
                  className="h-12 px-3"
                  disabled={submitted}
                  onClick={() => setEditWait((v) => v + 15)}
                  aria-label="15分増やす"
                >
                  <Plus className="mr-1 h-4 w-4" />
                  15分
                </Button>
              </div>
              {waitEdited && (
                <p className="mt-3 rounded-md bg-muted/60 p-2 text-sm text-foreground">
                  GPS の記録 {totalWait}分（変更不可）／ 報告書の記載 {editWait}分（{diff > 0 ? "+" : ""}
                  {diff}分 修正）。提出する記録には両方が残り、修正したことも記録されます。
                </p>
              )}
              {submitted && (
                <p className="mt-3 text-sm text-muted-foreground">
                  提出済みのため、文面は変更できません。
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* 提出 */}
        {!submitted ? (
          <Card>
            <CardContent className="space-y-3 py-4">
              <button
                type="button"
                onPointerDown={startHold}
                onPointerUp={cancelHold}
                onPointerLeave={cancelHold}
                onPointerCancel={cancelHold}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
                    e.preventDefault();
                    startHold();
                  }
                }}
                onKeyUp={(e) => {
                  if (e.key === "Enter" || e.key === " ") cancelHold();
                }}
                onContextMenu={(e) => e.preventDefault()}
                className="relative h-16 w-full select-none overflow-hidden rounded-xl bg-primary text-xl font-bold text-primary-foreground shadow-md"
                style={{ touchAction: "none" }}
              >
                <span
                  aria-hidden
                  className="absolute inset-y-0 left-0 bg-accent/60"
                  style={{ width: `${holdPct}%` }}
                />
                <span className="relative">
                  {holdPct > 0 ? "そのまま押し続けてください…" : "長押しで提出する"}
                </span>
              </button>
              <p className="text-center text-xs text-muted-foreground">
                誤って提出しないよう、約1秒の長押しで提出します（キーボードは Enter / Space を押し続けます）。
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-success/40 bg-success/10">
            <CardContent className="space-y-3 py-5 text-center">
              <div className="flex items-center justify-center gap-2 text-lg font-bold text-foreground">
                <ShieldCheck className="h-5 w-5" />
                提出済み・変更不可
              </div>
              <p className="text-sm tabular-nums text-muted-foreground">
                提出日時 {DEMO_SUBMITTED_AT}（サーバー時刻）
              </p>
              <p className="text-sm text-muted-foreground">
                提出した日報は、本人も管理者も書き換えられません（データベースのトリガーで更新・削除を禁止）。
              </p>
              <div className="flex flex-col items-center gap-2 pt-1 sm:flex-row sm:justify-center">
                <Button asChild>
                  <Link to="/demo/report">荷主に渡す報告書を見る</Link>
                </Button>
                <Button variant="ghost" size="sm" onClick={reset} className="gap-1 text-muted-foreground">
                  <RotateCcw className="h-4 w-4" />
                  最初からやり直す
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
