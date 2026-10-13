/**
 * 「その日（日本時間）の日報に含める wait_logs」を決める基準。
 *
 * サーバー（calc_daily_wait_totals / submit_daily_report）は、arrival_time を日本時間に
 * 直した日で数える。画面の見積もり（useDailyTimeline / DailyReportConfirm / SharedReportView）と
 * 共有帳票（get_shared_report）も arrival_time の範囲で絞っており、全部この基準で一致する。
 *
 * 等級C（圏外承認）の arrival_time は承認処理の時刻なので、等級C の記録は「承認した日」の
 * 日報に入る。申告した日の日報が提出済み（変更不可）でも、承認が翌日以降なら承認した日の
 * 日報に入るので、証拠が日報から漏れない（日付が少しずれる方が、記録が消えるより安全）。
 *
 * これは「どの日の日報に含めるか」だけの基準。待機分数の計算は別で、等級C は申告時刻
 * （claimed_at / claimed_loading_at）から計算する（waitLogToTimeline.ts）。
 * なお整理券番号の一意索引（COALESCE(claimed_at, arrival_time) の日）は、また別の基準。
 *
 * DB への問い合わせでは、日本時間の1日の範囲は jstDayRange() を使い、
 * arrival_time を gte/lte で絞る。
 */
import { jstDateString } from "@/lib/jstDate";
import type { WaitLogRow } from "@/lib/waitLogToTimeline";

/** 行が日本時間のその日の日報に含まれるか（サーバーと同じ基準。テスト用） */
export function isOnJstDay(log: Pick<WaitLogRow, "arrival_time">, dateStr: string): boolean {
  return jstDateString(new Date(log.arrival_time)) === dateStr;
}
