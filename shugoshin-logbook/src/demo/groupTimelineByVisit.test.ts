import { describe, expect, it } from "vitest";
import { convertWaitLogsToTimeline, type WaitLogTimelineEntry } from "@/lib/waitLogToTimeline";
import { DEMO_FACILITY_NAMES, DEMO_WAIT_LOGS } from "./demoData";
import { groupTimelineByVisit } from "./groupTimelineByVisit";

const entry = (over: Partial<WaitLogTimelineEntry>): WaitLogTimelineEntry => ({
  source: "gps",
  timestamp: "2026-10-03T01:00:00Z",
  eventType: "arrival",
  locationName: "A",
  ticketNumber: 1,
  ...over,
});

describe("groupTimelineByVisit", () => {
  it("同じ施設・同じ整理券の打刻を1つの訪問にまとめ、時刻の早い順に並べる", () => {
    const visits = groupTimelineByVisit([
      entry({ eventType: "departure", timestamp: "2026-10-03T03:00:00Z" }),
      entry({ eventType: "arrival", timestamp: "2026-10-03T01:00:00Z" }),
      entry({ eventType: "waiting_start", timestamp: "2026-10-03T02:00:00Z", waitMinutes: 60 }),
    ]);
    expect(visits).toHaveLength(1);
    expect(visits[0].entries.map((e) => e.eventType)).toEqual(["arrival", "waiting_start", "departure"]);
    expect(visits[0].waitMinutes).toBe(60);
  });

  it("同じ施設に2回行っても、整理券が違えば別の訪問になる", () => {
    const visits = groupTimelineByVisit([
      entry({ ticketNumber: 1, timestamp: "2026-10-03T01:00:00Z" }),
      entry({ ticketNumber: 2, timestamp: "2026-10-03T05:00:00Z" }),
    ]);
    expect(visits).toHaveLength(2);
  });

  it("荷役開始が無い訪問は待機を null（算定不能）にし、0分とは区別する", () => {
    const [v] = groupTimelineByVisit([entry({})]);
    expect(v.waitMinutes).toBeNull();
    const [zero] = groupTimelineByVisit([entry({ eventType: "waiting_start", waitMinutes: 0 })]);
    expect(zero.waitMinutes).toBe(0);
  });

  it("等級Cの打刻を含む訪問だけ evidenceGrade が 'C' になる", () => {
    const visits = groupTimelineByVisit([
      entry({ ticketNumber: 1 }),
      entry({ ticketNumber: 2, evidenceGrade: "C", timestamp: "2026-10-03T02:00:00Z" }),
    ]);
    expect(visits.map((v) => v.evidenceGrade)).toEqual([undefined, "C"]);
  });

  it("デモの記録では、まとめても打刻の数と待機の分数（72 / 25 / 55）は変わらない", () => {
    const { entries } = convertWaitLogsToTimeline(DEMO_WAIT_LOGS, DEMO_FACILITY_NAMES);
    const visits = groupTimelineByVisit(entries);
    expect(visits.flatMap((v) => v.entries)).toHaveLength(entries.length);
    expect(visits.map((v) => v.waitMinutes)).toEqual([72, 25, 55]);
  });
});
