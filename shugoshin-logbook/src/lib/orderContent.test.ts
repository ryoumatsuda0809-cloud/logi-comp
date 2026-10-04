import { describe, expect, it } from "vitest";
import { cleanText, displayRoute, displayText, displayYen, missingForApproval, orderHintsFromText, parseYen } from "./orderContent";

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
