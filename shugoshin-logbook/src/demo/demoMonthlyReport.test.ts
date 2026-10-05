import { describe, expect, it } from "vitest";
import { buildMonthlyRiskRows, riskLevelFor } from "./demoMonthlyReport";

describe("riskLevelFor（DB ビューと同じ境界）", () => {
  it("平均 60 分以上は高、30 分以上は中、それ未満は低", () => {
    expect(riskLevelFor(60)).toBe("高");
    expect(riskLevelFor(59.9)).toBe("中");
    expect(riskLevelFor(30)).toBe("中");
    expect(riskLevelFor(29.9)).toBe("低");
    expect(riskLevelFor(0)).toBe("低");
  });
});

describe("buildMonthlyRiskRows（架空の1か月分）", () => {
  const rows = buildMonthlyRiskRows();
  const by = (client: string) => rows.find((r) => r.client_organization_name === client)!;

  it("荷主 × 拠点ごとに1行、3行になる", () => {
    expect(rows).toHaveLength(3);
  });

  it("架空水産: 7訪問・合計451分・待機料12,300円（30分控除は1回ごと）・高", () => {
    const r = by("架空水産");
    expect(r.total_visits).toBe(7);
    expect(r.total_wait_minutes).toBe(451);
    expect(r.estimated_loss_jpy).toBe(12300);
    expect(r.gmen_risk_level).toBe("高");
  });

  it("架空冷蔵: 算定できない訪問は件数に数えるが、合計と平均には入れない・中", () => {
    const r = by("架空冷蔵");
    expect(r.total_visits).toBe(6);
    expect(r.unmeasured_visits).toBe(1);
    expect(r.total_wait_minutes).toBe(168);
    expect(r.estimated_loss_jpy).toBe(1750);
    expect(r.gmen_risk_level).toBe("中");
  });

  it("架空物産: 圏外承認が1件。待機料は圏外分の55分から(55-30)×50=1,250円・低", () => {
    const r = by("架空物産");
    expect(r.approved_claim_visits).toBe(1);
    expect(r.estimated_loss_jpy).toBe(1250);
    expect(r.gmen_risk_level).toBe("低");
  });

  it("30分以下の待機だけの荷主は、待機があっても 0 円になる", () => {
    const [r] = buildMonthlyRiskRows([
      { client: "架空", location: "倉庫", waitMinutes: 20, grade: "A" },
      { client: "架空", location: "倉庫", waitMinutes: 30, grade: "A" },
    ]);
    expect(r.total_wait_minutes).toBe(50);
    expect(r.estimated_loss_jpy).toBe(0);
  });
});
