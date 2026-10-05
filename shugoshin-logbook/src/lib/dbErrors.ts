/**
 * DB・通信のエラーを、画面に出せる日本語にする。
 *
 * 打刻・承認系の RPC は、利用者に伝えるべき理由を日本語で RAISE している。
 * そのメッセージは画面にそのまま出してよい。一方、Postgres や通信層が返す
 * 英語の生メッセージ（接続エラー・制約名・権限エラー等）は利用者に意味が伝わらず、
 * 内部の名前も漏れるため、汎用の案内に置き換える。
 */
const HAS_JAPANESE = /[぀-ヿ㐀-鿿]/;

export function toDisplayMessage(
  err: unknown,
  fallback = "処理に失敗しました。通信状況を確認して、もう一度お試しください。",
): string {
  const message =
    typeof err === "string"
      ? err
      : err && typeof err === "object" && "message" in err
        ? String((err as { message: unknown }).message ?? "")
        : "";
  return HAS_JAPANESE.test(message) ? message : fallback;
}
