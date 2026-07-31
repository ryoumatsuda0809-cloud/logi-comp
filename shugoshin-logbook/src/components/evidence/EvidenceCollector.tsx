import { useState, useEffect } from "react";
import { MapPin, Loader2, CheckCircle2, Radar, RotateCcw, LogOut, Clock, WifiOff, FileClock, PackageOpen } from "lucide-react";
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
import { isCatchNumberRequired } from "@/lib/fisheryLaw";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { useOfflinePunch } from "@/hooks/useOfflinePunch";

export function EvidenceCollector() {
  const {
    position,
    gpsError,
    isSubmitting,
    submitError,
    lastResult,
    submitEvidence,
    submitFailedOffline,
    clearSubmitError,
    loadingResult,
    isStartingLoading,
    loadingError,
    startLoading,
    clearLoadingError,
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

  // loadingError をトースト通知に変換
  useEffect(() => {
    if (!loadingError) return;
    toast({
      variant: "destructive",
      title: "荷役開始エラー",
      description: loadingError,
    });
    clearLoadingError();
  }, [loadingError, toast, clearLoadingError]);

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

  const isOnline = useOnlineStatus();

  const {
    pendingCount,
    rejected,
    dismissRejected,
    isFlushing,
    lastAccepted,
    clearLastAccepted,
    recordOfflinePunch,
  } = useOfflinePunch();

  // 送信成功をトーストで知らせる
  useEffect(() => {
    if (lastAccepted === 0) return;
    toast({
      title: "仮記録を送信しました",
      description: `${lastAccepted}件を申請として送信しました。管理者の承認後に正式な打刻になります。`,
    });
    clearLastAccepted();
  }, [lastAccepted, toast, clearLastAccepted]);

  const isGpsReady = position !== null && !gpsError;
  // GPS未取得・エラー・送信中・オフラインはボタンを物理ロック。
  // 打刻はサーバー時刻とサーバー側ジオフェンス判定に依存するため、
  // 通信がない状態では法的に有効な記録を作れない（Rule 1 / Rule 2）。
  const isButtonLocked = !isGpsReady || isSubmitting || !isOnline;

  // 完了打刻の押し忘れ疑い（16時間以上経過した到着打刻）を検知する。
  // 気づかず完了すると待機時間が実経過時間として法的記録に残るため警告する。
  const isStale = lastResult ? isStaleTicket(lastResult.arrivalTime) : false;
  const staleElapsed = lastResult
    ? formatElapsed(elapsedMs(lastResult.arrivalTime))
    : "";

  // 漁獲番号は特定第一種水産動植物のときのみ必須。
  // フグ・タイなど対象外の魚種で入力を求めると作業完了できなくなる。
  const catchNumberNeeded = isCatchNumberRequired(
    fisheryData.species_id,
    fisheryData.weight_kg
  );
  const isFisheryDataValid =
    Boolean(fisheryData.species?.trim()) &&
    fisheryData.weight_kg != null &&
    fisheryData.weight_kg > 0 &&
    (!catchNumberNeeded || Boolean(fisheryData.catch_number?.trim()));

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

  // 圏外で通信が通らないが GPS 座標は取れている状態。
  // 圏外＝GPS不可ではない（衛星測位は通信なしでも動く）ため、座標のある記録は残せる。
  // navigator.onLine は圏外ギリギリを検出できないので、打刻の通信失敗も条件に含める。
  const canRecordOffline = isGpsReady && (!isOnline || submitFailedOffline);

  // 圏外の到着を仮記録として端末に保存する。
  // これは待機料の請求根拠ではなく、管理者の承認を経て初めて正式な打刻になる。
  const handleRecordOffline = () => {
    if (!position) return;
    recordOfflinePunch({
      punchType: "arrival",
      latitude: position.lat,
      longitude: position.lon,
    });
    toast({
      title: "仮記録として保存しました",
      description:
        "通信が回復すると自動で送信されます。管理者の承認後に正式な打刻になります。",
    });
  };

  // 圏外の作業完了を仮記録する。
  // 実務では「到着はオンラインで正常、完了打刻だけ圏外」が最も多い。
  // 水産物情報は法令上の要求項目なので、完了の仮記録でも入力を必須にする。
  const handleRecordOfflineCompletion = () => {
    if (!position || !lastResult || !isFisheryDataValid) return;
    recordOfflinePunch({
      punchType: "completion",
      latitude: position.lat,
      longitude: position.lon,
      waitLogId: lastResult.logId,
      fisheryData: fisheryData as FisheryData,
    });
    toast({
      title: "作業完了を仮記録しました",
      description:
        "通信が回復すると自動で送信されます。管理者の承認後に正式な記録になります。",
    });
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

      {/* ── オフライン Alert ── */}
      {!isOnline && (
        <Alert variant="destructive">
          <AlertTitle>オフラインです</AlertTitle>
          <AlertDescription>
            正式な打刻には通信が必要です（時刻と拠点の確認をサーバーで行うため）。
            {isGpsReady
              ? "GPSは取得できているため、下のボタンで仮記録として残せます。"
              : "電波の良い場所へ移動してから打刻してください。"}
            これまでの記録はそのまま残っています。
          </AlertDescription>
        </Alert>
      )}

      {/* ── 未送信の仮記録 ── */}
      {pendingCount > 0 && (
        <Alert>
          <AlertTitle>
            未送信の仮記録が{pendingCount}件あります
            {isFlushing && "（送信中...）"}
          </AlertTitle>
          <AlertDescription>
            通信が回復すると自動で送信されます。送信後も管理者の承認を受けるまでは
            正式な打刻にならず、待機料の請求根拠にはなりません。
          </AlertDescription>
        </Alert>
      )}

      {/* ── 送信したが受け付けられなかった仮記録 ── */}
      {rejected.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>受け付けられなかった仮記録が{rejected.length}件あります</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            {rejected.slice(0, 3).map((r) => (
              <span key={r.clientPunchId} className="text-xs">
                {formatArrivalDateTime(r.claimedAt)} の記録: {r.reason}
              </span>
            ))}
            <button
              onClick={dismissRejected}
              className="self-start text-xs underline underline-offset-2"
            >
              確認したので閉じる
            </button>
          </AlertDescription>
        </Alert>
      )}

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
          ) : !isOnline ? (
            <span className="flex flex-col items-center gap-3 opacity-60">
              <WifiOff className="h-10 w-10" />
              <span>オフライン</span>
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

      {/* ── 圏外時の仮記録（正式な打刻の代替ではないことを明示する）── */}
      {!lastResult && canRecordOffline && (
        <div className="flex flex-col gap-2 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4">
          <p className="text-sm font-bold text-amber-900 dark:text-amber-200">
            通信がなくても記録を残せます
          </p>
          <p className="text-xs text-amber-800 dark:text-amber-300">
            GPS座標は取得できているため、到着した事実を仮記録として端末に保存できます。
            通信が回復すると自動で送信され、<strong>管理者が承認すると正式な打刻になります</strong>。
            承認されるまでは待機料の請求根拠になりません。
          </p>
          <Button
            variant="outline"
            size="lg"
            onClick={handleRecordOffline}
            className="w-full border-amber-500 text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40 font-bold"
            style={{ minHeight: "64px" }}
          >
            <FileClock className="mr-2 h-5 w-5" />
            到着を仮記録する
          </Button>
        </div>
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

          {/* ── 荷役開始（荷待ち時間の終端を確定する）──
              この打刻がないと荷待ち時間の終端が決まらず、待機料が発生しない。
              到着と作業完了の間に必ず挟まる操作。 */}
          {!loadingResult ? (
            <div className="flex flex-col gap-2 rounded-xl border border-sky-300 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/30 p-4">
              <p className="text-sm font-bold text-sky-900 dark:text-sky-200">
                荷役が始まったら押してください
              </p>
              <p className="text-xs text-sky-800 dark:text-sky-300">
                ここまでが荷待ち時間として記録され、<strong>待機料の算定根拠になります</strong>。
                押し忘れると荷待ち時間が確定せず、待機料を請求できません。
              </p>
              <Button
                size="lg"
                disabled={isButtonLocked || isStartingLoading}
                onClick={startLoading}
                className="w-full bg-sky-600 hover:bg-sky-700 text-white font-bold"
                style={{ minHeight: "88px", fontSize: "1.25rem" }}
              >
                {isStartingLoading ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-6 w-6 animate-spin" />
                    記録中...
                  </span>
                ) : !isOnline ? (
                  <span className="flex items-center gap-2 opacity-60">
                    <WifiOff className="h-6 w-6" />
                    オフライン
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <PackageOpen className="h-6 w-6" />
                    荷役開始
                  </span>
                )}
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-3 rounded-xl bg-sky-50 dark:bg-sky-950/30 border border-sky-200 dark:border-sky-800 p-4">
              <CheckCircle2 className="h-6 w-6 text-sky-500 shrink-0" />
              <div className="text-center">
                <p className="text-sm font-bold text-foreground">荷役開始を記録しました</p>
                {loadingResult.waitingMinutes != null && (
                  <p className="text-xs text-muted-foreground">
                    荷待ち時間 {loadingResult.waitingMinutes}分を確定（待機料の算定対象）
                  </p>
                )}
              </div>
            </div>
          )}

          {/* 水産物情報フォーム */}
          <FisheryForm
            value={fisheryData}
            onChange={setFisheryData}
            notificationNumber={lastResult.facilityNotificationNumber}
            transferDate={new Date(lastResult.arrivalTime)}
          />

          {/* 荷役開始を飛ばすと荷待ち時間の終端が決まらず待機料がゼロになる。
              完了直前にもう一度警告する。 */}
          {!loadingResult && (
            <Alert variant="destructive">
              <AlertTitle>荷役開始が未記録です</AlertTitle>
              <AlertDescription>
                このまま作業完了すると荷待ち時間が確定せず、
                <strong>この待機の待機料を請求できません</strong>。
                荷役が始まった時点に戻れない場合は、先に上の「荷役開始」を押してから
                作業完了してください。
              </AlertDescription>
            </Alert>
          )}

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
            ) : !isOnline ? (
              <span className="flex flex-col items-center gap-3 opacity-60">
                <WifiOff className="h-10 w-10" />
                <span>オフライン</span>
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

          {/* ── 圏外時の完了仮記録 ──
              実務では「到着はオンラインで正常、完了打刻だけ圏外」が最も多い。
              水産物情報は法令上の要求項目なので、仮記録でも入力を必須にする。 */}
          {canRecordOffline && (
            <div className="flex flex-col gap-2 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4">
              <p className="text-sm font-bold text-amber-900 dark:text-amber-200">
                通信がなくても作業完了を記録できます
              </p>
              <p className="text-xs text-amber-800 dark:text-amber-300">
                GPS座標は取得できているため、出発した事実を仮記録として残せます。
                通信が回復すると自動で送信され、
                <strong>管理者が承認すると正式な記録になります</strong>。
                {!isFisheryDataValid && "（先に水産物情報の入力が必要です）"}
              </p>
              <Button
                variant="outline"
                size="lg"
                disabled={!isFisheryDataValid}
                onClick={handleRecordOfflineCompletion}
                className="w-full border-amber-500 text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40 font-bold"
                style={{ minHeight: "64px" }}
              >
                <FileClock className="mr-2 h-5 w-5" />
                作業完了を仮記録する
              </Button>
            </div>
          )}
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
