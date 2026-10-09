import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DemoOrders from "./DemoOrders";
import { DEMO_AI_FALLBACK_NOTE, DEMO_AI_NOTE, DEMO_FREE_TEXT_DISCLOSURE, DEMO_PARSE_NOTE } from "@/demo/demoOrders";
import { DemoAiError } from "@/demo/demoParseApi";

const parseMock = vi.hoisted(() => vi.fn());
vi.mock("@/demo/demoParseApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/demo/demoParseApi")>()),
  parseDemoOrderWithAi: parseMock,
}));

const renderPage = () =>
  render(
    <MemoryRouter>
      <DemoOrders />
    </MemoryRouter>,
  );

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const freeInput = () => screen.getByLabelText(/自由入力/) as HTMLTextAreaElement;

/** 自由入力に打って「AI解析」を押し、AI の応答（成功でも失敗でも）が反映されるまで待つ */
const parseFree = async (text: string) => {
  fireEvent.change(freeInput(), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "AI解析" }));
  await act(async () => {});
};

describe("DemoOrders: 自由入力のAI解析", () => {
  beforeEach(() => {
    parseMock.mockReset();
  });

  it("外部のAIに送信されることを、入力欄の下に常に示す", () => {
    renderPage();
    expect(screen.getByText(DEMO_FREE_TEXT_DISCLOSURE)).toBeTruthy();
    expect(DEMO_FREE_TEXT_DISCLOSURE).toMatch(/外部のAI/);
  });

  it("AI が解析できたら、その結果を確認用のフォームに入れる。注記は固定結果からAIの結果に変わる", async () => {
    parseMock.mockResolvedValue({
      item_name: "アジ",
      quantity: "8箱",
      price: "42000",
      origin: "下関市唐戸町（唐戸市場）",
      destination: "架空冷蔵 本社倉庫",
      payment_date: null,
    });
    renderPage();
    expect(screen.getByText(DEMO_PARSE_NOTE)).toBeTruthy();

    await parseFree("唐戸から架空冷蔵の本社倉庫まで、冷蔵のアジ8箱、運賃4万2千円、明日納品");

    expect(parseMock).toHaveBeenCalledTimes(1);
    expect(parseMock.mock.calls[0][0]).toBe("唐戸から架空冷蔵の本社倉庫まで、冷蔵のアジ8箱、運賃4万2千円、明日納品");
    expect(screen.getByText("解析結果（編集可能）")).toBeTruthy();
    expect(field("品名").value).toBe("アジ");
    expect(field("運賃（円）").value).toBe("42000");
    // 温度帯と納品日は、入力した文から読み取る（固定の例の文ではない）
    expect(screen.getByRole("radio", { name: "冷蔵" }).getAttribute("aria-checked")).toBe("true");
    expect(field("納品日").value).toBe("2026-10-04");
    expect(screen.getByText(DEMO_AI_NOTE)).toBeTruthy();
    expect(screen.queryByText(DEMO_PARSE_NOTE)).toBeNull();
    expect(screen.queryByText(new RegExp(DEMO_AI_FALLBACK_NOTE))).toBeNull();
  });

  it("AI が失敗したら、固定の例の結果に切り替え、入力した文の結果ではないと示す", async () => {
    parseMock.mockRejectedValue(new DemoAiError("AI解析に接続できませんでした"));
    renderPage();

    await parseFree("何かの発注の文");

    expect(screen.getByText("解析結果（編集可能）")).toBeTruthy();
    // 例1の固定結果
    expect(field("品名").value).toBe("ブリ");
    expect(field("運賃（円）").value).toBe("60000");
    const note = screen.getByRole("status");
    expect(note.textContent).toContain(DEMO_AI_FALLBACK_NOTE);
    expect(note.textContent).toContain("例1");
    expect(screen.queryByText(DEMO_AI_NOTE)).toBeNull();
    // 失敗しても、入力した文は消さない
    expect(freeInput().value).toBe("何かの発注の文");
  });

  it("回数の上限に当たったときも、同じように固定の結果に切り替える", async () => {
    parseMock.mockRejectedValue(new DemoAiError("AI解析に失敗しました（429）", true));
    renderPage();
    await parseFree("発注の文");
    expect(field("品名").value).toBe("ブリ");
    expect(screen.getByRole("status").textContent).toContain(DEMO_AI_FALLBACK_NOTE);
  });

  it("例文を選ぶと入力欄にその文が入る。書き換えずに解析するときは AI を呼ばない", async () => {
    renderPage();
    fireEvent.change(freeInput(), { target: { value: "途中まで打った文" } });
    fireEvent.click(screen.getByRole("button", { name: /例2/ }));
    expect(freeInput().value).toContain("冷蔵のタイ15箱");
    expect(screen.getByText(DEMO_PARSE_NOTE)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "AI解析" }));
    await act(async () => {});
    expect(parseMock).not.toHaveBeenCalled();
  });

  it("例文を書き換えたら自由入力として扱い、本物の AI に送る。固定結果の注記は消える", async () => {
    parseMock.mockResolvedValue({
      item_name: "タイ",
      quantity: "20箱",
      price: "50000",
      origin: "A",
      destination: "B",
      payment_date: null,
    });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /例2/ }));
    const edited = `${freeInput().value}（20箱に変更）`;
    fireEvent.change(freeInput(), { target: { value: edited } });
    expect(screen.queryByText(DEMO_PARSE_NOTE)).toBeNull();
    expect(screen.getByRole("button", { name: /例2/ }).getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "AI解析" }));
    await act(async () => {});
    expect(parseMock).toHaveBeenCalledTimes(1);
    expect(parseMock.mock.calls[0][0]).toBe(edited);
    expect(screen.getByText(DEMO_AI_NOTE)).toBeTruthy();
  });

  it("自由入力は200文字で切る。空白だけなら解析できない", () => {
    renderPage();
    fireEvent.change(freeInput(), { target: { value: "あ".repeat(250) } });
    expect(freeInput().value).toHaveLength(200);

    fireEvent.change(freeInput(), { target: { value: "   " } });
    expect((screen.getByRole("button", { name: "AI解析" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("解析を待っているあいだに「最初の状態に戻す」と、あとから結果が現れない", async () => {
    let resolve!: (v: unknown) => void;
    parseMock.mockReturnValue(new Promise((r) => (resolve = r)));
    renderPage();

    fireEvent.change(freeInput(), { target: { value: "発注の文" } });
    fireEvent.click(screen.getByRole("button", { name: "AI解析" }));
    expect(screen.getByRole("button", { name: /解析中/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "最初の状態に戻す" }));
    resolve({ item_name: "ブリ", quantity: "1箱", price: "1000", origin: "A", destination: "B", payment_date: null });
    await act(async () => {});

    expect(screen.queryByText("解析結果（編集可能）")).toBeNull();
    expect((screen.getByRole("button", { name: "AI解析" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
