/**
 * 施設の登録（管理者向け）の入力検証。画面から切り出して単体テストできるようにしてある。
 *
 * ここでの検証は「入力の取りこぼしを早く知らせる」ためのもの。最終的な検証と制限
 * （権限・件数の上限・重複・座標の範囲）は、サーバーの register_facility が行う。
 * 数値は supabase/migrations/20261013100000_register_unverified_facilities.sql と一致させること。
 * 届出番号は登録時に入力させない（運営者が確認済みにするときに SQL で設定する）。
 */

export const FACILITY_NAME_MAX = 100;
export const FACILITY_CLIENT_NAME_MAX = 100;
export const FACILITY_ADDRESS_MAX = 200;
/** 組織ごとの未確認施設の上限 */
export const MAX_UNVERIFIED_FACILITIES = 20;
/** 打刻できる半径（m）。サーバー側で固定。画面では変えられない */
export const FACILITY_RADIUS_M = 500;
/** これより粗い測位では、登録位置がずれて打刻の根拠にならない */
export const MAX_REGISTRATION_ACCURACY_M = 100;

export interface RegistrationPosition {
  lat: number;
  lng: number;
  /** 測位精度（m）。取れない端末では null */
  accuracyM: number | null;
}

export interface FacilityFormInput {
  name: string;
  clientName: string;
  address: string;
  position: RegistrationPosition | null;
}

export interface FacilityFormErrors {
  name?: string;
  clientName?: string;
  address?: string;
  /** 現在地が使えない理由。登録ボタンを無効にする理由として表示する */
  position?: string;
}

export interface FacilityFormResult {
  ok: boolean;
  errors: FacilityFormErrors;
  /** ok のときだけ意味がある。前後の空白を除いた、送信する値 */
  values: {
    name: string;
    clientName: string;
    address: string | null;
    lat: number;
    lng: number;
  } | null;
}

export function validateFacilityForm(input: FacilityFormInput): FacilityFormResult {
  const name = input.name.trim();
  const clientName = input.clientName.trim();
  const address = input.address.trim();
  const errors: FacilityFormErrors = {};

  if (name.length === 0) errors.name = "施設名を入力してください。";
  else if (name.length > FACILITY_NAME_MAX) errors.name = `施設名は${FACILITY_NAME_MAX}文字以内で入力してください。`;

  if (clientName.length === 0) errors.clientName = "荷主名を入力してください。";
  else if (clientName.length > FACILITY_CLIENT_NAME_MAX)
    errors.clientName = `荷主名は${FACILITY_CLIENT_NAME_MAX}文字以内で入力してください。`;

  if (address.length > FACILITY_ADDRESS_MAX)
    errors.address = `住所は${FACILITY_ADDRESS_MAX}文字以内で入力してください。`;

  const positionError = describePositionProblem(input.position);
  if (positionError) errors.position = positionError;

  const ok = Object.keys(errors).length === 0 && input.position !== null;
  return {
    ok,
    errors,
    values:
      ok && input.position
        ? {
            name,
            clientName,
            address: address.length > 0 ? address : null,
            lat: input.position.lat,
            lng: input.position.lng,
          }
        : null,
  };
}

/** 現在地がそのまま登録に使えない理由。使えるなら null */
export function describePositionProblem(position: RegistrationPosition | null): string | null {
  if (!position) {
    return "現在地を取得してから登録してください。施設の位置は、いまいる場所で記録します。";
  }
  const { lat, lng, accuracyM } = position;
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return "現在地が正しく取得できていません。もう一度取得してください。";
  }
  if (accuracyM !== null && Number.isFinite(accuracyM) && accuracyM > MAX_REGISTRATION_ACCURACY_M) {
    return `現在地の精度が低いため登録できません（誤差 約${Math.round(accuracyM)}m）。屋外の開けた場所で、もう一度取得してください。`;
  }
  return null;
}

/** navigator.geolocation のエラーコードを、利用者に出せる日本語にする */
export function describeGeolocationError(code: number | undefined): string {
  switch (code) {
    case 1:
      return "位置情報の利用が許可されていません。ブラウザの設定で、このサイトの位置情報を許可してください。";
    case 2:
      return "現在地を特定できませんでした。電波の良い場所でもう一度お試しください。";
    case 3:
      return "現在地の取得に時間がかかりすぎました。もう一度お試しください。";
    default:
      return "現在地を取得できませんでした。もう一度お試しください。";
  }
}

export const GEOLOCATION_UNSUPPORTED_MESSAGE =
  "この端末・ブラウザでは位置情報を使えないため、施設を登録できません。";

export type FacilityVerificationStatus = "verified" | "unverified";

export function verificationLabel(status: string): string {
  return status === "verified" ? "確認済み" : "未確認";
}

/** 画面の件数表示用。未確認の件数と、あと何件登録できるか */
export function unverifiedQuota(unverifiedCount: number): { remaining: number; full: boolean } {
  const remaining = Math.max(0, MAX_UNVERIFIED_FACILITIES - unverifiedCount);
  return { remaining, full: remaining === 0 };
}

export const QUOTA_FULL_MESSAGE = `未確認の施設は最大${MAX_UNVERIFIED_FACILITIES}件までです。運営者の確認が済むまで、新しい施設は登録できません。`;

/**
 * 登録ボタンが押せない理由（押せるなら null）。無効なボタンには必ず理由を添える。
 * 現在地の問題を最優先で示す（ほかの項目より先に直す必要があるため）。
 */
export function registrationBlockReason(result: FacilityFormResult, quotaFull: boolean): string | null {
  if (quotaFull) return QUOTA_FULL_MESSAGE;
  if (result.ok) return null;
  const e = result.errors;
  return e.position ?? e.name ?? e.clientName ?? e.address ?? "入力内容を確認してください。";
}
