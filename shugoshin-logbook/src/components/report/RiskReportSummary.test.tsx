import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RiskReportDocument, type RiskReportRow } from "./RiskReportDocument";
import { summarizeRiskRows } from "./RiskReportSummary";
import { buildMonthlyRiskRows } from "@/demo/demoMonthlyReport";

const row = (over: Partial<RiskReportRow> = {}): RiskReportRow => ({
  client_organization_name: "架空水産",
  location_name: "第2荷捌き場",
  report_month: "2026-09-01",
  total_visits: 4,
  unmeasured_visits: 0,
  approved_claim_visits: 0,
  total_wait_minutes: 200,
  estimated_loss_jpy: 10000,
  gmen_risk_level: "高",
  ...over,
});

const renderDoc = (rows: RiskReportRow[], loading = false) =>
  render(
    <RiskReportDocument
      rows={rows}
      loading={loading}
      orgName="架空運送株式会社"
      issueDate="2026年10月3日"
      monthLabel="2026年9月"
    />,
  );

describe("summarizeRiskRows", () => {
  it("表の行を足し合わせた合計と、荷主の数を出す（null は0として数える）", () => {
    const s = summarizeRiskRows([
      row({ client_organization_name: "A", total_wait_minutes: 100, estimated_loss_jpy: 3000, total_visits: 2 }),
      row({ client_organization_name: "A", location_name: "別拠点", total_wait_minutes: 50, estimated_loss_jpy: 1000, total_visits: 1 }),
      row({ client_organization_name: "B", total_wait_minutes: null, estimated_loss_jpy: null, total_visits: null }),
    ]);
    expect(s.shipperCount).toBe(2);
    expect(s.totalWaitMinutes).toBe(150);
    expect(s.totalLossJpy).toBe(4000);
    expect(s.totalVisits).toBe(3);
  });

  it("最も大きい行は推定逸失利益で決め、同額なら待機時間が長い方、全行0円なら無し", () => {
    const a = row({ client_organization_name: "A", estimated_loss_jpy: 5000, total_wait_minutes: 60 });
    const b = row({ client_organization_name: "B", estimated_loss_jpy: 5000, total_wait_minutes: 90 });
    const c = row({ client_organization_name: "C", estimated_loss_jpy: 1000, total_wait_minutes: 500 });
    expect(summarizeRiskRows([a, b, c]).top?.client_organization_name).toBe("B");
    expect(summarizeRiskRows([row({ estimated_loss_jpy: 0 })]).top).toBeNull();
  });

  it("デモの警告レポートでは、表の合計と一致する（6,485分・¥153,900）", () => {
    const rows = buildMonthlyRiskRows();
    const s = summarizeRiskRows(rows);
    expect(s.totalWaitMinutes).toBe(rows.reduce((t, r) => t + (r.total_wait_minutes ?? 0), 0));
    expect(s.totalWaitMinutes).toBe(6485);
    expect(s.totalLossJpy).toBe(153900);
    expect(s.shipperCount).toBe(6);
    expect(s.top?.client_organization_name).toBe("架空水産");
  });
});

describe("RiskReportDocument の要約", () => {
  it("対象月・荷主数・合計と、最も大きい荷主を文にして表の上に出す", () => {
    renderDoc(buildMonthlyRiskRows());
    const section = screen.getByRole("region", { name: "要約" });
    expect(section.textContent).toContain("2026年9月：6荷主で待機は計 6485分、推定逸失利益は計 ¥153,900 です。");
    expect(section.textContent).toContain("最も大きいのは 架空水産（2389分・¥77,450・リスク高）です。");
  });

  it("算定不可・圏外承認があるときだけ、注意マーク付きの注記を出す", () => {
    const plain = renderDoc([row()]);
    expect(screen.getByRole("region", { name: "要約" }).textContent).not.toContain("を含みます");
    expect(screen.getByRole("region", { name: "要約" }).querySelector("svg")).toBeNull();
    plain.unmount();

    renderDoc([row({ unmeasured_visits: 1, approved_claim_visits: 2 })]);
    const section = screen.getByRole("region", { name: "要約" });
    expect(section.textContent).toContain("算定不可 1 件（待機が無かったことを意味しません）");
    expect(section.textContent).toContain("圏外承認 2 件（時刻の自動検証なし）");
    expect(section.querySelector("svg")).toBeTruthy();
  });

  it("行が無いとき・読み込み中は要約を出さない", () => {
    renderDoc([]);
    expect(screen.queryByRole("region", { name: "要約" })).toBeNull();
    renderDoc([row()], true);
    expect(screen.queryByRole("region", { name: "要約" })).toBeNull();
  });

  it("印刷にも出る（print:hidden を付けない）", () => {
    renderDoc([row()]);
    expect(screen.getByRole("region", { name: "要約" }).className).not.toContain("print:hidden");
  });
});
