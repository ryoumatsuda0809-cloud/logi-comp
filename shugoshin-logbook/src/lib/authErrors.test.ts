import { describe, it, expect } from "vitest";
import { authErrorMessage, isEmailRateLimitError } from "./authErrors";

describe("authErrorMessage — Supabase Auth エラーの日本語化", () => {
  it("メール送信上限のエラーを、利用者の操作回数のせいではないと分かる文言にする", () => {
    // GitHub issue #1 で外部から報告された実際のエラー
    const msg = authErrorMessage("email rate limit exceeded");
    expect(msg).toContain("上限");
    expect(msg).toContain("ご自身の操作回数によるものではなく");
    expect(msg).not.toContain("rate limit");
  });

  it("エラーコード形式(over_email_send_rate_limit)でも同じ扱いになる", () => {
    expect(authErrorMessage("over_email_send_rate_limit")).toContain("上限");
  });

  it("大文字小文字の違いを吸収する", () => {
    expect(authErrorMessage("Email Rate Limit Exceeded")).toContain("上限");
  });

  it("ログイン失敗を日本語にする", () => {
    expect(authErrorMessage("Invalid login credentials")).toBe(
      "メールアドレスまたはパスワードが正しくありません。"
    );
  });

  it("登録済みメールアドレスはログインへ誘導する", () => {
    expect(authErrorMessage("User already registered")).toContain("ログイン");
  });

  it("メール未確認は確認リンクを開くよう案内する", () => {
    expect(authErrorMessage("Email not confirmed")).toContain("確認メール");
  });

  it("パスワード長不足は必要な長さを伝える", () => {
    expect(
      authErrorMessage("Password should be at least 6 characters")
    ).toContain("6文字以上");
  });

  it("連続リクエスト制限は待つよう案内する", () => {
    expect(
      authErrorMessage("For security purposes, you can only request this after 45 seconds")
    ).toContain("時間をおいて");
  });

  it("未知のエラーは原文を残す（翻訳できないものを握りつぶさない）", () => {
    const unknown = "some brand new supabase error";
    expect(authErrorMessage(unknown)).toBe(unknown);
  });

  it("空・undefined でも汎用メッセージを返す", () => {
    expect(authErrorMessage(null)).toContain("失敗");
    expect(authErrorMessage(undefined)).toContain("失敗");
    expect(authErrorMessage("")).toContain("失敗");
  });
});

describe("isEmailRateLimitError — 画面に残すべきエラーかの判定", () => {
  it("メール送信上限のときだけ true", () => {
    expect(isEmailRateLimitError("email rate limit exceeded")).toBe(true);
    expect(isEmailRateLimitError("over_email_send_rate_limit")).toBe(true);
  });

  it("利用者が直せるエラーでは false（画面に残す必要がない）", () => {
    expect(isEmailRateLimitError("Invalid login credentials")).toBe(false);
    expect(isEmailRateLimitError(null)).toBe(false);
  });
});
