import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RiskReportDocument, type ReportRow } from "./RiskReportDocument";

const row = (over: Partial<ReportRow> = {}): ReportRow => ({
  client_organization_name: "テスト荷主",
  location_name: "テスト拠点",
  report_month: "2026-09-01",
  total_visits: 3,
  unmeasured_visits: 0,
  approved_claim_visits: 0,
  total_wait_minutes: 100,
  estimated_loss_jpy: 1000,
  gmen_risk_level: "中",
  ...over,
});

const renderDoc = (rows: ReportRow[], extra: Partial<Parameters<typeof RiskReportDocument>[0]> = {}) =>
  render(
    <RiskReportDocument
      rows={rows}
      orgName="テスト運送"
      issueDate="2026年10月1日"
      selectedMonthLabel="2026年9月"
      {...extra}
    />,
  );

describe("RiskReportDocument — 実画面とデモで共用する紙面", () => {
  afterEach(cleanup);

  it("提出元・発行日・タイトルを出し、行の金額と遅延損害金（年率14.6%）を出す", () => {
    renderDoc([row()]);
    expect(screen.getByText("荷主別 取適法リスク診断レポート")).toBeTruthy();
    expect(screen.getByText("テスト運送")).toBeTruthy();
    expect(screen.getByText(/発行日: 2026年10月1日/)).toBeTruthy();
    expect(screen.getAllByText("¥1,000").length).toBeGreaterThan(0);
    // 1,000円 × 12か月 × 14.6% = 1,752円
    expect(screen.getAllByText("¥1,752").length).toBeGreaterThan(0);
  });

  it("算定不可・圏外承認が混ざる場合は、注記で明示する（0円を「待機なし」と読ませない）", () => {
    renderDoc([row({ unmeasured_visits: 2, approved_claim_visits: 1 })]);
    expect(screen.getAllByText(/うち算定不可 2/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/うち圏外承認 1/).length).toBeGreaterThan(0);
    expect(screen.getByText(/待機が無かったことを意味しません（2件）/)).toBeTruthy();
    expect(screen.getByText(/時刻についてはサーバーによる自動検証が行われていません/)).toBeTruthy();
  });

  it("行が無いときは「データがありません」を出す", () => {
    renderDoc([]);
    expect(screen.getByText("データがありません")).toBeTruthy();
  });

  it("読み込み中は表を出さない", () => {
    renderDoc([row()], { loading: true });
    expect(screen.queryAllByText(/テスト拠点/).length).toBe(0);
  });

  it("位置未確認の施設での訪問は、行と注記で明示する（確認済みと同じ重みに見せない）", () => {
    renderDoc([row({ unverified_visits: 2 })]);
    expect(screen.getAllByText(/うち位置未確認 2/).length).toBeGreaterThan(0);
    expect(screen.getByText(/位置を運営者がまだ確認していない訪問です（2件）/)).toBeTruthy();
  });

  it("位置未確認が無い（古いビューで列が無い場合を含む）ときは、注記を出さない", () => {
    renderDoc([row({ unverified_visits: 0 }), row({ unverified_visits: undefined })]);
    expect(screen.queryByText(/位置未確認/)).toBeNull();
  });
});
