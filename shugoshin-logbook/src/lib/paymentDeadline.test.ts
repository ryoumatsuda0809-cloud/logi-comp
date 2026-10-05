import { describe, expect, it } from "vitest";
import { isPaymentDateTooLate, latestPaymentDate } from "./paymentDeadline";

// 取適法第3条: 支払期日は、役務の提供を受けた日から起算して60日以内（受領日を算入する）。
// 受領日を1日目と数えるので、定めてよい最も遅い日は受領日の59日後。
describe("latestPaymentDate", () => {
  it("受領日の59日後を返す（60日後ではない）", () => {
    expect(latestPaymentDate("2026-10-04")).toBe("2026-12-02");
  });

  it("月・年をまたぐ", () => {
    expect(latestPaymentDate("2026-12-10")).toBe("2027-02-07");
  });

  it("うるう年の2月をまたぐ（2028-02-29 は60日後、59日後は2/28）", () => {
    expect(latestPaymentDate("2027-12-31")).toBe("2028-02-28");
  });

  it("日付でない文字列と空は null", () => {
    expect(latestPaymentDate("")).toBeNull();
    expect(latestPaymentDate("明日")).toBeNull();
    expect(latestPaymentDate("2026-13-40")).toBeNull();
  });

  it("端末のタイムゾーンに左右されない（時刻つきの文字列も日付部分だけで数える）", () => {
    expect(latestPaymentDate("2026-10-04T15:30:00.000Z")).toBe("2026-12-02");
  });
});

describe("isPaymentDateTooLate", () => {
  it("上限の日そのものは超過ではない", () => {
    expect(isPaymentDateTooLate("2026-12-02", "2026-10-04")).toBe(false);
  });

  it("上限の翌日（受領日の60日後）は超過", () => {
    expect(isPaymentDateTooLate("2026-12-03", "2026-10-04")).toBe(true);
  });

  it("上限より前は超過ではない", () => {
    expect(isPaymentDateTooLate("2026-11-30", "2026-10-04")).toBe(false);
  });

  it("どちらかが日付として読めなければ超過とは言わない", () => {
    expect(isPaymentDateTooLate("", "2026-10-04")).toBe(false);
    expect(isPaymentDateTooLate("2026-12-03", "")).toBe(false);
  });
});
