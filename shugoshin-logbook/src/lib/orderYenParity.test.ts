// 発注書 PDF（Edge Function generate-order-pdf）の運賃の読み取りは、src/lib/orderContent.ts の
// parseYen・displayYen の写し（Deno では src を import できないため）。画面と書面で金額が
// 食い違わないことを、ここで確かめる。どちらかを直したら、もう片方も直す。
import { describe, expect, it } from "vitest";
import { displayYen, parseYen } from "./orderContent";
import { fmtCurrency, parseYen as parseYenInPdf } from "../../supabase/functions/generate-order-pdf/yen";

describe("発注書PDFの運賃（fmtCurrency）", () => {
  it.each([
    ["3万円", "¥30,000"],
    ["5万5000円", "¥55,000"],
    ["３００００", "¥30,000"],
    ["30,000円", "¥30,000"],
    ["abc", "—"],
  ])("%s → %s", (input, expected) => {
    expect(fmtCurrency(input)).toBe(expected);
  });

  it.each([[null], [undefined], [""], ["不明"], ["応相談"], [Number.NaN]])("%s は読めないので「—」", (input) => {
    expect(fmtCurrency(input)).toBe("—");
  });

  it("数値で入っている運賃も読む", () => {
    expect(fmtCurrency(12000)).toBe("¥12,000");
  });
});

describe("発注書PDFの写しと src 側が同じ答えを返す", () => {
  const inputs: unknown[] = [
    "30000", "３００００", "30,000円", "¥30,000", "￥30,000", "3万円", "3.5万", "5万5000円", "5万5千円",
    "５０００", "3千円", "約3万円", "3万円くらい", "税込30000", "30000円税別", 12000, 0, -1, Number.NaN,
    "null", "不明", "応相談", "abc", "", null, undefined, "—", "3万5千5百円", "1,2,3", "10 000",
  ];
  it.each(inputs.map((v) => [String(v), v]))("%s", (_label, input) => {
    expect(parseYenInPdf(input)).toBe(parseYen(input));
    expect(fmtCurrency(input)).toBe(displayYen(input));
  });
});
