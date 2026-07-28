/**
 * 日跨ぎ・長時間放置された到着打刻の検知ユーティリティ
 *
 * 【背景】
 * 到着打刻の完了打刻を忘れたまま翌日以降にアプリを開くと、UIが到着時刻を
 * 「時:分」でしか表示していなかったため、古い打刻が当日のものと区別できなかった。
 * そのまま「作業完了」を押すと、待機時間が実経過時間（実測で109日 = 157078分）
 * として法的記録に保存され、取適法上の待機料請求根拠が著しく不正確になる。
 *
 * 現場では夜間をまたぐ正当な待機（例: 23:00到着 → 翌02:00出発）も存在するため、
 * 「カレンダー日が違う」ではなく「経過時間が現実的な範囲を超えている」で判定する。
 */

/**
 * 要確認とみなす経過時間のしきい値（ミリ秒）。
 * 改善基準告示の1日の拘束時間上限（原則13時間・最大16時間）を踏まえ、
 * 単一の到着→出発サイクルとして現実的な上限を16時間とする。
 */
export const STALE_THRESHOLD_MS = 16 * 60 * 60 * 1000;

/**
 * 到着時刻から現在までの経過ミリ秒を返す。
 */
export function elapsedMs(arrivalIso: string, now: Date = new Date()): number {
  const arrival = new Date(arrivalIso).getTime();
  if (isNaN(arrival)) return 0;
  return Math.max(0, now.getTime() - arrival);
}

/**
 * 打刻が「完了打刻の押し忘れ」の疑いがある古い記録かを判定する。
 */
export function isStaleTicket(arrivalIso: string, now: Date = new Date()): boolean {
  return elapsedMs(arrivalIso, now) >= STALE_THRESHOLD_MS;
}

/**
 * 経過時間を日本語で読みやすく整形する（例: "3時間20分" / "109日と2時間"）。
 */
export function formatElapsed(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}日と${hours}時間`;
  if (hours > 0) return `${hours}時間${minutes}分`;
  return `${minutes}分`;
}

/**
 * 到着日時を日付込みで表示する（例: "4月9日 21:00"）。
 * 時刻のみの表示だと古い打刻を当日のものと誤認するため、常に日付を含める。
 */
export function formatArrivalDateTime(arrivalIso: string): string {
  const d = new Date(arrivalIso);
  if (isNaN(d.getTime())) return "不明";
  return d.toLocaleString("ja-JP", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
