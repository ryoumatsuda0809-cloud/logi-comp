/**
 * 水産流通適正化法の対象判定・漁獲番号の組み立て
 *
 * 仕様の根拠は docs/CONTEXT_FISHERY_LAW.md を参照。
 *
 * 漁獲番号は乱数ではなく次の構造を持つ:
 *   届出番号(7桁) + 譲渡日 YYMMDD(6桁) + ロット番号(3桁) = 16桁
 * 前13桁はアプリ側で決まるため、ドライバーが入力するのはロット3桁のみでよい。
 *
 * また対象は特定第一種水産動植物に限られ、フグ・タイなど大半の魚種は対象外。
 * （第二種＝輸入のサバ・サンマ・マイワシ・イカは「適法漁獲等証明書」の枠組みで、
 *   本モジュールが扱う漁獲番号とは別制度のため対象外とする。）
 */

export const CATCH_NUMBER_LENGTH = 16;
export const NOTIFICATION_NUMBER_LENGTH = 7;
export const TRANSFER_DATE_LENGTH = 6;
export const LOT_NUMBER_LENGTH = 3;

export interface TargetSpecies {
  id: string;
  label: string;
  /** 適用開始日（この日以降のみ漁獲番号が必要）。法改正で追加されるため日付で判定する。 */
  effectiveFrom: string;
  /** この重量以上のみ対象（太平洋クロマグロの大型魚30kg以上など） */
  minWeightKg?: number;
  note?: string;
}

/** 特定第一種水産動植物（漁獲番号の対象） */
export const TARGET_SPECIES: TargetSpecies[] = [
  { id: "abalone", label: "アワビ", effectiveFrom: "2022-12-01" },
  { id: "sea_cucumber", label: "ナマコ", effectiveFrom: "2022-12-01" },
  {
    id: "glass_eel",
    label: "シラスウナギ",
    effectiveFrom: "2025-12-01",
    note: "全長13cm以下のウナギ",
  },
  {
    id: "pacific_bluefin_tuna",
    label: "太平洋クロマグロ",
    effectiveFrom: "2026-04-01",
    minWeightKg: 30,
    note: "大型魚（30kg以上）のみ対象",
  },
];

/** 対象外だが現場で扱う頻度が高い魚種（選択の手間を減らすため） */
export const COMMON_NON_TARGET_SPECIES = [
  "フグ",
  "タイ",
  "マグロ（クロマグロ以外）",
  "ブリ",
  "サバ",
  "アジ",
  "イカ",
  "カツオ",
];

export function findTargetSpecies(speciesId: string | undefined): TargetSpecies | undefined {
  if (!speciesId) return undefined;
  return TARGET_SPECIES.find((s) => s.id === speciesId);
}

/**
 * 漁獲番号の入力が必要かを判定する。
 * 対象魚種であっても、適用開始前・重量条件未満なら不要。
 */
export function isCatchNumberRequired(
  speciesId: string | undefined,
  weightKg: number | undefined,
  now: Date = new Date()
): boolean {
  const species = findTargetSpecies(speciesId);
  if (!species) return false;

  if (new Date(species.effectiveFrom).getTime() > now.getTime()) return false;

  if (species.minWeightKg != null) {
    if (weightKg == null || weightKg < species.minWeightKg) return false;
  }

  return true;
}

/**
 * 譲渡日を YYMMDD（日本時間）で返す。
 * 端末のタイムゾーン設定に依存しないよう Asia/Tokyo を明示する。
 */
export function formatTransferDate(d: Date): string {
  if (isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}`;
}

/**
 * 届出番号・譲渡日・ロット番号から16桁の漁獲番号を組み立てる。
 * ロット番号は3桁までゼロ埋めする。
 */
export function composeCatchNumber(
  notificationNumber: string,
  transferDate: Date,
  lotNumber: string
): string {
  const lot = (lotNumber ?? "").trim().padStart(LOT_NUMBER_LENGTH, "0");
  return `${notificationNumber}${formatTransferDate(transferDate)}${lot}`;
}

export interface CatchNumberValidation {
  ok: boolean;
  /** 構造と一致しない点。決定2によりブロックはせず警告として扱う。 */
  warnings: string[];
}

/**
 * 漁獲番号が想定構造と一致するかを検証する。
 *
 * 【重要】不一致でも保存はブロックしない（docs/CONTEXT_FISHERY_LAW.md 決定2）。
 * ドライバーは荷主が発行した番号を転記しているだけで修正権限がないため、
 * 例外的な番号形式で作業完了できなくなると業務が止まる。
 */
export function validateCatchNumber(
  value: string,
  expected: { notificationNumber?: string; transferDate?: Date } = {}
): CatchNumberValidation {
  const warnings: string[] = [];
  const v = (value ?? "").trim();

  if (v.length !== CATCH_NUMBER_LENGTH) {
    warnings.push(
      `漁獲番号は通常${CATCH_NUMBER_LENGTH}桁です（現在${v.length}桁）。`
    );
    return { ok: false, warnings };
  }

  const notif = v.slice(0, NOTIFICATION_NUMBER_LENGTH);
  const date = v.slice(
    NOTIFICATION_NUMBER_LENGTH,
    NOTIFICATION_NUMBER_LENGTH + TRANSFER_DATE_LENGTH
  );
  const lot = v.slice(NOTIFICATION_NUMBER_LENGTH + TRANSFER_DATE_LENGTH);

  if (expected.notificationNumber && notif !== expected.notificationNumber) {
    warnings.push(
      `届出番号が登録値（${expected.notificationNumber}）と異なります（入力: ${notif}）。`
    );
  }

  if (!/^\d{6}$/.test(date)) {
    warnings.push(`譲渡日の部分が数字6桁ではありません（入力: ${date}）。`);
  } else if (expected.transferDate) {
    const exp = formatTransferDate(expected.transferDate);
    if (date !== exp) {
      warnings.push(`譲渡日が打刻日（${exp}）と異なります（入力: ${date}）。`);
    }
  }

  if (!/^\d{3}$/.test(lot)) {
    warnings.push(`ロット番号が数字3桁ではありません（入力: ${lot}）。`);
  }

  return { ok: warnings.length === 0, warnings };
}
