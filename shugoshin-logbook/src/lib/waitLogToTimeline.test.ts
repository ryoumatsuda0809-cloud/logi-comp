import { describe, it, expect } from "vitest";
import { convertWaitLogsToTimeline, diffMinutes, type WaitLogRow } from "./waitLogToTimeline";

describe("convertWaitLogsToTimeline — 待機料誤課金防止の回帰テスト", () => {
  const facilityMap = { "facility-1": "下関中央卸売市場" };

  it("departureエントリのwaitMinutesは未設定であること（作業時間を待機時間として計上しない）", () => {
    const logs: WaitLogRow[] = [
      {
        id: "log-1",
        facility_id: "facility-1",
        ticket_number: 1,
        status: "completed",
        arrival_time: "2026-07-20T09:00:00.000Z",
        called_time: "2026-07-20T09:20:00.000Z", // 荷待ち20分（30分以下なので待機料は0円だが分は計上される）
        work_start_time: "2026-07-20T09:20:00.000Z",
        work_end_time: "2026-07-20T11:20:00.000Z", // 作業時間120分（これが待機時間扱いされるとバグ）
      },
    ];

    const { entries, totalWaitMinutes, totalWorkMinutes } = convertWaitLogsToTimeline(
      logs,
      facilityMap
    );

    const departureEntry = entries.find((e) => e.eventType === "departure");
    expect(departureEntry).toBeDefined();
    // 作業時間(120分)がwaitMinutesとして紛れ込んでいないこと
    expect(departureEntry?.waitMinutes).toBeUndefined();

    const waitingStartEntry = entries.find((e) => e.eventType === "waiting_start");
    expect(waitingStartEntry?.waitMinutes).toBe(20);

    // 待機時間の合計は荷待ち20分のみ（作業時間120分を含まない）
    expect(totalWaitMinutes).toBe(20);
    expect(totalWorkMinutes).toBe(120);
  });

  it("diffMinutesは負の差分を0にクランプする", () => {
    expect(
      diffMinutes("2026-07-20T10:00:00.000Z", "2026-07-20T09:00:00.000Z")
    ).toBe(0);
  });
});
