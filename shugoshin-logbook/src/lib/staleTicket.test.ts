import { describe, it, expect } from "vitest";
import {
  isStaleTicket,
  elapsedMs,
  formatElapsed,
  formatArrivalDateTime,
  STALE_THRESHOLD_MS,
} from "./staleTicket";

describe("staleTicket — 完了打刻の押し忘れ検知", () => {
  const now = new Date("2026-07-27T22:58:00+09:00");

  it("実測された109日放置の打刻を古い記録として検知する", () => {
    // 本番で実際に発生したケース: 2026-04-09 21:00 到着のまま109日間 waiting だった
    const arrival = "2026-04-09T21:00:00+09:00";
    expect(isStaleTicket(arrival, now)).toBe(true);
    expect(formatElapsed(elapsedMs(arrival, now))).toBe("109日と1時間");
  });

  it("夜間をまたぐ正当な待機（3時間）は古い記録として扱わない", () => {
    // 23:00到着 → 翌02:00 の時点。カレンダー日は違うが正当な待機
    const arrival = "2026-07-27T23:00:00+09:00";
    const nextMorning = new Date("2026-07-28T02:00:00+09:00");
    expect(isStaleTicket(arrival, nextMorning)).toBe(false);
  });

  it("しきい値(16時間)の前後で判定が切り替わる", () => {
    const arrival = "2026-07-27T00:00:00+09:00";
    const justBefore = new Date(
      new Date(arrival).getTime() + STALE_THRESHOLD_MS - 60_000
    );
    const justAfter = new Date(
      new Date(arrival).getTime() + STALE_THRESHOLD_MS + 60_000
    );
    expect(isStaleTicket(arrival, justBefore)).toBe(false);
    expect(isStaleTicket(arrival, justAfter)).toBe(true);
  });

  it("到着日時は日付込みで整形され、時刻のみの表示にならない", () => {
    const formatted = formatArrivalDateTime("2026-04-09T21:00:00+09:00");
    // 「4月」「9日」を含むこと（時刻のみの表示だと古い打刻を当日と誤認するため）
    expect(formatted).toContain("4月");
    expect(formatted).toContain("9日");
  });

  it("不正な日付文字列でもクラッシュしない", () => {
    expect(elapsedMs("invalid-date", now)).toBe(0);
    expect(isStaleTicket("invalid-date", now)).toBe(false);
    expect(formatArrivalDateTime("invalid-date")).toBe("不明");
  });
});
