import { render, screen, within } from "@testing-library/react";
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

// jsdom は CSS を適用しないので、表（md 以上と印刷）とカード（md 未満）の両方が DOM に出る。
// 実際の画面では、どちらか一方だけが見える。
const BOTH = 2;

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
  it("行の金額と、遅延利息の1日あたりの目安（未払額×年率14.6%÷365）を出す", () => {
    renderDoc([row({ estimated_loss_jpy: 50000 })]);
    expect(screen.getAllByText("¥50,000")).toHaveLength(BOTH);
    // 50,000 × 0.146 ÷ 365 = 20。月次を年換算した旧式（¥87,600）は出さない
    expect(screen.getAllByText("¥20")).toHaveLength(BOTH);
    expect(screen.queryByText("¥87,600")).toBeNull();
    expect(screen.getByText("架空運送株式会社")).toBeTruthy();
  });

  it("遅延利息の1日あたりの額は円未満を四捨五入する", () => {
    renderDoc([row({ estimated_loss_jpy: 12345 })]);
    // 12,345 × 0.146 ÷ 365 = 4.938... → 5
    expect(screen.getAllByText("¥5")).toHaveLength(BOTH);
  });

  it("遅延利息の列は「1日あたりの目安」と分かる見出しにし、起算日を条文どおりに書く", () => {
    renderDoc([row()]);
    // 表の見出し・カードの見出し・注記の3か所に出る
    expect(screen.getAllByText(/遅延利息の目安（1日あたり）/).length).toBeGreaterThanOrEqual(BOTH);
    expect(screen.queryByText(/遅延損害金/)).toBeNull();
    expect(screen.getByText(/役務の提供を受けた日から起算して60日を経過した日から/)).toBeTruthy();
  });

  it("算定不可・圏外承認が無ければ注記を出さず、通常のフッターにする", () => {
    renderDoc([row()]);
    expect(screen.queryByText(/算定不可/)).toBeNull();
    expect(screen.queryByText(/圏外承認/)).toBeNull();
    expect(screen.getByText(/到着時の位置情報（GPS）とサーバー時刻にもとづく記録/)).toBeTruthy();
  });

  it("算定不可・圏外承認があれば、行と注記と区別したフッターに出す", () => {
    renderDoc([row({ unmeasured_visits: 2, approved_claim_visits: 1 })]);
    expect(screen.getAllByText("うち算定不可 2")).toHaveLength(BOTH);
    expect(screen.getAllByText("うち圏外承認 1")).toHaveLength(BOTH);
    expect(screen.getByText(/待機が無かったことを意味しません（2件）/)).toBeTruthy();
    expect(screen.getByText(/時刻の自動検証なし/)).toBeTruthy();
  });

  it("狭い画面ではカード、広い画面と印刷では表を出す。どちらにも同じ数値が入る", () => {
    const { container } = renderDoc([
      row({ client_organization_name: "架空冷蔵", location_name: "本社倉庫", total_visits: 6, total_wait_minutes: 168, estimated_loss_jpy: 1750, gmen_risk_level: "中" }),
    ]);
    const cards = container.querySelector("ul");
    const table = container.querySelector("table");
    expect(cards).toBeTruthy();
    expect(table).toBeTruthy();
    // カード: md 未満でだけ見え、印刷には出ない
    expect(cards!.className).toContain("md:hidden");
    expect(cards!.className).toContain("print:hidden");
    // 表: md 未満では隠し、md 以上と印刷では出す
    expect(table!.className).toContain("hidden");
    expect(table!.className).toContain("md:table");
    expect(table!.className).toContain("print:table");
    // カードにも、表と同じ値が入る
    expect(within(cards!).getByText(/架空冷蔵/)).toBeTruthy();
    expect(within(cards!).getByText("168分")).toBeTruthy();
    expect(within(cards!).getByText("¥1,750")).toBeTruthy();
    expect(within(cards!).getByText("¥1")).toBeTruthy();
    expect(within(cards!).getByText("中")).toBeTruthy();
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
