import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import {
  enqueuePunch,
  flushPunchQueue,
  getQueue,
  getRejected,
  clearRejected,
  type OfflinePunch,
  type PunchType,
  type RejectedPunch,
} from "@/lib/offlinePunchQueue";

export interface UseOfflinePunchReturn {
  /** 未送信の仮記録の件数 */
  pendingCount: number;
  /** サーバーに恒久的に拒否された仮記録 */
  rejected: RejectedPunch[];
  dismissRejected: () => void;
  isFlushing: boolean;
  /** 直近の送信で受理された件数（トースト表示用。表示後は clearLastAccepted で消す） */
  lastAccepted: number;
  clearLastAccepted: () => void;
  /** 圏外の打刻を仮記録として端末に保存する */
  recordOfflinePunch: (args: {
    punchType: PunchType;
    latitude: number;
    longitude: number;
    accuracyM?: number | null;
    note?: string | null;
    waitLogId?: string | null;
  }) => OfflinePunch;
  /** 手動送信（通常は復帰時に自動で走る） */
  flushNow: () => Promise<void>;
}

/**
 * 圏外で記録した打刻の仮記録キューを管理する。
 *
 * 【重要】ここで扱う記録は待機料の請求根拠にならない。
 * サーバーへ送っても `pending_punches` に「申請」として積まれるだけで、
 * 管理者が承認して初めて `wait_logs` へ昇格する（承認機能は Phase 2）。
 * 呼び出し側の UI は、確定した打刻と同じ見た目にしてはならない。
 *
 * 【iOSの制約】Service Worker の Background Sync は iOS Safari が非対応のため、
 * バックグラウンドでの自動送信はできない。オンライン復帰イベント、および
 * 次にアプリを開いたときの送信で妥協する。
 */
export function useOfflinePunch(): UseOfflinePunchReturn {
  const { user } = useAuth();
  const isOnline = useOnlineStatus();

  const [pendingCount, setPendingCount] = useState(() => getQueue().length);
  const [rejected, setRejected] = useState<RejectedPunch[]>(() => getRejected());
  const [isFlushing, setIsFlushing] = useState(false);
  const [lastAccepted, setLastAccepted] = useState(0);

  // 同時多重送信を防ぐ（オンライン復帰イベントが連続発火することがある）
  const flushingRef = useRef(false);

  const syncFromStorage = useCallback(() => {
    setPendingCount(getQueue().length);
    setRejected(getRejected());
  }, []);

  const flushNow = useCallback(async () => {
    if (flushingRef.current) return;
    if (!user) return;
    if (getQueue().length === 0) return;

    flushingRef.current = true;
    setIsFlushing(true);
    try {
      const result = await flushPunchQueue();
      if (result.accepted > 0) setLastAccepted(result.accepted);
    } finally {
      flushingRef.current = false;
      setIsFlushing(false);
      syncFromStorage();
    }
  }, [user, syncFromStorage]);

  // オンライン復帰時・ログイン確立時に自動送信する。
  // navigator.onLine は「圏外ギリギリで接続はあるが通信が通らない」状態を
  // 検出できないため、失敗した分はキューに残して次の機会に再試行される。
  useEffect(() => {
    if (isOnline && user) {
      void flushNow();
    }
  }, [isOnline, user, flushNow]);

  const recordOfflinePunch = useCallback<UseOfflinePunchReturn["recordOfflinePunch"]>(
    ({ punchType, latitude, longitude, accuracyM = null, note = null, waitLogId = null }) => {
      const entry = enqueuePunch({
        punchType,
        // 端末時刻。検証不能な「主張」であり、サーバーは received_at を別に記録する
        claimedAt: new Date().toISOString(),
        latitude,
        longitude,
        accuracyM,
        note,
        waitLogId,
      });
      syncFromStorage();
      return entry;
    },
    [syncFromStorage]
  );

  const dismissRejected = useCallback(() => {
    clearRejected();
    setRejected([]);
  }, []);

  const clearLastAccepted = useCallback(() => setLastAccepted(0), []);

  return {
    pendingCount,
    rejected,
    dismissRejected,
    isFlushing,
    lastAccepted,
    clearLastAccepted,
    recordOfflinePunch,
    flushNow,
  };
}
