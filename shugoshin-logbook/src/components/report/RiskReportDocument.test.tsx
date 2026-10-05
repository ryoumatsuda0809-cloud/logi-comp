import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RiskReportDocument, type RiskReportRow } from "./RiskReportDocument";

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

const renderDoc = (rows: RiskReportRow[], extra: Partial<Parameters<typeof RiskReportDocument>[0]> = {}) =>
  render(
    <RiskReportDocument
      rows={rows}
      orgName="架空運送株式会社"
      issueDate="2026年10月3日"
      monthLabel="2026年9月"
      {...extra}
    />,
  );

describe("RiskReportDocument", () => {
  it("行の金額と、年率14.6%の遅延損害金（月次×12×0.146）を出す", () => {
    renderDoc([row()]);
    expect(screen.getByText("¥10,000")).toBeTruthy();
    expect(screen.getByText("¥17,520")).toBeTruthy();
    expect(screen.getByText("架空運送株式会社")).toBeTruthy();
  });

  it("算定不可・圏外承認が無ければ注記を出さず、通常のフッターにする", () => {
    renderDoc([row()]);
    expect(screen.queryByText(/算定不可/)).toBeNull();
    expect(screen.queryByText(/圏外承認/)).toBeNull();
    expect(screen.getByText(/到着時の位置情報（GPS）とサーバー時刻にもとづく記録/)).toBeTruthy();
  });

  it("算定不可・圏外承認があれば、行と注記と区別したフッターに出す", () => {
    renderDoc([row({ unmeasured_visits: 2, approved_claim_visits: 1 })]);
    expect(screen.getByText("うち算定不可 2")).toBeTruthy();
    expect(screen.getByText("うち圏外承認 1")).toBeTruthy();
    expect(screen.getByText(/待機が無かったことを意味しません（2件）/)).toBeTruthy();
    expect(screen.getByText(/時刻の自動検証なし/)).toBeTruthy();
  });

  it("行が無ければ対象月つきの「データがありません」を出す", () => {
    renderDoc([]);
    expect(screen.getByText("データがありません")).toBeTruthy();
    expect(screen.getByText(/2026年9月の完了済み打刻データがありません/)).toBeTruthy();
  });

  it("提出元が読み込み中（null）なら名前を出さない", () => {
    renderDoc([row()], { orgName: null });
    expect(screen.queryByText("架空運送株式会社")).toBeNull();
  });
});
