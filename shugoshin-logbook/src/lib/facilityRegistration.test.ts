import { describe, expect, it } from "vitest";
import {
  describeGeolocationError,
  describePositionProblem,
  MAX_REGISTRATION_ACCURACY_M,
  MAX_UNVERIFIED_FACILITIES,
  QUOTA_FULL_MESSAGE,
  registrationBlockReason,
  unverifiedQuota,
  validateFacilityForm,
  verificationLabel,
  type FacilityFormInput,
} from "./facilityRegistration";

const valid: FacilityFormInput = {
  name: "第二物流センター",
  clientName: "株式会社サンプル",
  address: "",
  notificationNumber: "",
  position: { lat: 35.68, lng: 139.76, accuracyM: 12 },
};

describe("validateFacilityForm", () => {
  it("必須項目と現在地がそろえば通り、前後の空白は除かれる", () => {
    const r = validateFacilityForm({ ...valid, name: "  第二物流センター ", address: " 東京都千代田区 " });
    expect(r.ok).toBe(true);
    expect(r.values).toEqual({
      name: "第二物流センター",
      clientName: "株式会社サンプル",
      address: "東京都千代田区",
      notificationNumber: null,
      lat: 35.68,
      lng: 139.76,
    });
  });

  it("施設名・荷主名が空（空白だけ）なら通らない", () => {
    const r = validateFacilityForm({ ...valid, name: "   ", clientName: "" });
    expect(r.ok).toBe(false);
    expect(r.errors.name).toMatch(/施設名/);
    expect(r.errors.clientName).toMatch(/荷主名/);
    expect(r.values).toBeNull();
  });

  it("名前の長さの上限（100文字）を超えたら通らない", () => {
    expect(validateFacilityForm({ ...valid, name: "あ".repeat(100) }).ok).toBe(true);
    expect(validateFacilityForm({ ...valid, name: "あ".repeat(101) }).errors.name).toMatch(/100文字/);
    expect(validateFacilityForm({ ...valid, clientName: "あ".repeat(101) }).errors.clientName).toMatch(/100文字/);
    expect(validateFacilityForm({ ...valid, address: "あ".repeat(201) }).errors.address).toMatch(/200文字/);
  });

  it("届出番号は空欄か7桁の数字だけ", () => {
    expect(validateFacilityForm({ ...valid, notificationNumber: "1234567" }).ok).toBe(true);
    expect(validateFacilityForm({ ...valid, notificationNumber: "123456" }).errors.notificationNumber).toBeDefined();
    expect(validateFacilityForm({ ...valid, notificationNumber: "12345678" }).errors.notificationNumber).toBeDefined();
    expect(validateFacilityForm({ ...valid, notificationNumber: "12345ab" }).errors.notificationNumber).toBeDefined();
  });

  it("現在地が未取得なら通らず、理由が出る", () => {
    const r = validateFacilityForm({ ...valid, position: null });
    expect(r.ok).toBe(false);
    expect(r.errors.position).toMatch(/現在地/);
  });
});

describe("describePositionProblem", () => {
  it("範囲外・非数の座標は使えない", () => {
    expect(describePositionProblem({ lat: 91, lng: 0, accuracyM: 5 })).not.toBeNull();
    expect(describePositionProblem({ lat: -91, lng: 0, accuracyM: 5 })).not.toBeNull();
    expect(describePositionProblem({ lat: 0, lng: 181, accuracyM: 5 })).not.toBeNull();
    expect(describePositionProblem({ lat: 0, lng: -181, accuracyM: 5 })).not.toBeNull();
    expect(describePositionProblem({ lat: NaN, lng: 0, accuracyM: 5 })).not.toBeNull();
    expect(describePositionProblem({ lat: 0, lng: Infinity, accuracyM: 5 })).not.toBeNull();
  });

  it("境界の座標は使える", () => {
    expect(describePositionProblem({ lat: 90, lng: 180, accuracyM: 5 })).toBeNull();
    expect(describePositionProblem({ lat: -90, lng: -180, accuracyM: 5 })).toBeNull();
  });

  it("測位精度が粗いと使えない。精度が取れない端末は妨げない", () => {
    expect(describePositionProblem({ lat: 35, lng: 139, accuracyM: MAX_REGISTRATION_ACCURACY_M })).toBeNull();
    expect(describePositionProblem({ lat: 35, lng: 139, accuracyM: MAX_REGISTRATION_ACCURACY_M + 1 })).toMatch(
      /精度/,
    );
    expect(describePositionProblem({ lat: 35, lng: 139, accuracyM: null })).toBeNull();
  });
});

describe("describeGeolocationError", () => {
  it("エラーコードごとに日本語の理由を返す", () => {
    expect(describeGeolocationError(1)).toMatch(/許可/);
    expect(describeGeolocationError(2)).toMatch(/特定/);
    expect(describeGeolocationError(3)).toMatch(/時間/);
    expect(describeGeolocationError(undefined)).toMatch(/取得できませんでした/);
  });
});

describe("registrationBlockReason", () => {
  it("押せるときは理由なし", () => {
    expect(registrationBlockReason(validateFacilityForm(valid), false)).toBeNull();
  });

  it("上限に達していれば、入力が正しくても押せない", () => {
    expect(registrationBlockReason(validateFacilityForm(valid), true)).toBe(QUOTA_FULL_MESSAGE);
  });

  it("現在地が取れていなければ、その理由を最優先で示す", () => {
    const r = validateFacilityForm({ ...valid, name: "", position: null });
    expect(registrationBlockReason(r, false)).toMatch(/現在地/);
  });

  it("現在地が使えるなら、入力の不備を示す", () => {
    const r = validateFacilityForm({ ...valid, clientName: "" });
    expect(registrationBlockReason(r, false)).toMatch(/荷主名/);
  });
});

describe("unverifiedQuota / verificationLabel", () => {
  it("未確認の上限は20件で、埋まると登録できない", () => {
    expect(MAX_UNVERIFIED_FACILITIES).toBe(20);
    expect(unverifiedQuota(0)).toEqual({ remaining: 20, full: false });
    expect(unverifiedQuota(19)).toEqual({ remaining: 1, full: false });
    expect(unverifiedQuota(20)).toEqual({ remaining: 0, full: true });
    expect(unverifiedQuota(25)).toEqual({ remaining: 0, full: true });
  });

  it("状態の表示名", () => {
    expect(verificationLabel("unverified")).toBe("未確認");
    expect(verificationLabel("verified")).toBe("確認済み");
  });
});
