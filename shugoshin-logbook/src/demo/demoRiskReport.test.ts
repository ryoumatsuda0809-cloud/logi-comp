import { describe, expect, it } from "vitest";
import { buildDemoRiskRows, riskLevel } from "./demoRiskReport";

describe("警告レポートのデモデータ", () => {
  const rows = buildDemoRiskRows();
  const by = (shipper: string) => rows.find((r) => r.client_organization_name === shipper)!;

  it("架空水産: 待機1回ごとに30分を控除して ¥12,250、平均60.4分で「高」", () => {
    // 72,65,48,100,35,55,80,28 → 控除後 42,35,18,70,5,25,50,0 = 245分 × 50円
    const r = by("架空水産");
    expect(r.total_visits).toBe(8);
    expect(r.total_wait_minutes).toBe(483);
    expect(r.estimated_loss_jpy).toBe(12250);
    expect(r.gmen_risk_level).toBe("高");
  });

  it("架空物産: 圏外承認1件を含み、判定は「中」、逸失額 ¥6,000", () => {
    const r = by("架空物産");
    expect(r.approved_claim_visits).toBe(1);
    expect(r.estimated_loss_jpy).toBe(6000);
    expect(r.gmen_risk_level).toBe("中");
  });

  it("架空冷蔵: 算定不可の1件は待機分数に入れず、訪問数にだけ数える", () => {
    const r = by("架空冷蔵");
    expect(r.total_visits).toBe(6);
    expect(r.unmeasured_visits).toBe(1);
    expect(r.total_wait_minutes).toBe(138);
    expect(r.estimated_loss_jpy).toBe(650);
    expect(r.gmen_risk_level).toBe("低");
  });

  it("架空商事: すべて30分以下なら逸失額は0円（待機が無かったわけではない）", () => {
    const r = by("架空商事");
    expect(r.total_wait_minutes).toBe(70);
    expect(r.estimated_loss_jpy).toBe(0);
    expect(r.gmen_risk_level).toBe("低");
  });

  it("リスク判定の境界は実際のビューと同じ（60分以上=高、30分以上=中）", () => {
    expect(riskLevel(60)).toBe("高");
    expect(riskLevel(59.9)).toBe("中");
    expect(riskLevel(30)).toBe("中");
    expect(riskLevel(29.9)).toBe("低");
  });
});
