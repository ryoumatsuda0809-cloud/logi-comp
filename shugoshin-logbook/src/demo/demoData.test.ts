import { describe, expect, it } from "vitest";
import { haversineDistance } from "@/lib/haversine";
import { sumWaitCost } from "@/lib/waitCostCalc";
import { convertWaitLogsToTimeline } from "@/lib/waitLogToTimeline";
import {
  DEMO_FACILITIES,
  DEMO_FACILITY_NAMES,
  DEMO_GEOFENCE_RADIUS_M,
  DEMO_TRACK,
  DEMO_VEHICLE_CLASS,
  DEMO_WAIT_LOGS,
} from "./demoData";

describe("デモデータ", () => {
  const summary = convertWaitLogsToTimeline(DEMO_WAIT_LOGS, DEMO_FACILITY_NAMES);

  it("待機時間は 72 / 25 / 55 分（等級Cは申告時刻で算定）", () => {
    expect(summary.waitMinutesPerEvent).toEqual([72, 25, 55]);
  });

  it("待機料は待機1回ごとに30分を控除して合計する: (72-30)*50 + 0 + (55-30)*50", () => {
    expect(sumWaitCost(summary.waitMinutesPerEvent, DEMO_VEHICLE_CLASS)).toBe(2100 + 0 + 1250);
  });

  it("GPS軌跡は圏外から始まり、到着打刻の時点では500m圏内にいる", () => {
    const f = DEMO_FACILITIES[0];
    const dist = (p: { lat: number; lng: number }) => haversineDistance(p.lat, p.lng, f.lat, f.lng);
    expect(dist(DEMO_TRACK[0])).toBeGreaterThan(DEMO_GEOFENCE_RADIUS_M);
    const arrival = new Date(DEMO_WAIT_LOGS[0].arrival_time).getTime();
    const atArrival = DEMO_TRACK.find((p) => new Date(p.t).getTime() >= arrival)!;
    expect(dist(atArrival)).toBeLessThanOrEqual(DEMO_GEOFENCE_RADIUS_M);
  });

  it("待機中はずっと圏内にとどまる", () => {
    const f = DEMO_FACILITIES[0];
    for (const p of DEMO_TRACK.filter((p) => p.phase === "waiting")) {
      expect(haversineDistance(p.lat, p.lng, f.lat, f.lng)).toBeLessThanOrEqual(DEMO_GEOFENCE_RADIUS_M);
    }
  });
});
