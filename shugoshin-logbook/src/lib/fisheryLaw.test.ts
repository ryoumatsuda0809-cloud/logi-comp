import { describe, it, expect } from "vitest";
import {
  isCatchNumberRequired,
  formatTransferDate,
  composeCatchNumber,
  validateCatchNumber,
  TARGET_SPECIES,
} from "./fisheryLaw";

const NOW = new Date("2026-07-28T12:00:00+09:00");

describe("isCatchNumberRequired — 対象魚種の判定", () => {
  it("アワビ・ナマコは対象", () => {
    expect(isCatchNumberRequired("abalone", 10, NOW)).toBe(true);
    expect(isCatchNumberRequired("sea_cucumber", 10, NOW)).toBe(true);
  });

  it("フグ・タイなど対象外魚種では不要（全魚種必須にしない）", () => {
    expect(isCatchNumberRequired(undefined, 88.5, NOW)).toBe(false);
    expect(isCatchNumberRequired("pufferfish", 88.5, NOW)).toBe(false);
  });

  it("太平洋クロマグロは30kg以上のみ対象", () => {
    expect(isCatchNumberRequired("pacific_bluefin_tuna", 30, NOW)).toBe(true);
    expect(isCatchNumberRequired("pacific_bluefin_tuna", 120.5, NOW)).toBe(true);
    expect(isCatchNumberRequired("pacific_bluefin_tuna", 29.9, NOW)).toBe(false);
    // 重量未入力では判定できないので不要側に倒す
    expect(isCatchNumberRequired("pacific_bluefin_tuna", undefined, NOW)).toBe(false);
  });

  it("適用開始日より前は不要（法改正の施行日で判定する）", () => {
    // 太平洋クロマグロは2026-04-01から
    const before = new Date("2026-03-31T12:00:00+09:00");
    expect(isCatchNumberRequired("pacific_bluefin_tuna", 120, before)).toBe(false);
    expect(isCatchNumberRequired("pacific_bluefin_tuna", 120, NOW)).toBe(true);

    // シラスウナギは2025-12-01から
    const beforeEel = new Date("2025-11-30T12:00:00+09:00");
    expect(isCatchNumberRequired("glass_eel", 1, beforeEel)).toBe(false);
    expect(isCatchNumberRequired("glass_eel", 1, NOW)).toBe(true);
  });

  it("対象魚種リストに適用開始日が全て定義されている", () => {
    for (const s of TARGET_SPECIES) {
      expect(isNaN(new Date(s.effectiveFrom).getTime())).toBe(false);
    }
  });
});

describe("composeCatchNumber — 16桁の組み立て", () => {
  it("届出番号7桁 + 譲渡日6桁 + ロット3桁 を連結する", () => {
    const n = composeCatchNumber("1234567", NOW, "042");
    expect(n).toBe("1234567" + "260728" + "042");
    expect(n).toHaveLength(16);
  });

  it("ロット番号は3桁にゼロ埋めされる（ドライバーは 7 とだけ打てばよい）", () => {
    expect(composeCatchNumber("1234567", NOW, "7")).toBe("1234567260728007");
  });

  it("譲渡日は端末TZに依存せず日本時間で決まる", () => {
    // UTCでは7/27だが日本時間では7/28
    const lateNight = new Date("2026-07-27T23:30:00Z");
    expect(formatTransferDate(lateNight)).toBe("260728");
  });
});

describe("validateCatchNumber — 構造検証（警告のみ・ブロックしない）", () => {
  it("正しい番号は警告なし", () => {
    const r = validateCatchNumber("1234567260728042", {
      notificationNumber: "1234567",
      transferDate: NOW,
    });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("桁数違いを検出する", () => {
    const r = validateCatchNumber("SH-2026-00123");
    expect(r.ok).toBe(false);
    expect(r.warnings[0]).toContain("16桁");
  });

  it("届出番号の不一致を検出する", () => {
    const r = validateCatchNumber("9999999260728042", {
      notificationNumber: "1234567",
      transferDate: NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.warnings.join()).toContain("届出番号");
  });

  it("譲渡日が打刻日と違う場合を検出する", () => {
    const r = validateCatchNumber("1234567260101042", {
      notificationNumber: "1234567",
      transferDate: NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.warnings.join()).toContain("譲渡日");
  });

  it("ロット番号が数字でない場合を検出する", () => {
    const r = validateCatchNumber("123456726072-AB", {
      notificationNumber: "1234567",
    });
    expect(r.ok).toBe(false);
  });

  it("期待値を渡さなければ桁数と数字構成のみを見る", () => {
    const r = validateCatchNumber("1234567260728042");
    expect(r.ok).toBe(true);
  });
});
