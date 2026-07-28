import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import type { Json } from "@/integrations/supabase/types";

export interface GpsPosition {
  lat: number;
  lon: number;
}

export interface EvidenceResult {
  logId: string;
  ticketNumber: number;
  arrivalTime: string;
  facilityName: string;
}

export interface FisheryData {
  species: string;
  weight_kg: number;
  catch_number: string;
}

export interface CompleteResult {
  logId: string;
  completedAt: string;
  waitingMinutes: number | null;
}

function gpsErrorMessage(err: GeolocationPositionError): string {
  switch (err.code) {
    case 1:
      return "位置情報の取得が許可されていません。ブラウザや端末の設定から位置情報を許可してください。";
    case 2:
      return "現在地が取得できません。電波の良い場所に移動するか、少し待ってから再試行してください。";
    case 3:
      return "位置情報の取得がタイムアウトしました。再試行してください。";
    default:
      return "GPSの取得に失敗しました。";
  }
}

export interface UseEvidenceReturn {
  position: GpsPosition | null;
  gpsError: string | null;
  isSubmitting: boolean;
  submitError: string | null;
  lastResult: EvidenceResult | null;
  submitEvidence: () => Promise<void>;
  clearSubmitError: () => void;
  clearResult: () => void;
  // 作業完了フロー
  completeResult: CompleteResult | null;
  isCompleting: boolean;
  completeError: string | null;
  completeTicket: (fisheryData: FisheryData) => Promise<void>;
  clearCompleteError: () => void;
  resetForNext: () => void;
  // 打刻取消フロー
  isCancelling: boolean;
  cancelError: string | null;
  cancelTicket: () => Promise<void>;
  clearCancelError: () => void;
  // 状態復元中フラグ
  isRestoringState: boolean;
}

