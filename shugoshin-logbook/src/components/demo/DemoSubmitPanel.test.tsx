import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoSubmitPanel, HOLD_DURATION_MS } from "./DemoSubmitPanel";

const renderPanel = () =>
  render(
    <MemoryRouter>
      <DemoSubmitPanel />
    </MemoryRouter>,
  );

// 押している間はボタンの文字が「長押し中...」に変わるので、両方に合う名前で探す
const holdButton = () => screen.getByRole("button", { name: /長押し/ });

describe("DemoSubmitPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("長押しの途中で離すと提出されない", () => {
    renderPanel();
    fireEvent.pointerDown(holdButton());
    act(() => {
      vi.advanceTimersByTime(HOLD_DURATION_MS - 100);
    });
    fireEvent.pointerUp(holdButton());
    act(() => {
      vi.advanceTimersByTime(HOLD_DURATION_MS);
    });
    expect(screen.queryByText("本日は提出済みです")).toBeNull();
    expect(holdButton()).toBeTruthy();
  });

  it("1秒押し続けると提出済みになり、修正を試しても拒否される", () => {
    renderPanel();
    fireEvent.pointerDown(holdButton());
    act(() => {
      vi.advanceTimersByTime(HOLD_DURATION_MS);
    });
    expect(screen.getByText("本日は提出済みです")).toBeTruthy();
    expect(screen.getByText("送信済みの法定記録のため変更できません")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /長押し/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /修正してみる/ }));
    expect(screen.getByRole("alert").textContent).toContain("提出済みのため変更できません");
    expect(screen.getByRole("link", { name: "提出した報告書を見る" }).getAttribute("href")).toBe("/demo/report");
  });

  it("「最初の状態に戻す」で提出前に戻る", () => {
    renderPanel();
    fireEvent.pointerDown(holdButton());
    act(() => {
      vi.advanceTimersByTime(HOLD_DURATION_MS);
    });
    fireEvent.click(screen.getByRole("button", { name: "最初の状態に戻す" }));
    expect(screen.queryByText("本日は提出済みです")).toBeNull();
    expect(holdButton()).toBeTruthy();
  });
});
