import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import DemoDaily from "./DemoDaily";

function setup() {
  return render(
    <MemoryRouter>
      <DemoDaily />
    </MemoryRouter>,
  );
}

const submitButton = () => screen.getByRole("button", { name: /長押しで提出する|押し続けて/ });

describe("DemoDaily — 日報の擬似提出", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("今日の合計は実際の算定ロジックの値（152分・¥3,350）", () => {
    setup();
    expect(screen.getByText(/合計待機：152分/)).toBeTruthy();
    expect(screen.getByText(/¥3,350/)).toBeTruthy();
  });

  it("文面を直しても、GPS の記録は変わらないと表示する", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "15分減らす" }));
    expect(screen.getByText(/GPS の記録 152分（変更不可）/)).toBeTruthy();
    expect(screen.getByText(/報告書の記載 137分/)).toBeTruthy();
  });

  it("途中で離したら提出されない", () => {
    setup();
    fireEvent.pointerDown(submitButton());
    act(() => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.pointerUp(submitButton());
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByText("提出済み・変更不可")).toBeNull();
  });

  it("約1秒の長押しで提出済みになり、以後は修正できない", () => {
    setup();
    fireEvent.pointerDown(submitButton());
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.getByText("提出済み・変更不可")).toBeTruthy();
    expect((screen.getByRole("button", { name: "15分増やす" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "15分減らす" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("link", { name: "荷主に渡す報告書を見る" }).getAttribute("href")).toBe("/demo/report");
  });

  it("やり直すと最初の状態に戻る", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "15分増やす" }));
    fireEvent.pointerDown(submitButton());
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    fireEvent.click(screen.getByRole("button", { name: /最初からやり直す/ }));
    expect(screen.queryByText("提出済み・変更不可")).toBeNull();
    expect(screen.queryByText(/GPS の記録 \d+分（変更不可）/)).toBeNull();
    expect(screen.getByText(/合計待機：152分/)).toBeTruthy();
  });
});
