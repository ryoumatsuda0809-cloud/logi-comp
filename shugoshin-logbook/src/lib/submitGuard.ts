/**
 * 日報の提出ボタンを無効にする理由（無効でなければ null）。
 *
 * サーバー（submit_daily_report）は、算定の対象になる打刻（取消済みを除く wait_logs）が
 * 0 件の日の提出を拒否する。音声の申告だけでは証拠の無い 0 円の日報になるため。
 * 画面も同じ条件で、押す前に理由を出す。
 */
export function submitBlockReason(input: {
  loading: boolean;
  /** wait_logs（打刻）由来の記録があるか */
  hasWaitLogRecords: boolean;
  /** 音声・旧記録を含む、その日の記録の件数 */
  timelineLength: number;
}): string | null {
  if (input.loading) return "記録を読み込み中です";
  if (input.hasWaitLogRecords) return null;
  if (input.timelineLength > 0) {
    return "本日の打刻の記録がないため、提出できません（音声の申告だけでは提出できません）";
  }
  return "本日の打刻記録がないため、提出できません";
}
