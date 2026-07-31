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
  /** 漁獲番号の先頭7桁。施設に未登録の場合は null（16桁の直接入力にフォールバックする） */
  facilityNotificationNumber: string | null;
}

export interface FisheryData {
  /** 表示用の魚種名（例: "アワビ" / "フグ"） */
  species: string;
  /** 特定第一種水産動植物のID（TARGET_SPECIES）。対象外の魚種では undefined */
  species_id?: string;
  weight_kg: number;
  /** 漁獲番号16桁。対象魚種でない場合は undefined（法令上不要なため） */
  catch_number?: string;
}

export interface CompleteResult {
  logId: string;
  completedAt: string;
  waitingMinutes: number | null;
}

export interface LoadingResult {
  logId: string;
  startedAt: string;
  /** 確定した荷待ち時間（到着〜荷役開始）。これが待機料の課金対象になる */
  waitingMinutes: number | null;
}

/**
 * 通信到達性の失敗かどうかを判定する。
 *
 * `navigator.onLine` は「圏外ギリギリで接続はあるが通信が通らない」状態を true のまま
 * 返すため（`useOnlineStatus` のヘッダー参照）、オフライン判定をそれだけに頼ると
 * 実質圏外のドライバーに仮記録の導線を出せない。RPC の失敗内容からも判定する。
 */
function isNetworkFailure(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("failed to fetch") ||
    m.includes("networkerror") ||
    m.includes("network request failed") ||
    m.includes("load failed") ||
    m.includes("timeout")
  );
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
  /** 直近の打刻失敗が通信到達性に起因するか。true のとき UI は仮記録の導線を出す */
  submitFailedOffline: boolean;
  clearSubmitError: () => void;
  clearResult: () => void;
  // 荷役開始フロー（荷待ち時間の終端を確定する）
  loadingResult: LoadingResult | null;
  isStartingLoading: boolean;
  loadingError: string | null;
  startLoading: () => Promise<void>;
  clearLoadingError: () => void;
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
  const [submitFailedOffline, setSubmitFailedOffline] = useState(false);
  const [lastResult, setLastResult] = useState<EvidenceResult | null>(null);
  const [loadingResult, setLoadingResult] = useState<LoadingResult | null>(null);
  const [isStartingLoading, setIsStartingLoading] = useState(false);
  const [loadingError, setLoadingError] = useState<string | null>(null);
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
        .select(
          "id, ticket_number, arrival_time, claimed_at, status, work_start_time, waiting_minutes, facilities(name, notification_number)"
        )
        .eq("user_id", user.id)
        .in("status", ["waiting", "called", "working"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (cancelled) return;

      if (!error && data) {
        const facilityRow = data.facilities;
        const facility = Array.isArray(facilityRow) ? facilityRow[0] : facilityRow;

        setLastResult({
          logId: data.id,
          ticketNumber: data.ticket_number,
          // 等級Cでは arrival_time が承認処理を行った時刻になるため主張時刻を優先する
          arrivalTime: data.claimed_at ?? data.arrival_time,
          facilityName: facility?.name ?? "不明",
          facilityNotificationNumber: facility?.notification_number ?? null,
        });

        // 荷役開始済みの状態も復元する。これを復元しないと、再読み込み後に
        // 荷役開始ボタンが再表示され、押すとRPCが「すでに荷役開始済み」で失敗する。
        if (data.work_start_time) {
          setLoadingResult({
            logId: data.id,
            startedAt: data.work_start_time,
            waitingMinutes: data.waiting_minutes ?? null,
          });
        }
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
    setSubmitFailedOffline(false);

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
      setSubmitFailedOffline(isNetworkFailure(facilityError.message ?? ""));
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
      setSubmitFailedOffline(isNetworkFailure(msg));
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
      facilityNotificationNumber: facility.notification_number ?? null,
    });
    setIsSubmitting(false);
  }, [user, position]);

  // ── 荷役開始打刻（start_loading RPC）──
  //
  // 荷待ち時間は「到着〜荷役開始」で算定される。この打刻がないと終端が
  // 確定せず、待機料が1円も発生しない。従来この時刻を設定できるのは
  // 管理ダッシュボード側だけだったが、そちらは別組織の管理者からは
  // 操作できない作りになっており、実質的に誰も設定できなかった。
  const startLoading = useCallback(async () => {
    if (!lastResult) {
      setLoadingError("到着打刻が見つかりません。先に到着打刻を行ってください。");
      return;
    }
    if (!position) {
      setLoadingError("GPS座標を取得中です。取得完了後に再試行してください。");
      return;
    }

    setIsStartingLoading(true);
    setLoadingError(null);

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

    const { data, error } = await supabase.rpc("start_loading", {
      p_log_id: lastResult.logId,
      p_latitude: coords.lat,
      p_longitude: coords.lon,
    });

    if (error) {
      const msg = error.message ?? "";
      if (msg.includes("荷役開始エラー") || msg.includes("check_violation")) {
        setLoadingError("この打刻はすでに荷役開始済み、または完了・取消済みです。");
      } else if (msg.includes("no_data_found") || msg.includes("見つからない")) {
        setLoadingError("待機ログが見つかりません。画面を再読み込みしてください。");
      } else if (msg.includes("GPS座標")) {
        setLoadingError("GPS座標を取得できませんでした。取得完了後に再試行してください。");
      } else {
        setLoadingError(`荷役開始の記録に失敗しました（${msg}）。再試行してください。`);
      }
      setIsStartingLoading(false);
      return;
    }

    if (!data || data.length === 0) {
      setLoadingError("荷役開始の記録に失敗しました。再試行してください。");
      setIsStartingLoading(false);
      return;
    }

    const result = data[0];
    setLoadingResult({
      logId: result.log_id,
      startedAt: result.started_at,
      waitingMinutes: result.waiting_minutes ?? null,
    });
    setIsStartingLoading(false);
  }, [lastResult, position]);

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

      // 漁獲番号は特定第一種水産動植物のみ法令上必要なため、
      // 対象外の魚種では catch_number を持たせない。
      const payload: Json = {
        species: fisheryData.species,
        weight_kg: fisheryData.weight_kg,
        ...(fisheryData.species_id ? { species_id: fisheryData.species_id } : {}),
        ...(fisheryData.catch_number
          ? { catch_number: fisheryData.catch_number }
          : {}),
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

  const clearSubmitError = useCallback(() => {
    setSubmitError(null);
    setSubmitFailedOffline(false);
  }, []);
  const clearResult = useCallback(() => setLastResult(null), []);
  const clearLoadingError = useCallback(() => setLoadingError(null), []);
  const clearCompleteError = useCallback(() => setCompleteError(null), []);
  const clearCancelError = useCallback(() => setCancelError(null), []);
  const resetForNext = useCallback(() => {
    setLastResult(null);
    setCompleteResult(null);
    setLoadingResult(null);
  }, []);

  return {
    position,
    gpsError,
    isSubmitting,
    submitError,
    lastResult,
    submitEvidence,
    submitFailedOffline,
    clearSubmitError,
    clearResult,
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
  };
}
