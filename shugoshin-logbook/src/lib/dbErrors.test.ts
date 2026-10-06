import { describe, expect, it } from "vitest";
import { isAbortError, toDisplayMessage } from "./dbErrors";

describe("isAbortError", () => {
  it("打ち切りで止まった通信を見分ける", () => {
    expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
    // supabase.functions.invoke は元の AbortError を context に入れて返す
    expect(isAbortError({ name: "FunctionsFetchError", context: { name: "AbortError" } })).toBe(true);
  });

  it("ほかのエラーや空の値は打ち切りとみなさない", () => {
    expect(isAbortError(new Error("Failed to fetch"))).toBe(false);
    expect(isAbortError({ name: "FunctionsHttpError", context: {} })).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
  });
});

describe("toDisplayMessage", () => {
  it("RPC が日本語で返した理由はそのまま出す", () => {
    expect(toDisplayMessage({ message: "待機ログが見つからないか、操作権限がありません。" })).toBe(
      "待機ログが見つからないか、操作権限がありません。",
    );
  });

  it("英語の生メッセージは汎用の案内に置き換える", () => {
    expect(toDisplayMessage({ message: 'permission denied for table wait_logs' })).toMatch(/処理に失敗/);
    expect(toDisplayMessage(new Error("Failed to fetch"))).toMatch(/処理に失敗/);
  });

  it("メッセージが無い場合も落ちない", () => {
    expect(toDisplayMessage(null)).toMatch(/処理に失敗/);
    expect(toDisplayMessage(undefined, "代替")).toBe("代替");
  });
});
