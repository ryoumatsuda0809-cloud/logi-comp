import { describe, it, expect } from "vitest";
import { submitBlockReason } from "./submitGuard";

describe("submitBlockReason — 打刻が0件の日は提出させない", () => {
  it("読み込み中は理由を返す", () => {
    expect(submitBlockReason({ loading: true, hasWaitLogRecords: true, timelineLength: 3 })).toBe("記録を読み込み中です");
  });

  it("打刻（wait_logs）の記録があれば提出できる", () => {
    expect(submitBlockReason({ loading: false, hasWaitLogRecords: true, timelineLength: 3 })).toBeNull();
  });

  it("音声の申告だけの日は提出できない（理由にその旨が出る）", () => {
    const reason = submitBlockReason({ loading: false, hasWaitLogRecords: false, timelineLength: 1 });
    expect(reason).toContain("音声の申告だけでは提出できません");
  });

  it("記録が何も無い日は提出できない", () => {
    const reason = submitBlockReason({ loading: false, hasWaitLogRecords: false, timelineLength: 0 });
    expect(reason).toBe("本日の打刻記録がないため、提出できません");
  });
});
