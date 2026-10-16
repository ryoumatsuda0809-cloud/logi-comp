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

  it("荷主 × 拠点ごとに1行、6行になる（荷主はすべて「架空」で始まる）", () => {
    expect(rows).toHaveLength(6);
    for (const r of rows) expect(r.client_organization_name).toMatch(/^架空/);
  });

  it("架空水産: 28訪問・合計2,389分・待機料77,450円（30分控除は1回ごと）・高", () => {
    const r = by("架空水産");
    expect(r.total_visits).toBe(28);
    expect(r.total_wait_minutes).toBe(2389);
    expect(r.estimated_loss_jpy).toBe(77450);
    expect(r.gmen_risk_level).toBe("高");
  });

  it("架空漁協: 圏外承認が1件ある高リスクの荷主", () => {
    const r = by("架空漁協");
    expect(r.total_visits).toBe(22);
    expect(r.approved_claim_visits).toBe(1);
    expect(r.estimated_loss_jpy).toBe(45750);
    expect(r.gmen_risk_level).toBe("高");
  });

  it("架空冷蔵: 算定できない訪問は件数に数えるが、合計と平均には入れない・中", () => {
    const r = by("架空冷蔵");
    expect(r.total_visits).toBe(24);
    expect(r.unmeasured_visits).toBe(2);
    expect(r.total_wait_minutes).toBe(949);
    expect(r.estimated_loss_jpy).toBe(18800);
    expect(r.gmen_risk_level).toBe("中");
  });

  it("架空食品: 算定できない訪問が1件ある中リスクの荷主", () => {
    const r = by("架空食品");
    expect(r.total_visits).toBe(20);
    expect(r.unmeasured_visits).toBe(1);
    expect(r.estimated_loss_jpy).toBe(7700);
    expect(r.gmen_risk_level).toBe("中");
  });

  it("架空物産: 圏外承認が2件。待機料は圏外分の49分・47分から(19+17)×50=1,800円を含む・低", () => {
    const r = by("架空物産");
    expect(r.total_visits).toBe(26);
    expect(r.approved_claim_visits).toBe(2);
    expect(r.estimated_loss_jpy).toBe(2300);
    expect(r.gmen_risk_level).toBe("低");
  });

  it("架空商事: 待機はほぼ30分以内で、低リスク", () => {
    const r = by("架空商事");
    expect(r.total_visits).toBe(16);
    expect(r.estimated_loss_jpy).toBe(1900);
    expect(r.gmen_risk_level).toBe("低");
  });

  it("月の合計は、経営者が無視できない規模（136訪問・6,485分・153,900円）", () => {
    const sum = (f: (r: (typeof rows)[number]) => number | null) => rows.reduce((s, r) => s + (f(r) ?? 0), 0);
    expect(sum((r) => r.total_visits)).toBe(136);
    expect(sum((r) => r.total_wait_minutes)).toBe(6485);
    expect(sum((r) => r.estimated_loss_jpy)).toBe(153900);
    expect(sum((r) => r.unmeasured_visits)).toBe(3);
    expect(sum((r) => r.approved_claim_visits)).toBe(3);
    expect(new Set(rows.map((r) => r.gmen_risk_level))).toEqual(new Set(["高", "中", "低"]));
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
