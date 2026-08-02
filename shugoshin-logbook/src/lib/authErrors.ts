/**
 * Supabase Auth のエラーメッセージを日本語に変換する。
 *
 * 【なぜ必要か】
 * Auth 画面は Supabase のエラーをそのまま表示していたため、日本語話者の
 * ドライバーに `email rate limit exceeded` のような英語が出ていた。
 * 何が起きたのか、自分で解決できるのか、待てば直るのかが伝わらない。
 *
 * 外部からの不具合報告（GitHub issue #1）で実際に問題になったのがこのケース。
 * 本番が Supabase 組み込みのメール送信（開発用・プロジェクト単位で1時間あたり
 * ごく少数）のままだったため登録が失敗していたが、利用者にはただの英文が
 * 表示されるだけだった。
 *
 * 【方針】
 * - 利用者自身で直せるもの（入力ミス等）は、何を直せばよいかまで書く
 * - 利用者では直せないもの（送信制限等）は、待てばよいのか連絡が必要なのかを書く
 * - 未知のエラーは原文を残す。翻訳できないものを握りつぶすと調査できなくなる
 */

interface AuthErrorRule {
  /** 原文に含まれていれば該当とみなす部分文字列（小文字で比較する） */
  match: string[];
  message: string;
}

const RULES: AuthErrorRule[] = [
  {
    // Supabase Auth: over_email_send_rate_limit
    // 組み込みメール送信の制限はユーザー単位ではなくプロジェクト単位のため、
    // 「自分が何度も試したから」ではないことが分かる文言にする。
    match: ["email rate limit exceeded", "over_email_send_rate_limit"],
    message:
      "確認メールの送信数が上限に達したため、現在この操作を受け付けられません。" +
      "これはご自身の操作回数によるものではなく、システム全体の制限です。" +
      "しばらく時間をおいて再度お試しいただくか、管理者にご連絡ください。",
  },
  {
    // "For security purposes, you can only request this after N seconds."
    match: ["for security purposes", "you can only request this after"],
    message:
      "連続した操作が制限されています。少し時間をおいてから再度お試しください。",
  },
  {
    match: ["invalid login credentials"],
    message: "メールアドレスまたはパスワードが正しくありません。",
  },
  {
    match: ["user already registered", "already been registered"],
    message:
      "このメールアドレスはすでに登録されています。ログインをお試しください。",
  },
  {
    match: ["email not confirmed"],
    message:
      "メールアドレスの確認が完了していません。登録時にお送りした確認メールのリンクを開いてください。",
  },
  {
    match: ["password should be at least"],
    message: "パスワードが短すぎます。6文字以上で設定してください。",
  },
  {
    match: ["unable to validate email address", "invalid format"],
    message: "メールアドレスの形式が正しくありません。",
  },
  {
    match: ["signups not allowed", "signup is disabled"],
    message:
      "現在、新規登録を受け付けていません。管理者にご連絡ください。",
  },
  {
    match: ["failed to fetch", "networkerror", "network request failed"],
    message:
      "通信に失敗しました。電波状況を確認して再度お試しください。",
  },
];

/**
 * Supabase Auth のエラーメッセージを日本語に変換する。
 * 該当する変換規則がない場合は原文をそのまま返す。
 */
export function authErrorMessage(raw: string | null | undefined): string {
  if (!raw) return "処理に失敗しました。再度お試しください。";

  const lower = raw.toLowerCase();
  const rule = RULES.find((r) => r.match.some((m) => lower.includes(m)));

  return rule ? rule.message : raw;
}

/**
 * メール送信の上限に起因するエラーかどうか。
 * 利用者側では解決できないため、UI で追加の案内を出すために使う。
 */
export function isEmailRateLimitError(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const lower = raw.toLowerCase();
  return (
    lower.includes("email rate limit exceeded") ||
    lower.includes("over_email_send_rate_limit")
  );
}
