import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ScrollToTop from "./ScrollToTop";

function Nav() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate("/demo/report")}>報告書へ</button>
      <button onClick={() => navigate(-1)}>戻る</button>
    </>
  );
}

const renderApp = () =>
  render(
    <MemoryRouter initialEntries={["/demo"]}>
      <ScrollToTop />
      <Nav />
      <Routes>
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>,
  );

describe("ScrollToTop", () => {
  let scrollTo: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("別のページに移ると先頭に戻す", () => {
    renderApp();
    scrollTo.mockClear();
    fireEvent.click(screen.getByText("報告書へ"));
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("戻るではスクロール位置をブラウザに任せる", () => {
    renderApp();
    fireEvent.click(screen.getByText("報告書へ"));
    scrollTo.mockClear();
    fireEvent.click(screen.getByText("戻る"));
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
