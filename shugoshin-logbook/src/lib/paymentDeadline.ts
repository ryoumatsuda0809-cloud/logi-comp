/**
 * 取適法第3条: 代金の支払期日は、役務の提供を受けた日（物品は受領日）から起算して60日以内で、
 * できる限り短い期間内に定める。公取委・中小企業庁のテキストは「受領日を算入する」としているので、
 * 受領日を1日目と数え、定めてよい最も遅い日は受領日の59日後になる。
 *
 * 日付は yyyy-MM-dd の文字列のまま扱う。Date に通すと端末のタイムゾーンで1日ずれる。
 */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})/;
const MAX_DAYS_AFTER_RECEIPT = 59;

function parseDateOnly(iso: string): Date | null {
  const m = DATE_ONLY.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  const valid = date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
  return valid ? date : null;
}

/** 受領日（役務の提供を受けた日）から、支払期日として定めてよい最も遅い日を yyyy-MM-dd で返す */
export function latestPaymentDate(receivedIso: string): string | null {
  const received = parseDateOnly(receivedIso);
  if (!received) return null;
  received.setUTCDate(received.getUTCDate() + MAX_DAYS_AFTER_RECEIPT);
  return received.toISOString().slice(0, 10);
}

/** 定めた支払期日が、上の上限を過ぎているか。どちらかが日付として読めなければ false */
export function isPaymentDateTooLate(paymentIso: string, receivedIso: string): boolean {
  const payment = parseDateOnly(paymentIso);
  const limit = latestPaymentDate(receivedIso);
  if (!payment || !limit) return false;
  return payment.toISOString().slice(0, 10) > limit;
}
