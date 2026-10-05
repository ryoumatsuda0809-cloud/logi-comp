import { describe, expect, it } from "vitest";
import { jstDateString, jstDayRange } from "./jstDate";

describe("jstDateString", () => {
  it("日本時間の午前9時前（UTCでは前日）でも日本の暦日を返す", () => {
    // 2026-10-03 07:50 JST = 2026-10-02 22:50 UTC
    expect(jstDateString(new Date("2026-10-02T22:50:00Z"))).toBe("2026-10-03");
  });

  it("日本時間の0時ちょうどは翌日", () => {
    expect(jstDateString(new Date("2026-10-02T15:00:00Z"))).toBe("2026-10-03");
    expect(jstDateString(new Date("2026-10-02T14:59:59Z"))).toBe("2026-10-02");
  });
});

describe("jstDayRange", () => {
  it("早朝の記録が、その日の範囲に含まれる", () => {
    const { start, end } = jstDayRange("2026-10-03");
    const early = new Date("2026-10-02T22:50:00Z").getTime(); // 07:50 JST
    expect(early).toBeGreaterThanOrEqual(new Date(start).getTime());
    expect(early).toBeLessThanOrEqual(new Date(end).getTime());
  });

  it("前日の深夜と翌日の0時は範囲に含まれない", () => {
    const { start, end } = jstDayRange("2026-10-03");
    expect(new Date("2026-10-02T14:59:59Z").getTime()).toBeLessThan(new Date(start).getTime());
    expect(new Date("2026-10-03T15:00:00Z").getTime()).toBeGreaterThan(new Date(end).getTime());
  });
});
