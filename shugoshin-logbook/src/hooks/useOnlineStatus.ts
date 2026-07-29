import { useState, useEffect } from "react";

/**
 * オンライン / オフライン状態を監視する。
 *
 * 【注意】navigator.onLine は「ネットワークインターフェースがあるか」しか見ておらず、
 * 圏外ギリギリで接続はあるが通信が通らない状態は true のままになる。
 * このため打刻処理側では、onLine が true でも通信失敗を必ずハンドリングすること
 * （本フックは「明らかにオフライン」の検出にのみ使う）。
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === "undefined" ? true : navigator.onLine
  );

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}
