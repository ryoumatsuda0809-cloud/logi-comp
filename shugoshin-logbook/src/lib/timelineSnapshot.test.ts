import { describe, it, expect } from "vitest";
import { mergeWaitLogEntriesIntoSnapshot } from "./timelineSnapshot";
import type { WaitLogTimelineEntry } from "./waitLogToTimeline";

const entry = (eventType: string, timestamp: string, extra: Partial<WaitLogTimelineEntry> = {}): WaitLogTimelineEntry => ({
  source: "gps",
  eventType,
  timestamp,
  locationName: "下関中央卸売市場",
  ...extra,
});

describe("mergeWaitLogEntriesIntoSnapshot — 提出時の二重計上防止", () => {
  it("timeline にすでにある wait_logs の項目（eventType と timestamp が同じ）を足し直さない", () => {
    const timeline = [
      { id: "wl-arrival-2026-07-20T09:00:00.000Z", eventType: "arrival", timestamp: "2026-07-20T09:00:00.000Z" },
      { id: "wl-waiting_start-2026-07-20T09:40:00.000Z", eventType: "waiting_start", timestamp: "2026-07-20T09:40:00.000Z" },
    ];
    const entries = [
      entry("arrival", "2026-07-20T09:00:00.000Z"),
      entry("waiting_start", "2026-07-20T09:40:00.000Z", { waitMinutes: 40 }),
    ];

    const snapshot = mergeWaitLogEntriesIntoSnapshot(timeline, entries);

    expect(snapshot).toHaveLength(2);
  });

  it("timeline に無い項目だけを source: wait_log を付けて足す", () => {
    const timeline = [
      { id: "wl-arrival-2026-07-20T09:00:00.000Z", eventType: "arrival", timestamp: "2026-07-20T09:00:00.000Z" },
    ];
    const entries = [
      entry("arrival", "2026-07-20T09:00:00.000Z"),
      entry("departure", "2026-07-20T11:00:00.000Z"),
    ];

    const snapshot = mergeWaitLogEntriesIntoSnapshot(timeline, entries);

    expect(snapshot).toHaveLength(2);
    expect(snapshot[1]).toMatchObject({ eventType: "departure", source: "wait_log" });
  });

  it("timestamp が同じでも eventType が違えば別の項目として足す", () => {
    const timeline = [{ eventType: "arrival", timestamp: "2026-07-20T09:00:00.000Z" }];
    const entries = [entry("waiting_start", "2026-07-20T09:00:00.000Z")];

    expect(mergeWaitLogEntriesIntoSnapshot(timeline, entries)).toHaveLength(2);
  });

  it("eventType が同じでも timestamp が違えば別の項目として足す（別の来訪）", () => {
    const timeline = [{ eventType: "arrival", timestamp: "2026-07-20T09:00:00.000Z" }];
    const entries = [entry("arrival", "2026-07-20T13:00:00.000Z")];

    expect(mergeWaitLogEntriesIntoSnapshot(timeline, entries)).toHaveLength(2);
  });

  it("表記が違っても同じ時刻なら重複とみなす（Z と +00:00）", () => {
    const timeline = [{ eventType: "arrival", timestamp: "2026-07-20T09:00:00.000Z" }];
    const entries = [entry("arrival", "2026-07-20T09:00:00+00:00")];

    expect(mergeWaitLogEntriesIntoSnapshot(timeline, entries)).toHaveLength(1);
  });

  it("wait_logs の項目が無ければ timeline をそのまま返す", () => {
    const timeline = [{ eventType: "voice_report", timestamp: "2026-07-20T10:00:00.000Z" }];

    expect(mergeWaitLogEntriesIntoSnapshot(timeline, [])).toEqual(timeline);
  });

  it("timeline が空なら wait_logs の項目をすべて足す", () => {
    const entries = [entry("arrival", "2026-07-20T09:00:00.000Z"), entry("departure", "2026-07-20T11:00:00.000Z")];

    expect(mergeWaitLogEntriesIntoSnapshot([], entries)).toHaveLength(2);
  });

  it("元の timeline を書き換えない", () => {
    const timeline = [{ eventType: "voice_report", timestamp: "2026-07-20T10:00:00.000Z" }];
    mergeWaitLogEntriesIntoSnapshot(timeline, [entry("arrival", "2026-07-20T09:00:00.000Z")]);

    expect(timeline).toHaveLength(1);
  });
});
