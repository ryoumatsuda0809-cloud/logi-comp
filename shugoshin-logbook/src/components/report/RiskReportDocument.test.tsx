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

  it("遅延利息の列は「1日あたりの目安」と分かる見出しにし、年率を仮定した参考値であると書く", () => {
    renderDoc([row()]);
    // 表の見出し・カードの見出しに出る
    expect(screen.getAllByText(/遅延利息の目安（1日あたり）/).length).toBeGreaterThanOrEqual(BOTH);
    expect(screen.queryByText(/遅延損害金/)).toBeNull();
    expect(screen.getByText(/遅延利息の目安は、年率14\.6%を仮定して計算した参考値です。法的助言ではありません。/)).toBeTruthy();
    // 計算式の注記は画面用（折りたたみ）と印刷用の2か所に出る
    expect(screen.getAllByText(/推定逸失利益 × 年率14\.6% ÷ 365日/)).toHaveLength(2);
    expect(screen.queryByText(/取適法|中小受託|国土交通省|支払う義務/)).toBeNull();
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
    // 「待機が無かったことを意味しません」は表の上の要約に1度だけ。定義と件数は注記（画面用・印刷用）に出る
    expect(screen.getAllByText(/待機が無かったことを意味しません/)).toHaveLength(1);
    expect(screen.getAllByText(/荷待ち時間を確定できなかった訪問です（2件）/)).toHaveLength(2);
    expect(screen.getAllByText(/運行管理者が承認した訪問です/)).toHaveLength(2);
    // 「時刻の自動検証なし」は要約・注記にも出るので、フッターの文だけを指して確かめる
    expect(screen.getByText(/本資料は.*時刻の自動検証なし/)).toBeTruthy();
  });

  it("算定不可・圏外承認の行と注記には注意マークが付き、無ければ付かない", () => {
    const { container, rerender } = renderDoc([row()]);
    expect(container.querySelector("svg")).toBeNull();
    rerender(
      <RiskReportDocument
        rows={[row({ unmeasured_visits: 2, approved_claim_visits: 1 })]}
        orgName="架空運送株式会社"
        issueDate="2026年10月3日"
        monthLabel="2026年9月"
      />,
    );
    // 表とカードの内訳で 2 種 × 2、注記（画面用・印刷用）で 2 つ × 2、表の上の要約で 1 つ
    expect(container.querySelectorAll("svg")).toHaveLength(2 * BOTH + 2 * 2 + 1);
    // マークは飾りなので読み上げない。意味は隣の文が持つ
    container.querySelectorAll("svg").forEach((svg) => {
      expect(svg.getAttribute("aria-hidden")).toBe("true");
    });
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

  it("リスク判定の基準（60分以上＝高、30分以上＝中、30分未満＝低）を表の前に出す", () => {
    renderDoc([row()]);
    expect(screen.getByText(/リスク判定の見かた/).textContent).toContain("60分以上＝高、30分以上＝中、30分未満＝低");
    expect(screen.getByText(/待機時間を測れなかった訪問は除く/)).toBeTruthy();
  });

  it("判定の根拠として、算定できた訪問の平均待機を行ごとに出す（算定不可の訪問は分母に入れない）", () => {
    const { container } = renderDoc([
      row({ total_visits: 4, unmeasured_visits: 0, total_wait_minutes: 200, gmen_risk_level: "中" }),
      row({ client_organization_name: "B", total_visits: 5, unmeasured_visits: 1, total_wait_minutes: 240, gmen_risk_level: "高" }),
      row({ client_organization_name: "C", total_visits: 2, unmeasured_visits: 2, total_wait_minutes: 0, gmen_risk_level: "低" }),
    ]);
    const cards = container.querySelector("ul")!;
    expect(within(cards).getByText("平均 50分")).toBeTruthy();
    // (5-1) 件で割る: 240 ÷ 4 = 60
    expect(within(cards).getByText("平均 60分")).toBeTruthy();
    // 算定できた訪問が無ければ平均は出せない
    expect(within(cards).getByText("平均 —")).toBeTruthy();
  });

  it("平均は切り捨てて出す（59.9分は「中」の行に「60分」と出さない）", () => {
    const { container } = renderDoc([row({ total_visits: 3, unmeasured_visits: 0, total_wait_minutes: 179, gmen_risk_level: "中" })]);
    expect(within(container.querySelector("ul")!).getByText("平均 59分")).toBeTruthy();
  });

  it("注記は画面では折りたたみ、印刷には展開して出す。どちらにも同じ内容が入る", () => {
    const { container } = renderDoc([row({ unmeasured_visits: 1 })]);
    const details = container.querySelector("details")!;
    expect(details.hasAttribute("open")).toBe(false);
    expect(details.className).toContain("print:hidden");
    const printed = details.nextElementSibling!;
    expect(printed.className).toContain("hidden");
    expect(printed.className).toContain("print:block");
    expect(printed.textContent).toContain("待機料の考え方");
    expect(printed.textContent).toContain("年率14.6%");
    expect(printed.textContent).toContain("算定不可");
    expect(details.querySelector("summary")!.textContent).toBe("注記：金額の算定方法・遅延利息の目安・算定不可");
    expect(details.textContent).toContain(printed.textContent!.replace(/^注記/, ""));
  });

  it("推定逸失利益を見出しの用語にし、待機料は算定の考え方の説明にだけ使う", () => {
    renderDoc([row()]);
    expect(screen.getAllByText("推定逸失利益").length).toBeGreaterThanOrEqual(BOTH);
    expect(screen.getAllByText(/推定逸失利益は、待機料の考え方にもとづき、待機1回ごとに30分を差し引いた/)).toHaveLength(2);
    expect(screen.queryByText(/待機料は待機1回ごとに30分を控除/)).toBeNull();
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
