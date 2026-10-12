import { describe, expect, it } from "vitest";
import { invalidForApproval, missingForApproval } from "@/lib/orderContent";
import { DEMO_ORDER_EXAMPLES } from "./demoOrders";
import { orderPrecheckNotices } from "./orderPrecheck";

const complete = { item_name: "ブリ", quantity: "20箱", price: "60000", origin: "A", destination: "B" };

describe("orderPrecheckNotices", () => {
  it("そろっていれば何も出さない", () => {
    expect(orderPrecheckNotices(complete, "2026-10-04")).toEqual([]);
  });

  it("欠けている項目を1行にまとめる", () => {
    expect(orderPrecheckNotices({ ...complete, price: "", origin: "" }, "")).toEqual([
      "運賃・出発地・納品日が入っていません",
    ]);
  });

  it("入っているが正しくない数量は、欠けた項目とは別の行で理由を出す", () => {
    const notices = orderPrecheckNotices({ ...complete, quantity: "12", price: "" }, "2026-10-04");
    expect(notices).toHaveLength(2);
    expect(notices[0]).toBe("運賃が入っていません");
    expect(notices[1]).toContain("数字＋単位");
  });

  it("承認ボタンと同じ判定の結果と食い違わない（例文すべてで、欠け・不正の有無が一致する）", () => {
    for (const ex of DEMO_ORDER_EXAMPLES) {
      const date = ex.id === "no-date" ? "" : "2026-10-04";
      const content = ex.aiResult;
      const expectBlocked = missingForApproval(content, date).length > 0 || invalidForApproval(content).length > 0;
      expect(orderPrecheckNotices(content, date).length > 0).toBe(expectBlocked);
    }
  });
});
