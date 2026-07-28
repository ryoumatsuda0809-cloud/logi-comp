import { useState, useEffect } from "react";
import { MapPin, Loader2, CheckCircle2, Radar, RotateCcw, LogOut, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { useEvidence } from "@/hooks/useEvidence";
import { useToast } from "@/hooks/use-toast";
import { FisheryForm } from "@/components/evidence/FisheryForm";
import type { FisheryData } from "@/hooks/useEvidence";
import {
  isStaleTicket,
  elapsedMs,
  formatElapsed,
  formatArrivalDateTime,
} from "@/lib/staleTicket";

export function EvidenceCollector() {
  const {
    position,
    gpsError,
    isSubmitting,
    submitError,
    lastResult,
    submitEvidence,
    clearSubmitError,
    completeResult,
    isCompleting,
    completeError,
    completeTicket,
    clearCompleteError,
    resetForNext,
    isCancelling,
    cancelError,
    cancelTicket,
    clearCancelError,
    isRestoringState,
  } = useEvidence();

  const { toast } = useToast();
  const [fisheryData, setFisheryData] = useState<Partial<FisheryData>>({});

  // completeError をトースト通知に変換
  useEffect(() => {
    if (!completeError) return;
    toast({
      variant: "destructive",
      title: "作業完了エラー",
      description: completeError,
    });
    clearCompleteError();
  }, [completeError, toast, clearCompleteError]);

  // cancelError をトースト通知に変換
  useEffect(() => {
    if (!cancelError) return;
    toast({
      variant: "destructive",
      title: "打刻取消エラー",
      description: cancelError,
    });
    clearCancelError();
  }, [cancelError, toast, clearCancelError]);

  const isGpsReady = position !== null && !gpsError;
  // GPS未取得・エラー・送信中はボタンを物理ロック
  const isButtonLocked = !isGpsReady || isSubmitting;

  // 完了打刻の押し忘れ疑い（16時間以上経過した到着打刻）を検知する。
  // 気づかず完了すると待機時間が実経過時間として法的記録に残るため警告する。
  const isStale = lastResult ? isStaleTicket(lastResult.arrivalTime) : false;
  const staleElapsed = lastResult
    ? formatElapsed(elapsedMs(lastResult.arrivalTime))
    : "";

  const isFisheryDataValid =
    Boolean(fisheryData.species?.trim()) &&
    fisheryData.weight_kg != null &&
    fisheryData.weight_kg > 0 &&
    fisheryData.catch_number?.length === 16;

  const handleCompleteTicket = async () => {
    if (!isFisheryDataValid) return;
    await completeTicket(fisheryData as FisheryData);
  };

  // State B → A リセット時に水産物フォームもクリア
  const handleResetForNext = () => {
    resetForNext();
    setFisheryData({});
  };

  // 打刻取消: DBの status を cancelled に確定させてからフォームをクリアする
  const handleCancelTicket = async () => {
    await cancelTicket();
    setFisheryData({});
  };

  // 状態復元中はローディング表示
  if (isRestoringState) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-16">
        <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">打刻状態を確認中...</p>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-5 p-4"
      style={{ WebkitTapHighlightColor: "transparent" }}
    >
      {/* ── GPS ステータスビジュアル ── */}
      <div className="flex flex-col items-center gap-3 py-4">
        <div className="relative flex h-32 w-32 items-center justify-center">
          {/* 取得中 */}
          {position === null && !gpsError && (
            <>
              {[0, 0.3, 0.6].map((delay, i) => (
                <div
                  key={i}
                  className="absolute h-full w-full rounded-full border-2 border-emerald-400 animate-ping"
                  style={{
                    animationDelay: `${delay}s`,
                    animationDuration: "1.5s",
                    opacity: 0.3 - i * 0.1,
                  }}
                />
              ))}
              <Radar className="relative z-10 h-12 w-12 text-emerald-400" />
            </>
          )}
          {/* 取得済み */}
          {position !== null && !gpsError && (
            <>
              <div className="absolute h-full w-full rounded-full border-2 border-emerald-400/20 animate-pulse" />
              <Radar className="relative z-10 h-12 w-12 text-emerald-400 animate-pulse" />
            </>
          )}
          {/* エラー */}
          {gpsError && (
            <>
              <div className="absolute h-full w-full rounded-full border-2 border-destructive/20" />
              <Radar className="relative z-10 h-12 w-12 text-destructive" />
            </>
          )}
        </div>

        {position === null && !gpsError && (
          <p className="text-base font-semibold text-emerald-400">
            📍 現在地を解析中...
          </p>
        )}
        {gpsError && (
          <p className="text-base font-semibold text-destructive">
            ⚠️ GPS取得に失敗しました
          </p>
        )}

        {position && (
          <div className="flex flex-col items-center gap-1">
            <p className="text-sm font-semibold text-emerald-400">
              ✅ 現在地取得済み
            </p>
            <div className="rounded-md bg-muted px-4 py-2 text-center font-mono">
              <p className="text-xs text-muted-foreground">緯度 / 経度</p>
              <p className="text-base font-bold text-foreground tabular-nums">
                {position.lat.toFixed(6)}
              </p>
              <p className="text-base font-bold text-foreground tabular-nums">
                {position.lon.toFixed(6)}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ── GPS エラー Alert ── */}
      {gpsError && (
        <Alert variant="destructive">
          <AlertTitle>GPS エラー</AlertTitle>
          <AlertDescription>{gpsError}</AlertDescription>
        </Alert>
      )}

      {/* ── 送信エラー Alert ── */}
      {submitError && (
        <Alert variant="destructive">
          <AlertTitle>打刻エラー</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <span>{submitError}</span>
            <button
              onClick={clearSubmitError}
              className="self-start text-xs underline underline-offset-2 text-destructive-foreground/70 hover:text-destructive-foreground transition-colors"
            >
              エラーを閉じて再試行
            </button>
          </AlertDescription>
        </Alert>
      )}

      {/* ════════════════════════════════════════════
          State A: 未到着 — 到着打刻ボタン
          ════════════════════════════════════════════ */}
      {!lastResult && (
        <Button
          onClick={submitEvidence}
          disabled={isButtonLocked}
          size="lg"
          className="w-full font-bold select-none"
          style={{ minHeight: "30vh", fontSize: "1.75rem", lineHeight: 1.3 }}
        >
          {isSubmitting ? (
            <span className="flex flex-col items-center gap-3">
              <Loader2 className="h-10 w-10 animate-spin" />
              <span>記録中...</span>
            </span>
          ) : !isGpsReady ? (
            <span className="flex flex-col items-center gap-3 opacity-60">
              <MapPin className="h-10 w-10" />
              <span>GPS取得中</span>
            </span>
          ) : (
            <span className="flex flex-col items-center gap-3">
              <MapPin className="h-10 w-10" />
              <span>到着打刻</span>
            </span>
          )}
        </Button>
      )}

      {/* ════════════════════════════════════════════
          State B: 到着済み・作業中 — 水産物フォーム + 作業完了ボタン
          ════════════════════════════════════════════ */}
      {lastResult && !completeResult && (
        <>
          {/* 到着完了カード */}
          <div className="flex flex-col items-center gap-3 rounded-2xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 p-6 text-center">
            <CheckCircle2 className="h-10 w-10 text-emerald-500" />
            <p className="text-lg font-bold text-foreground">到着打刻済み</p>
            <p className="text-4xl font-mono font-black text-foreground leading-none">
              {lastResult.ticketNumber}
            </p>
            <p className="text-sm font-semibold text-muted-foreground">
              {lastResult.facilityName}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatArrivalDateTime(lastResult.arrivalTime)} 到着記録
            </p>
          </div>

          {/* 押し忘れ疑いの警告（16時間以上経過した打刻） */}
          {isStale && (
            <Alert variant="destructive">
              <AlertTitle>⚠️ 前日以前の打刻が残っています</AlertTitle>
              <AlertDescription className="flex flex-col gap-2">
                <span>
                  この打刻は{formatArrivalDateTime(lastResult.arrivalTime)}の記録で、
                  すでに{staleElapsed}が経過しています。完了打刻を押し忘れた可能性があります。
                </span>
                <span>
                  このまま作業完了すると、待機時間が{staleElapsed}として法的記録に保存され、
                  待機料の請求根拠が不正確になります。記録が誤りの場合は
                  「打刻を取り消す」を押してください。
                </span>
              </AlertDescription>
            </Alert>
          )}

          {/* 水産物情報フォーム */}
          <FisheryForm value={fisheryData} onChange={setFisheryData} />

          {/* 作業完了ボタン */}
          <Button
            onClick={handleCompleteTicket}
            disabled={isButtonLocked || !isFisheryDataValid || isCompleting}
            size="lg"
            className="w-full font-bold select-none bg-amber-600 hover:bg-amber-700 text-white"
            style={{ minHeight: "30vh", fontSize: "1.75rem", lineHeight: 1.3 }}
          >
            {isCompleting ? (
              <span className="flex flex-col items-center gap-3">
                <Loader2 className="h-10 w-10 animate-spin" />
                <span>記録中...</span>
              </span>
            ) : !isGpsReady ? (
              <span className="flex flex-col items-center gap-3 opacity-60">
                <LogOut className="h-10 w-10" />
                <span>GPS取得中</span>
              </span>
            ) : !isFisheryDataValid ? (
              <span className="flex flex-col items-center gap-3 opacity-60">
                <LogOut className="h-10 w-10" />
                <span>水産物情報を入力</span>
              </span>
            ) : (
              <span className="flex flex-col items-center gap-3">
                <LogOut className="h-10 w-10" />
                <span>作業完了（出発）</span>
              </span>
            )}
          </Button>
        </>
      )}

      {/* ════════════════════════════════════════════
          State C: 完了済み — 完了カード + 次の打刻へ
          ════════════════════════════════════════════ */}
      {completeResult && (
        <>
          <div className="flex flex-col items-center gap-3 rounded-2xl bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 p-8 text-center">
            <CheckCircle2 className="h-14 w-14 text-blue-500" />
            <p className="text-2xl font-bold text-foreground">作業完了</p>
            {completeResult.waitingMinutes != null && (
              <div className="flex items-center gap-2 rounded-full bg-blue-100 dark:bg-blue-900/40 px-5 py-2">
                <Clock className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                <p className="text-xl font-mono font-black text-blue-700 dark:text-blue-300 tabular-nums">
                  {completeResult.waitingMinutes} 分
                </p>
                <p className="text-sm text-blue-600 dark:text-blue-400">待機</p>
              </div>
            )}
            <p className="text-sm text-muted-foreground">
              {new Date(completeResult.completedAt).toLocaleTimeString("ja-JP", {
                hour: "2-digit",
                minute: "2-digit",
              })}{" "}
              出発記録
            </p>
          </div>

          <Button
            variant="outline"
            size="lg"
            className="w-full text-lg font-semibold"
            onClick={handleResetForNext}
            style={{ minHeight: "64px" }}
          >
            <RotateCcw className="mr-2 h-5 w-5" />
            次の打刻へ
          </Button>
        </>
      )}

      {/* State B: 到着後の打刻取消（DBの status を cancelled に確定させる） */}
      {lastResult && !completeResult && (
        <Button
          variant={isStale ? "outline" : "ghost"}
          size={isStale ? "lg" : "sm"}
          disabled={isCancelling}
          className={
            isStale
              ? "w-full border-destructive text-destructive hover:bg-destructive/10 font-semibold"
              : "w-full text-muted-foreground"
          }
          onClick={handleCancelTicket}
        >
          {isCancelling ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              取り消し中...
            </span>
          ) : (
            "打刻を取り消す"
          )}
        </Button>
      )}
    </div>
  );
}
