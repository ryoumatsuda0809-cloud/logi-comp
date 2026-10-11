import { describe, it, expect } from "vitest";
import { appendNewWaitLogEntries } from "./reportSnapshot";
import type { WaitLogTimelineEntry } from "./waitLogToTimeline";

const entry = (eventType: string, timestamp: string): WaitLogTimelineEntry => ({
  source: "wait_log",
  timestamp,
  eventType,
  locationName: "下関中央卸売市場",
});

describe("appendNewWaitLogEntries — 提出する明細の二重入りを防ぐ", () => {
  const arrival = "2026-10-10T00:00:00.000Z";
  const loading = "2026-10-10T00:40:00.000Z";

  it("画面の timeline にすでにある打刻は足さない", () => {
    const snapshot = [
      { id: `wl-arrival-${arrival}`, source: "gps", eventType: "arrival", timestamp: arrival },
      { id: `wl-waiting_start-${loading}`, source: "gps", eventType: "waiting_start", timestamp: loading },
    ];
    const result = appendNewWaitLogEntries(snapshot, [entry("arrival", arrival), entry("waiting_start", loading)]);
    expect(result).toEqual(snapshot);
  });

  it("ページを開いたあとに増えた打刻だけを足し、source を wait_log にする", () => {
    const snapshot = [{ id: "x", source: "gps", eventType: "arrival", timestamp: arrival }];
    const departure = "2026-10-10T02:00:00.000Z";
    const result = appendNewWaitLogEntries(snapshot, [entry("arrival", arrival), entry("departure", departure)]);
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ eventType: "departure", timestamp: departure, source: "wait_log" });
  });

  it("eventType が違えば同じ時刻でも別の打刻として足す", () => {
    const snapshot = [{ id: "x", source: "gps", eventType: "arrival", timestamp: arrival }];
    const result = appendNewWaitLogEntries(snapshot, [entry("waiting_start", arrival)]);
    expect(result).toHaveLength(2);
  });

  it("snapshot が空なら取り直した行をすべて足す", () => {
    const result = appendNewWaitLogEntries([], [entry("arrival", arrival), entry("waiting_start", loading)]);
    expect(result).toHaveLength(2);
  });

  it("渡した snapshot を書き換えない", () => {
    const snapshot = [{ id: "x", source: "gps", eventType: "arrival", timestamp: arrival }];
    appendNewWaitLogEntries(snapshot, [entry("departure", loading)]);
    expect(snapshot).toHaveLength(1);
  });
});
