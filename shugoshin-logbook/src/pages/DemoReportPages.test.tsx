import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import DemoReport from "./DemoReport";
import DemoWarningReport from "./DemoWarningReport";

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/demo/report" element={<DemoReport />} />
        <Route path="/demo/warning" element={<DemoWarningReport />} />
      </Routes>
    </MemoryRouter>,
  );

describe.each([
  ["/demo/report", "報告書"],
  ["/demo/warning", "警告"],
])("%s", (path, currentLabel) => {
  it("共通ヘッダーの戻るボタンと、現在地を示す下ナビ（他のデモ画面へ行ける）がある", () => {
    renderAt(path);
    expect(screen.getByRole("button", { name: "戻る" })).toBeInTheDocument();
    expect(screen.queryByText("デモに戻る")).not.toBeInTheDocument();

    const nav = screen.getByRole("navigation");
    for (const label of ["打刻", "発注", "報告書", "警告"]) {
      expect(within(nav).getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(within(nav).getByRole("button", { name: currentLabel })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getAllByRole("button").filter((b) => b.hasAttribute("aria-current"))).toHaveLength(1);
  });

  it("印刷が動かない端末でも開けるよう、PDFの見本へのリンクがある（新しいタブで開く）", () => {
    renderAt(path);
    const link = screen.getByRole("link", { name: "PDFの見本を開く" });
    expect(link).toHaveAttribute("href", path === "/demo/report" ? "/samples/demo-report.pdf" : "/samples/demo-warning.pdf");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("ヘッダーと下ナビは印刷しない（print:hidden）", () => {
    renderAt(path);
    expect(screen.getAllByRole("banner")[0].className).toContain("print:hidden");
    expect(screen.getByRole("navigation").parentElement?.className).toContain("print:hidden");
  });
});
