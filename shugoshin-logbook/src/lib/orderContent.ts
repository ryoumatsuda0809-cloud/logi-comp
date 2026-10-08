// 発注（transport_orders.content_json）の値を表示・検証するための関数。
//
// AI解析は必須項目を埋めようとして、入力に無い項目に "null" や "不明" を入れて返すことがある。
// それらは「未入力」として扱い、画面にそのまま出さない。

export const MISSING = "—";

const PLACEHOLDERS = new Set([
  "", "null", "undefined", "none", "n/a", "nan",
  "不明", "未入力", "(未入力)", "（未入力）", "未設定", "なし", "-", "—", "ー",
]);

/** 実質的な値が入っていれば、前後の空白を除いた文字列を返す。無ければ null。 */
export function cleanText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (PLACEHOLDERS.has(s.toLowerCase())) return null;
  return s;
}

/** 未入力なら「—」を返す。 */
export function displayText(value: unknown): string {
  return cleanText(value) ?? MISSING;
}

/**
 * 運賃の文字列を円の整数にする。読めなければ null。
 * 「30000」「３００００」「30,000円」「¥30,000」「3万円」「3.5万」「5万5000円」に対応。
 */
export function parseYen(value: unknown): number | null {
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
}

/** 「¥30,000」の形で返す。読めなければ「—」。 */
export function displayYen(value: unknown): string {
  const yen = parseYen(value);
  return yen === null ? MISSING : `¥${yen.toLocaleString("ja-JP")}`;
}

/** 「出発地 → 到着地」。両方とも未入力なら「—」。 */
export function displayRoute(origin: unknown, destination: unknown): string {
  const o = cleanText(origin);
  const d = cleanText(destination);
  if (!o && !d) return MISSING;
  return `${o ?? MISSING} → ${d ?? MISSING}`;
}

export type OrderFields = {
  item_name?: unknown;
  quantity?: unknown;
  price?: unknown;
  origin?: unknown;
  destination?: unknown;
};

/**
 * 承認（4条書面として確定）する前に欠けている項目の名前を返す。空配列なら承認してよい。
 * 品名・数量・運賃・出発地・到着地・納品日がそろっていないと、書面として成り立たない。
 */
export function missingForApproval(content: OrderFields, deliveryDueDate: string | null | undefined): string[] {
  const missing: string[] = [];
  if (!cleanText(content.item_name)) missing.push("品名");
  if (!cleanText(content.quantity)) missing.push("数量");
  const yen = parseYen(content.price);
  if (yen === null || yen <= 0) missing.push("運賃");
  if (!cleanText(content.origin)) missing.push("出発地");
  if (!cleanText(content.destination)) missing.push("到着地");
  if (!cleanText(deliveryDueDate)) missing.push("納品日");
  return missing;
}

/** 数量の単位として受け付けるもの（英字は大文字小文字を区別しない） */
const QUANTITY_UNITS = new Set([
  "kg", "キロ", "g", "t", "トン", "箱", "ケース", "パレット", "匹", "尾", "枚", "個", "本", "袋", "缶",
]);

// strict ではないので、ok の真偽による型の絞り込みは効かない。ok が false のときだけ reason が入る。
export type QuantityCheck = { ok: boolean; reason?: string };

/**
 * 数量が「数字＋単位」の形で、単位が決まった一覧にあるかを調べる。直さない（読めなければ理由を返す）。
 * 「20箱（500kg）」「10箱×20kg」のように複数並ぶ書き方と、全角・空白・カンマ・先頭の「約」は許す。
 * AI も人も打ち間違える（例: 「123kgm」）ので、承認の前に決まった規則で止めるために使う。
 */
export function checkQuantity(value: unknown): QuantityCheck {
  const text = cleanText(value);
  if (!text) return { ok: false, reason: "数量が入っていません" };

  const s = text.normalize("NFKC").replace(/約|およそ/g, " ").replace(/[()]/g, " ");
  const found: { num: string; unit: string }[] = [];
  const rest = s.replace(/(\d[\d,]*(?:\.\d+)?)\s*([^\d\s,、・/+×*().]+)/g, (_, num: string, unit: string) => {
    found.push({ num, unit });
    return " ";
  });

  if (found.length === 0) return { ok: false, reason: `数量は「数字＋単位」で入れてください（${text}）` };
  if (rest.replace(/[\s,、・/+×*]/g, "") !== "") {
    return { ok: false, reason: `数量の書き方を確認してください（${text}）` };
  }
  for (const { num, unit } of found) {
    const n = Number(num.replace(/,/g, ""));
    if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: `数量は0より大きい数にしてください（${text}）` };
    if (!QUANTITY_UNITS.has(unit.toLowerCase())) {
      return { ok: false, reason: `数量の単位が読み取れません（${unit}）。kg・箱・ケースなどで入れてください` };
    }
  }
  return { ok: true };
}

/** 数量が入っていて、かつ正しくないときだけ、その理由を返す。それ以外は null（空の扱いは missingForApproval）。 */
export function quantityProblem(value: unknown): string | null {
  if (!cleanText(value)) return null;
  const q = checkQuantity(value);
  return q.ok ? null : (q.reason ?? "数量を確認してください");
}

/**
 * 承認の前に、入っているが正しくない項目の理由を返す。空配列なら問題なし。
 * 空の項目は missingForApproval が扱うので、ここでは返さない。
 */
export function invalidForApproval(content: OrderFields): string[] {
  const reasons: string[] = [];
  const quantity = quantityProblem(content.quantity);
  if (quantity) reasons.push(quantity);
  return reasons;
}

/**
 * 発注の入力文から、AI解析が拾わない温度帯と納品日を読み取る。
 * 「冷凍」「冷蔵（チルド）」と、「今日・明日・明後日・M月D日・M/D」に対応する。
 * 読めないものは返さない（勝手に既定値で埋めない）。
 */
export function orderHintsFromText(
  text: string,
  today: Date = new Date(),
): { temperatureZone?: "冷凍" | "冷蔵"; deliveryDate?: string } {
  const s = text.normalize("NFKC");
  const hints: { temperatureZone?: "冷凍" | "冷蔵"; deliveryDate?: string } = {};
  if (/冷凍|フローズン/.test(s)) hints.temperatureZone = "冷凍";
  else if (/冷蔵|チルド|要冷/.test(s)) hints.temperatureZone = "冷蔵";

  const ymd = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const plus = (n: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + n);

  if (/明後日|あさって/.test(s)) hints.deliveryDate = ymd(plus(2));
  else if (/明日|あした|あす/.test(s)) hints.deliveryDate = ymd(plus(1));
  else if (/今日|本日/.test(s)) hints.deliveryDate = ymd(plus(0));
  else {
    const m = s.match(/(\d{1,2})\s*(?:月|\/)\s*(\d{1,2})\s*日?/);
    if (m) {
      const month = Number(m[1]);
      const day = Number(m[2]);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        let d = new Date(today.getFullYear(), month - 1, day);
        // 過去の日付なら来年のこととみなす（12月に「1月5日」と書いた場合など）
        if (d < plus(0)) d = new Date(today.getFullYear() + 1, month - 1, day);
        if (d.getMonth() === month - 1) hints.deliveryDate = ymd(d);
      }
    }
  }
  return hints;
}
