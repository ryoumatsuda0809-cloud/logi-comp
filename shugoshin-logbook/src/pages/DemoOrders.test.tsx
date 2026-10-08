import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DemoOrders from "./DemoOrders";
import { DEMO_PARSE_DELAY_MS, DEMO_PARSE_NOTE } from "@/demo/demoOrders";

const renderPage = () =>
  render(
    <MemoryRouter>
      <DemoOrders />
    </MemoryRouter>,
  );

/** 例文を選び、「AI解析」を押して、擬似の待ち時間が過ぎるまで進める */
const parseExample = (label: RegExp) => {
  fireEvent.click(screen.getByRole("button", { name: label }));
  fireEvent.click(screen.getByRole("button", { name: "AI解析" }));
  act(() => {
    vi.advanceTimersByTime(DEMO_PARSE_DELAY_MS);
  });
};

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

/** 承認ボタン → 確認ダイアログの「承認して確定する」まで押す */
const approveWithConfirm = () => {
  fireEvent.click(screen.getByRole("button", { name: /承認・保存/ }));
  const dialog = screen.getByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "承認して確定する" }));
};

describe("DemoOrders", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("デモ用の固定結果であることを常に示し、架空データの帯と戻るリンクがある", () => {
    renderPage();
    expect(screen.getByText(DEMO_PARSE_NOTE)).toBeTruthy();
    expect(screen.getByText(/表示しているのは架空のデータです/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /デモに戻る/ }).getAttribute("href")).toBe("/demo");
  });

  it("例文を選んでAI解析すると、解析中を経て結果が出る。温度帯と納品日は入力文から読み取る", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /例1/ }));
    fireEvent.click(screen.getByRole("button", { name: "AI解析" }));

    // 待っている間は結果が出ない
    expect(screen.getByRole("button", { name: /解析中/ })).toBeTruthy();
    expect(screen.queryByText("2. 解析結果（編集可能）")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(DEMO_PARSE_DELAY_MS);
    });
    expect(screen.getByText("2. 解析結果（編集可能）")).toBeTruthy();
    expect(field("品名").value).toBe("ブリ");
    expect(field("数量").value).toBe("20箱");
    expect(field("運賃（円）").value).toBe("60000");
    // 「明日」はデモの基準日（2026-10-03）の翌日
    expect(field("納品日").value).toBe("2026-10-04");
    expect(screen.getByRole("radio", { name: "冷凍" }).getAttribute("aria-checked")).toBe("true");
    // 納品日を1日目と数えて60日以内なので、上限は59日後の12月2日（60日後の12月3日は超過）
    expect(screen.getByText("支払期限（納品日を含めて60日以内）: 2026-12-02")).toBeTruthy();
  });

  it("AI が埋めた「不明」は空欄に戻し、必須項目が空のまま承認しようとすると拒否される", () => {
    renderPage();
    parseExample(/例2/);
    expect(field("運賃（円）").value).toBe("");
    expect(field("納品日").value).toBe("2026-10-08");

    fireEvent.click(screen.getByRole("button", { name: /承認・保存/ }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("承認できません");
    expect(alert.textContent).toContain("運賃が入っていません。入力してから承認してください。");
    // 確認ダイアログは開かない
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByText("承認済み・編集不可")).toBeNull();

    // 入力すると拒否の表示は消え、承認できる
    fireEvent.change(field("運賃（円）"), { target: { value: "45000" } });
    expect(screen.queryByRole("alert")).toBeNull();
    approveWithConfirm();
    expect(screen.getByText("承認済み・編集不可")).toBeTruthy();
  });

  it("納品日が空のときも、その項目名を挙げて拒否される", () => {
    renderPage();
    parseExample(/例3/);
    expect(field("納品日").value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: /承認・保存/ }));
    expect(screen.getByRole("alert").textContent).toContain("納品日が入っていません");
  });

  it("数量の単位が読めない（123kgm）と、理由を出して承認を拒否する。直すと承認できる", () => {
    renderPage();
    parseExample(/例1/);
    fireEvent.change(field("数量"), { target: { value: "123kgm" } });
    expect(screen.getByText(/数量の単位が読み取れません（kgm）/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /承認・保存/ }));
    expect(screen.getByRole("alert").textContent).toContain("数量の単位が読み取れません（kgm）");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByText("承認済み・編集不可")).toBeNull();

    fireEvent.change(field("数量"), { target: { value: "123kg" } });
    expect(screen.queryByText(/数量の単位が読み取れません/)).toBeNull();
    approveWithConfirm();
    expect(screen.getByText("承認済み・編集不可")).toBeTruthy();
  });

  it("確認ダイアログで「やめる」と承認されない", () => {
    renderPage();
    parseExample(/例1/);
    fireEvent.click(screen.getByRole("button", { name: /承認・保存/ }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("承認すると発注書（4条書面）として確定し、内容は後から変更・削除できません。");
    fireEvent.click(within(dialog).getByRole("button", { name: "やめる" }));
    expect(screen.queryByText("承認済み・編集不可")).toBeNull();
    expect(screen.getByText("2. 解析結果（編集可能）")).toBeTruthy();
  });

  it("承認すると編集不可になり、修正を試しても拒否される。4条書面が出る", () => {
    renderPage();
    parseExample(/例1/);
    approveWithConfirm();

    expect(screen.getByText("承認済み・編集不可")).toBeTruthy();
    // 入力欄はなくなり、例文も選び直せない
    expect(screen.queryByLabelText("品名")).toBeNull();
    expect((screen.getByRole("button", { name: "AI解析" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /例2/ }) as HTMLButtonElement).disabled).toBe(true);

    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /修正してみる/ }));
    expect(screen.getByRole("alert").textContent).toContain("承認済みのデータは改ざん防止のため編集できません。");

    const doc = screen.getByRole("article", { name: /4条書面/ });
    expect(doc.textContent).toContain("発注書 兼 取引条件通知書");
    expect(doc.textContent).toContain("架空運送株式会社");
    expect(doc.textContent).toContain("ブリ");
    expect(doc.textContent).toContain("架空水産 第2荷捌き場");
    expect(doc.textContent).toContain("架空冷蔵 本社倉庫");
    expect(doc.textContent).toContain("¥60,000");
    expect(doc.textContent).toContain("2026年10月4日");
    expect(doc.textContent).toContain("2026年12月2日（役務の提供を受けた日から起算して60日以内）");
    // 法令名は取適法の正式名。フリーランス法の名称や旧法の言い方を出さない
    expect(doc.textContent).toContain("製造委託等に係る中小受託事業者に対する代金の支払の遅延等の防止に関する法律");
    expect(doc.textContent).not.toContain("特定受託事業者に係る取引の適正化等に関する法律");
    expect(doc.textContent).not.toContain("下請");
    expect(doc.textContent).not.toContain("物品受領");
    expect(doc.textContent).toContain("年率14.6%の遅延利息");
  });

  it("「最初の状態に戻す」で最初に戻り、もう一度やり直せる", () => {
    renderPage();
    parseExample(/例1/);
    approveWithConfirm();
    fireEvent.click(screen.getByRole("button", { name: /修正してみる/ }));

    fireEvent.click(screen.getByRole("button", { name: "最初の状態に戻す" }));
    expect(screen.queryByText("承認済み・編集不可")).toBeNull();
    expect(screen.queryByRole("article")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("demo-order-sentence")).toBeNull();
    expect((screen.getByRole("button", { name: "AI解析" }) as HTMLButtonElement).disabled).toBe(true);

    parseExample(/例2/);
    expect(screen.getByText("2. 解析結果（編集可能）")).toBeTruthy();
  });

  it("解析の待ち時間のあいだに戻すと、あとから結果が現れない", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /例1/ }));
    fireEvent.click(screen.getByRole("button", { name: "AI解析" }));
    fireEvent.click(screen.getByRole("button", { name: "最初の状態に戻す" }));
    act(() => {
      vi.advanceTimersByTime(DEMO_PARSE_DELAY_MS * 2);
    });
    expect(screen.queryByText("2. 解析結果（編集可能）")).toBeNull();
  });
});
