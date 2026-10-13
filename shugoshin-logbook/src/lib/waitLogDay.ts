/**
 * 「その日（日本時間）の wait_logs」を決める基準。
 *
 * サーバー（calc_daily_wait_totals / submit_daily_report）は
 * COALESCE(claimed_at, arrival_time) を日本時間に直した日で数える。
 * 等級C（圏外申告の承認）では arrival_time が承認処理の時刻になるため、
 * 申告した到着日（claimed_at）で見ないと、承認が翌日のとき別の日に入ってしまう。
 * 提出前の見積もり表示も同じ基準にして、サーバーが数える範囲と食い違わないようにする。
 */
import { jstDateString, jstDayRange } from "@/lib/jstDate";
import { effectiveArrival, type WaitLogRow } from "@/lib/waitLogToTimeline";

/**
 * PostgREST の `.or()` に渡す条件。claimed_at があればそれ、無ければ arrival_time が
 * 日本時間のその日に入る行。
 */
export function waitLogsOfJstDayFilter(dateStr: string): string {
  const { start, end } = jstDayRange(dateStr);
  return (
    `and(claimed_at.gte.${start},claimed_at.lte.${end}),` +
    `and(claimed_at.is.null,arrival_time.gte.${start},arrival_time.lte.${end})`
  );
}

/** 行が日本時間のその日に属するか（サーバーと同じ基準。クライアント側の防御的な絞り込み・テスト用） */
export function isOnJstDay(log: WaitLogRow, dateStr: string): boolean {
  return jstDateString(new Date(effectiveArrival(log))) === dateStr;
}
