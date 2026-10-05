/**
 * 日本時間（JST）の「今日」を扱うユーティリティ。
 *
 * 日報・待機記録の「今日」は、端末のタイムゾーンやUTCではなく常に日本の暦日で決める。
 * `new Date().toISOString().slice(0, 10)` はUTCの日付を返すため、日本時間の午前9時前は
 * 前日になり、早朝便の記録が日報に入らなくなる。
 */

const JST_DATE = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 日本時間の日付を YYYY-MM-DD で返す */
export function jstDateString(at: Date = new Date()): string {
  return JST_DATE.format(at);
}

/** 日本時間のその日の開始・終了（タイムゾーン付きISO文字列）。DBの timestamptz との比較に使う */
export function jstDayRange(dateStr: string): { start: string; end: string } {
  return {
    start: `${dateStr}T00:00:00+09:00`,
    end: `${dateStr}T23:59:59.999+09:00`,
  };
}
