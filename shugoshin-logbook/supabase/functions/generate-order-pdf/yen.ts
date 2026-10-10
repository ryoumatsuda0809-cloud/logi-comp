// 運賃の読み取り。src/lib/orderContent.ts の cleanText・parseYen・displayYen と同じ計算
// （画面と書面で金額が食い違わないよう、変えるときは両方を直す。
//  src/lib/orderYenParity.test.ts が、この写しと src 側が同じ答えを返すことを確かめる）。
// Deno の API を使わない（vitest からそのまま読み込めるようにするため）。

const MISSING = "—";

const PLACEHOLDERS = new Set([
  "", "null", "undefined", "none", "n/a", "nan",
  "不明", "未入力", "(未入力)", "（未入力）", "未設定", "なし", "-", "—", "ー",
]);

const cleanText = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (PLACEHOLDERS.has(s.toLowerCase())) return null;
  return s;
};

/** 運賃の文字列を円の整数にする。読めなければ null。 */
export const parseYen = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  const text = cleanText(value);
  if (!text) return null;
  const s = text.normalize("NFKC").replace(/[¥￥,\s]|円|税込|税別|くらい|程度|約/g, "");
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const man = s.match(/^(\d+(?:\.\d+)?)万(?:(\d+)千)?(\d+)?$/);
  if (man) {
    const total = Number(man[1]) * 10000 + Number(man[2] ?? 0) * 1000 + Number(man[3] ?? 0);
    return Math.round(total);
  }
  const sen = s.match(/^(\d+)千$/);
  if (sen) return Number(sen[1]) * 1000;
  return null;
};

/** 「¥30,000」の形で返す。読めなければ「—」。 */
export const fmtCurrency = (value: unknown): string => {
  const yen = parseYen(value);
  return yen === null ? MISSING : `¥${yen.toLocaleString("ja-JP")}`;
};
