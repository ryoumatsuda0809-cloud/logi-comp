import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { QuantityField } from "./QuantityField";

/** 親が値を持つ形（実際の画面と同じ）。変更は onChange のモックにも流す */
const Harness = ({ initial, onChange }: { initial: string; onChange?: (v: string) => void }) => {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="q">数量</label>
      <QuantityField
        id="q"
        value={value}
        onChange={(v) => {
          setValue(v);
          onChange?.(v);
        }}
      />
      <button onClick={() => setValue("3トン")}>差し替え</button>
    </>
  );
};

const amount = () => screen.getByLabelText("数量") as HTMLInputElement;
const unit = () => screen.getByLabelText("数量の単位") as HTMLSelectElement;
const options = () => Array.from(unit().options).map((o) => o.value);

describe("QuantityField", () => {
  it("AI の結果「20箱」を、数字と単位に自動で振り分ける", () => {
    render(<Harness initial="20箱" />);
    expect(amount().value).toBe("20");
    expect(unit().value).toBe("箱");
    expect(screen.queryByText(/選んでください/)).toBeNull();
  });

  it("「２キロ」は 2 と kg になる", () => {
    render(<Harness initial="２キロ" />);
    expect(amount().value).toBe("2");
    expect(unit().value).toBe("kg");
  });

  it("選択肢は主な5つだけ。それ以外の単位は、AI が返したときだけ足される", () => {
    const { unmount } = render(<Harness initial="20箱" />);
    expect(options()).toEqual(["", "kg", "箱", "ケース", "パレット", "匹"]);
    unmount();
    render(<Harness initial="3トン" />);
    expect(options()).toEqual(["", "kg", "箱", "ケース", "パレット", "匹", "トン"]);
    expect(unit().value).toBe("トン");
  });

  it("数字だけ（12）は、単位が空で「単位を選んでください」と出る。選ぶと「12箱」が親に渡る", () => {
    const onChange = vi.fn();
    render(<Harness initial="12" onChange={onChange} />);
    expect(unit().value).toBe("");
    expect(screen.getByText("単位を選んでください")).toBeTruthy();
    expect(amount().getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(unit(), { target: { value: "箱" } });
    expect(onChange).toHaveBeenLastCalledWith("12箱");
    expect(screen.queryByText("単位を選んでください")).toBeNull();
  });

  it("読めない単位（123kgm）は選ばず、読んだ文字を理由に出す。選び直すと消える", () => {
    render(<Harness initial="123kgm" />);
    expect(unit().value).toBe("");
    expect(screen.getByText("「kgm」は単位として読み取れません。単位を選んでください")).toBeTruthy();
    fireEvent.change(unit(), { target: { value: "kg" } });
    expect(screen.queryByText(/読み取れません/)).toBeNull();
  });

  it("数字の欄には数字しか入らない。全角は半角になる", () => {
    const onChange = vi.fn();
    render(<Harness initial="" onChange={onChange} />);
    fireEvent.change(amount(), { target: { value: "１２ab" } });
    expect(amount().value).toBe("12");
    expect(onChange).toHaveBeenLastCalledWith("12");
  });

  it("数字を消すと親の値は空になる（単位だけの値は作らない）。単位の選択は残る", () => {
    const onChange = vi.fn();
    render(<Harness initial="20箱" onChange={onChange} />);
    fireEvent.change(amount(), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(unit().value).toBe("箱");
  });

  it("「20箱（500kg）」のように1つに分けられない値は、今までどおり1つの欄で、そのまま編集できる", () => {
    const onChange = vi.fn();
    render(<Harness initial="20箱（500kg）" onChange={onChange} />);
    expect(screen.queryByLabelText("数量の単位")).toBeNull();
    expect(amount().value).toBe("20箱（500kg）");
    fireEvent.change(amount(), { target: { value: "20箱" } });
    expect(onChange).toHaveBeenLastCalledWith("20箱");
  });

  it("親が別の値に差し替えると、入れ直す（AI 解析のやり直し）", () => {
    render(<Harness initial="20箱" />);
    fireEvent.click(screen.getByRole("button", { name: "差し替え" }));
    expect(amount().value).toBe("3");
    expect(unit().value).toBe("トン");
  });
});
