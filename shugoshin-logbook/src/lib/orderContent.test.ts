import { describe, expect, it } from "vitest";
import { checkQuantity, cleanText, joinQuantity, splitQuantity, displayRoute, displayText, displayYen, invalidForApproval, missingForApproval, orderHintsFromText, parseYen } from "./orderContent";

describe("cleanText / displayText", () => {
  it("AI が埋めた仮の値は未入力として扱う", () => {
    for (const v of [null, undefined, "", "  ", "null", "NULL", "不明", "(未入力)", "（未入力）"]) {
      expect(cleanText(v)).toBeNull();
      expect(displayText(v)).toBe("—");
    }
  });
  it("実際の値は残す", () => {
    expect(displayText(" トラフグ ")).toBe("トラフグ");
  });
});

describe("parseYen", () => {
  it.each([
    ["30000", 30000],
    ["３００００", 30000],
    ["30,000円", 30000],
    ["¥30,000", 30000],
    ["3万円", 30000],
    ["3.5万", 35000],
    ["5万5000円", 55000],
    ["5万5千円", 55000],
    ["５０００", 5000],
    [12000, 12000],
  ])("%s → %d", (input, expected) => {
    expect(parseYen(input)).toBe(expected);
  });
  it.each([["null"], ["不明"], ["応相談"], [""], [null], [Number.NaN]])("%s は読めない", (input) => {
    expect(parseYen(input)).toBeNull();
  });
});

describe("displayYen / displayRoute", () => {
  it("¥NaN を出さない", () => {
    expect(displayYen("3万円")).toBe("¥30,000");
    expect(displayYen("応相談")).toBe("—");
  });
  it("null → null を出さない", () => {
    expect(displayRoute("null", "null")).toBe("—");
    expect(displayRoute("唐戸市場", null)).toBe("唐戸市場 → —");
  });
});

describe("missingForApproval", () => {
  const full = { item_name: "トラフグ", quantity: "20箱", price: "30000", origin: "唐戸市場", destination: "長府" };
  it("全部そろえば承認できる", () => {
    expect(missingForApproval(full, "2026-10-10")).toEqual([]);
  });
  it("空の発注は承認できない", () => {
    expect(missingForApproval({ item_name: "(未入力)", quantity: null, price: "0" }, null)).toEqual([
      "品名", "数量", "運賃", "出発地", "到着地", "納品日",
    ]);
  });
  it("運賃が読めなければ承認できない", () => {
    expect(missingForApproval({ ...full, price: "応相談" }, "2026-10-10")).toEqual(["運賃"]);
  });
});

describe("orderHintsFromText", () => {
  const today = new Date(2026, 9, 4); // 2026-10-04
  it("冷蔵・明日を読む", () => {
    expect(orderHintsFromText("唐戸からトラフグ20箱 冷蔵 明日納品 3万円", today)).toEqual({
      temperatureZone: "冷蔵",
      deliveryDate: "2026-10-05",
    });
  });
  it("冷凍・M月D日を読む", () => {
    expect(orderHintsFromText("冷凍マグロ 10月12日着", today)).toEqual({ temperatureZone: "冷凍", deliveryDate: "2026-10-12" });
  });
  it("過去の月日は来年とみなす", () => {
    expect(orderHintsFromText("1/5 納品", today).deliveryDate).toBe("2027-01-05");
  });
  it("書かれていなければ何も返さない", () => {
    expect(orderHintsFromText("フグ10箱を長府まで、運賃5万円", today)).toEqual({});
  });
});

describe("checkQuantity", () => {
  it.each([
    "123kg", "123 kg", "１２３ＫＧ", "10箱", "5ケース", "1.5t", "2トン", "1,000kg", "約500kg",
    "20箱（500kg）", "10箱（約50kg）", "10箱×20kg", "3パレット", "50匹", "8尾", "0.5kg",
  ])("正しい数量として通す: %s", (value) => {
    expect(checkQuantity(value)).toEqual({ ok: true });
  });

  it("読めない単位（kgm）は理由つきで拒否する", () => {
    const r = checkQuantity("123kgm");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("kgm");
  });

  it.each(["123", "kg", "たくさん", "10 boxes", "0kg", "-5kg", "123kg."])("拒否する: %s", (value) => {
    expect(checkQuantity(value).ok).toBe(false);
  });

  it("空・未入力は拒否する（空の扱いは missingForApproval と同じ）", () => {
    expect(checkQuantity("").ok).toBe(false);
    expect(checkQuantity(null).ok).toBe(false);
    expect(checkQuantity("不明").ok).toBe(false);
  });
});

describe("invalidForApproval", () => {
  it("数量が正しければ空", () => {
    expect(invalidForApproval({ quantity: "20箱" })).toEqual([]);
  });
  it("数量の単位が読めなければ理由を返す", () => {
    const r = invalidForApproval({ quantity: "123kgm" });
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("kgm");
  });
  it("数量が空なら返さない（空は missingForApproval が扱う）", () => {
    expect(invalidForApproval({ quantity: "" })).toEqual([]);
  });
});

describe("splitQuantity", () => {
  it.each([
    ["20箱", { amount: "20", unit: "箱" }],
    ["２キロ", { amount: "2", unit: "kg" }],
    ["500 KG", { amount: "500", unit: "kg" }],
    ["1,000kg", { amount: "1,000", unit: "kg" }],
    ["1.5t", { amount: "1.5", unit: "t" }],
    ["3トン", { amount: "3", unit: "トン" }],
    ["5ケース", { amount: "5", unit: "ケース" }],
  ])("数字と単位に分ける: %s", (value, expected) => {
    expect(splitQuantity(value)).toEqual(expected);
  });

  it("数字だけなら、単位は空のまま返す（選んでもらう）", () => {
    expect(splitQuantity("12")).toEqual({ amount: "12", unit: "" });
    expect(splitQuantity(12)).toEqual({ amount: "12", unit: "" });
  });

  it("読めない単位は選ばずに、読んだ文字を unreadUnit で返す", () => {
    expect(splitQuantity("123kgm")).toEqual({ amount: "123", unit: "", unreadUnit: "kgm" });
  });

  it("空なら、数字も単位も空", () => {
    expect(splitQuantity("")).toEqual({ amount: "", unit: "" });
    expect(splitQuantity(null)).toEqual({ amount: "", unit: "" });
  });

  it.each(["20箱（500kg）", "10箱×20kg", "約500kg", "たくさん", "kg"])("1つの数字と単位に分けられない書き方は null（自由入力のまま）: %s", (value) => {
    expect(splitQuantity(value)).toBeNull();
  });
});

describe("joinQuantity", () => {
  it("数字と単位をつなぐ", () => {
    expect(joinQuantity("12", "箱")).toBe("12箱");
    expect(joinQuantity(" 2.5 ", "kg")).toBe("2.5kg");
  });
  it("単位が空なら数字だけ。数字が空なら空（単位だけの値は作らない）", () => {
    expect(joinQuantity("12", "")).toBe("12");
    expect(joinQuantity("", "箱")).toBe("");
  });
  it("つないだ値は checkQuantity を通る", () => {
    expect(checkQuantity(joinQuantity("12", "箱"))).toEqual({ ok: true });
  });
});