export function useEvidence(): UseEvidenceReturn {
  const { user } = useAuth();
  const [position, setPosition] = useState<GpsPosition | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<EvidenceResult | null>(null);
  const [completeResult, setCompleteResult] = useState<CompleteResult | null>(null);
  const [isCompleting, setIsCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [isRestoringState, setIsRestoringState] = useState(true);

  // ── 連続GPS監視 ──
  useEffect(() => {
    if (!navigator.geolocation) {
      setGpsError("このブラウザは位置情報に対応していません。");
      return;
    }
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setPosition({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setGpsError(null);
      },
      (err) => setGpsError(gpsErrorMessage(err)),
      { enableHighAccuracy: true, timeout: 15000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  // ── 状態の永続化復元 ──
  // マウント時にSupabaseから未完了チケットを取得し、State Bへ復元する。
  useEffect(() => {
    if (!user) {
      setIsRestoringState(false);
      return;
    }

    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("wait_logs")
        .select("id, ticket_number, arrival_time, facilities(name)")
        .eq("user_id", user.id)
        .in("status", ["waiting", "called", "working"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (cancelled) return;

      if (!error && data) {
        const facilityRow = data.facilities;
        const facilityName = Array.isArray(facilityRow)
          ? (facilityRow[0]?.name ?? "不明")
          : (facilityRow?.name ?? "不明");

        setLastResult({
          logId: data.id,
          ticketNumber: data.ticket_number,
          arrivalTime: data.arrival_time,
          facilityName,
        });
      }

      setIsRestoringState(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── エビデンス送信（到着打刻）──
  // フロントは lat / lng / facility_id のみ送信。
  // 時刻付与・500mジオフェンス判定・整理券番号採番は全てDBトリガー / RPC に委ねる。
  const submitEvidence = useCallback(async () => {
    if (!user) {
      setSubmitError("ログインが必要です。");
      return;
    }
    if (!position) {
      setSubmitError("GPS座標を取得中です。取得完了後に再試行してください。");
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    // Step 1: 高精度GPSを新たに取得（失敗時は watchPosition の最終値を使用）
    let coords: GpsPosition = position;
    try {
      coords = await new Promise<GpsPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
          (err) => reject(err),
          { enableHighAccuracy: true, timeout: 10000 }
        );
      });
      setPosition(coords);
    } catch {
      // watchPosition の最終座標で続行
    }

    // Step 2: DBサイドの get_nearest_facility RPC で500m圏内の施設を取得
    const { data: facilities, error: facilityError } = await supabase.rpc(
      "get_nearest_facility",
      { user_lat: coords.lat, user_lng: coords.lon }
    );

    if (facilityError) {
      setSubmitError("拠点の検索に失敗しました。通信環境を確認してください。");
      setIsSubmitting(false);
      return;
    }

    if (!facilities || facilities.length === 0) {
      setSubmitError(
        "500m圏内に登録拠点が見つかりません。拠点の近くに移動してから打刻してください。"
      );
      setIsSubmitting(false);
      return;
    }

    const facility = facilities[0];

    // Step 3: issue_ticket RPC で wait_logs を INSERT
    // GPS座標はDB側で必須。500mジオフェンス判定もサーバーサイドで行われる。
    const { data: ticketData, error: ticketError } = await supabase.rpc(
      "issue_ticket",
      {
        p_facility_id: facility.id,
        p_latitude: coords.lat,
        p_longitude: coords.lon,
      }
    );

    if (ticketError) {
      const msg = ticketError.message ?? "";
      if (
        msg.includes("500") ||
        msg.includes("geofence") ||
        msg.includes("outside") ||
        msg.includes("圏外")
      ) {
        setSubmitError(
          "500m圏外のため打刻できません。拠点の近くに移動してから再試行してください。"
        );
      } else if (msg.includes("already") || msg.includes("duplicate")) {
        setSubmitError("すでに打刻済みです。");
      } else {
        setSubmitError(`打刻の記録に失敗しました（${msg}）。再試行してください。`);
      }
      setIsSubmitting(false);
      return;
    }

    if (!ticketData || ticketData.length === 0) {
      setSubmitError("打刻の記録に失敗しました。再試行してください。");
      setIsSubmitting(false);
      return;
    }

    const result = ticketData[0];
    setLastResult({
      logId: result.log_id,
      ticketNumber: result.new_ticket_number,
      arrivalTime: result.new_arrival_time,
      facilityName: facility.name,
    });
    setIsSubmitting(false);
  }, [user, position]);

  // ── 作業完了打刻（complete_ticket RPC）──
  // 出発時のGPS座標は到着時の座標を再利用せず、作業完了操作その場で再取得する。
  const completeTicket = useCallback(
    async (fisheryData: FisheryData) => {
      if (!lastResult) {
        setCompleteError("到着打刻が見つかりません。先に到着打刻を行ってください。");
        return;
      }
      if (!position) {
        setCompleteError("GPS座標を取得中です。取得完了後に再試行してください。");
        return;
      }

      setIsCompleting(true);
      setCompleteError(null);

      // 高精度GPSを新たに取得（失敗時は watchPosition の最終値を使用）
      let coords: GpsPosition = position;
      try {
        coords = await new Promise<GpsPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
            (err) => reject(err),
            { enableHighAccuracy: true, timeout: 10000 }
          );
        });
      } catch {
        // watchPosition の最終座標で続行
      }

      const payload: Json = {
        species: fisheryData.species,
        weight_kg: fisheryData.weight_kg,
        catch_number: fisheryData.catch_number,
      };

      const { data, error } = await supabase.rpc("complete_ticket", {
        p_log_id: lastResult.logId,
        p_latitude: coords.lat,
        p_longitude: coords.lon,
        p_fishery_data: payload,
      });

      if (error) {
        const msg = error.message ?? "";
        if (msg.includes("completed") || msg.includes("完了処理できません")) {
          setCompleteError("この打刻はすでに完了済みです。");
        } else if (msg.includes("no_data_found") || msg.includes("見つからない")) {
          setCompleteError("待機ログが見つかりません。再度到着打刻を行ってください。");
        } else if (msg.includes("GPS座標")) {
          setCompleteError("GPS座標を取得できませんでした。取得完了後に再試行してください。");
        } else if (msg.includes("check_violation") || msg.includes("ステータス遷移")) {
          setCompleteError("打刻のステータスが無効です。管理者にご連絡ください。");
        } else {
          setCompleteError(`作業完了の記録に失敗しました（${msg}）。再試行してください。`);
        }
        setIsCompleting(false);
        return;
      }

      if (!data || data.length === 0) {
        setCompleteError("作業完了の記録に失敗しました。再試行してください。");
        setIsCompleting(false);
        return;
      }

      const result = data[0];
      setCompleteResult({
        logId: result.log_id,
        completedAt: result.completed_at,
        waitingMinutes: result.waiting_minutes ?? null,
      });
      setIsCompleting(false);
    },
    [lastResult, position]
  );

  // ── 打刻取消（cancel_ticket RPC）──
  // DBの status を 'cancelled' に確定させる。レコードは削除せず監査証跡を保全する。
  const cancelTicket = useCallback(async () => {
    if (!lastResult) return;

    setIsCancelling(true);
    setCancelError(null);

    const { error } = await supabase.rpc("cancel_ticket", {
      p_log_id: lastResult.logId,
    });

    if (error) {
      const msg = error.message ?? "";
      if (msg.includes("署名済み")) {
        setCancelError("この打刻は確定済みのため取り消せません。管理者にご連絡ください。");
      } else if (msg.includes("no_data_found") || msg.includes("見つからない")) {
        setCancelError("待機ログが見つかりません。画面を再読み込みしてください。");
      } else if (msg.includes("取り消せません") || msg.includes("check_violation")) {
        setCancelError("この打刻はすでに完了または取消済みです。");
      } else {
        setCancelError(`打刻の取り消しに失敗しました（${msg}）。再試行してください。`);
      }
      setIsCancelling(false);
      return;
    }

    setLastResult(null);
    setCompleteResult(null);
    setIsCancelling(false);
  }, [lastResult]);

  const clearSubmitError = useCallback(() => setSubmitError(null), []);
  const clearResult = useCallback(() => setLastResult(null), []);
  const clearCompleteError = useCallback(() => setCompleteError(null), []);
  const clearCancelError = useCallback(() => setCancelError(null), []);
  const resetForNext = useCallback(() => {
    setLastResult(null);
    setCompleteResult(null);
  }, []);

  return {
    position,
    gpsError,
    isSubmitting,
    submitError,
    lastResult,
    submitEvidence,
    clearSubmitError,
    clearResult,
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
  };
}
