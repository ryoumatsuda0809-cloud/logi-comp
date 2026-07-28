import { renderHook, act, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import { useEvidence } from "./useEvidence";

// ── モック: useAuth ──────────────────────────────────────────────────────────
// Supabase Auth 接続を完全にバイパスし、ログイン済みユーザーを固定
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "test-uid-0001", email: "driver@logisub.co.jp" },
  }),
}));

// ── モック: supabase rpc ─────────────────────────────────────────────────────
// vi.mock はファイル先頭にホイストされるため、vi.hoisted() で参照を先行確保する
const mockRpc = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: mockRpc },
}));

// ── Geolocation ヘルパー ─────────────────────────────────────────────────────
function setupGeolocation({
  watchSuccess = true,
  getCurrentSuccess = true,
  lat = 34.123456,
  lon = 135.456789,
} = {}) {
  Object.defineProperty(global.navigator, "geolocation", {
    value: {
      watchPosition: vi
        .fn()
        .mockImplementation(
          (onSuccess: PositionCallback, onError: PositionErrorCallback) => {
            if (watchSuccess) {
              onSuccess({
                coords: {
                  latitude: lat,
                  longitude: lon,
                  accuracy: 10,
                  altitude: null,
                  altitudeAccuracy: null,
                  heading: null,
                  speed: null,
                } as GeolocationCoordinates,
                timestamp: Date.now(),
              } as GeolocationPosition);
            } else {
              onError({
                code: 1,
                message: "permission denied",
                PERMISSION_DENIED: 1,
                POSITION_UNAVAILABLE: 2,
                TIMEOUT: 3,
              } as GeolocationPositionError);
            }
            return 1; // watchId
          }
        ),
      clearWatch: vi.fn(),
      getCurrentPosition: vi
        .fn()
        .mockImplementation(
          (onSuccess: PositionCallback, onError: PositionErrorCallback) => {
            if (getCurrentSuccess) {
              onSuccess({
                coords: {
                  latitude: lat,
                  longitude: lon,
                  accuracy: 5,
                  altitude: null,
                  altitudeAccuracy: null,
                  heading: null,
                  speed: null,
                } as GeolocationCoordinates,
                timestamp: Date.now(),
              } as GeolocationPosition);
            } else {
              onError({
                code: 2,
                message: "position unavailable",
                PERMISSION_DENIED: 1,
                POSITION_UNAVAILABLE: 2,
                TIMEOUT: 3,
              } as GeolocationPositionError);
            }
          }
        ),
    },
    writable: true,
    configurable: true,
  });
}

// ────────────────────────────────────────────────────────────────────────────

describe("useEvidence — バックエンド送信の結合テスト", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc.mockReset();
  });

  // ── 正常系 ──────────────────────────────────────────────────────────────────
  it("正常系: GPS座標がRPCに正しいペイロードで渡され、lastResultが設定される", async () => {
    setupGeolocation({ lat: 34.123456, lon: 135.456789 });

    // get_nearest_facility → 施設を返す
    // issue_ticket         → 整理券データを返す
    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "get_nearest_facility") {
        return Promise.resolve({
          data: [{ id: "facility-001", name: "下関中央物流センター" }],
          error: null,
        });
      }
      if (rpcName === "issue_ticket") {
        return Promise.resolve({
          data: [
            {
              log_id: "log-abc-789",
              new_ticket_number: 7,
              new_arrival_time: "2026-04-18T09:00:00.000Z",
            },
          ],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const { result } = renderHook(() => useEvidence());

    // watchPosition により position が設定されるまで待機
    await waitFor(() => {
      expect(result.current.position).not.toBeNull();
    });

    // submitEvidence を実行 — 全 await と React state 更新が完了するまで act で包む
    await act(async () => {
      await result.current.submitEvidence();
    });

    // ① get_nearest_facility RPC に正しい緯度経度ペイロードが渡されること
    expect(mockRpc).toHaveBeenCalledWith("get_nearest_facility", {
      user_lat: 34.123456,
      user_lng: 135.456789, // 実装の coords.lon が user_lng パラメータに変換されること
    });

    // ② issue_ticket RPC に施設IDとGPS座標が渡されること
    //    座標を渡さないと wait_logs の enforce_gps_not_null トリガーに拒否され、
    //    到着打刻が記録できない（本番で実際に発生していた）
    expect(mockRpc).toHaveBeenCalledWith("issue_ticket", {
      p_facility_id: "facility-001",
      p_latitude: 34.123456,
      p_longitude: 135.456789,
    });

    // ③ lastResult にレスポンスが正しくマッピングされること
    expect(result.current.lastResult).toEqual({
      logId: "log-abc-789",
      ticketNumber: 7,
      arrivalTime: "2026-04-18T09:00:00.000Z",
      facilityName: "下関中央物流センター",
      // 届出番号未登録の施設では null（16桁の直接入力にフォールバックする）
      facilityNotificationNumber: null,
    });

    // ④ エラーなし・送信中フラグ解除
    expect(result.current.submitError).toBeNull();
    expect(result.current.isSubmitting).toBe(false);
  });

  it("施設に届出番号が登録されていればlastResultに引き継がれる（漁獲番号の自動組み立てに使う）", async () => {
    setupGeolocation();

    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "get_nearest_facility") {
        return Promise.resolve({
          data: [
            {
              id: "facility-001",
              name: "下関南風泊市場",
              notification_number: "1234567",
            },
          ],
          error: null,
        });
      }
      if (rpcName === "issue_ticket") {
        return Promise.resolve({
          data: [
            {
              log_id: "log-1",
              new_ticket_number: 1,
              new_arrival_time: "2026-07-28T09:00:00.000Z",
            },
          ],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const { result } = renderHook(() => useEvidence());
    await waitFor(() => {
      expect(result.current.position).not.toBeNull();
    });
    await act(async () => {
      await result.current.submitEvidence();
    });

    expect(result.current.lastResult?.facilityNotificationNumber).toBe("1234567");
  });

  // ── 異常系: ネットワークエラー ──────────────────────────────────────────────
  it("異常系(ネットワークエラー): 施設検索RPCが失敗した場合、エラーが握りつぶされずsubmitErrorに伝播する", async () => {
    setupGeolocation();

    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "get_nearest_facility") {
        return Promise.resolve({
          data: null,
          error: {
            message:
              "FetchError: NetworkError when attempting to fetch resource",
          },
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const { result } = renderHook(() => useEvidence());

    await waitFor(() => {
      expect(result.current.position).not.toBeNull();
    });

    await act(async () => {
      await result.current.submitEvidence();
    });

    // エラーが日本語メッセージでフロントに伝播されること
    expect(result.current.submitError).toBe(
      "拠点の検索に失敗しました。通信環境を確認してください。"
    );
    // データ汚染なし
    expect(result.current.lastResult).toBeNull();
    expect(result.current.isSubmitting).toBe(false);

    // issue_ticket が呼ばれていないこと（失敗時は後続 RPC を実行しない）
    expect(mockRpc).not.toHaveBeenCalledWith(
      "issue_ticket",
      expect.anything()
    );
  });

  // ── 異常系: RLS/ジオフェンス違反 ────────────────────────────────────────────
  it("異常系(500m圏外/RLS違反): issue_ticketがジオフェンスエラーを返した場合、エラーが正しく伝播する", async () => {
    setupGeolocation();

    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "get_nearest_facility") {
        return Promise.resolve({
          data: [{ id: "facility-999", name: "遠方倉庫" }],
          error: null,
        });
      }
      if (rpcName === "issue_ticket") {
        // DB の RAISE EXCEPTION — 500m ジオフェンス違反
        return Promise.resolve({
          data: null,
          error: {
            message: "ERROR: outside 500m geofence boundary",
            code: "P0001",
          },
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const { result } = renderHook(() => useEvidence());

    await waitFor(() => {
      expect(result.current.position).not.toBeNull();
    });

    await act(async () => {
      await result.current.submitEvidence();
    });

    // 500m 圏外エラーが日本語メッセージでフロントに表示されること
    expect(result.current.submitError).toBe(
      "500m圏外のため打刻できません。拠点の近くに移動してから再試行してください。"
    );
    expect(result.current.lastResult).toBeNull();
    expect(result.current.isSubmitting).toBe(false);
  });
});

describe("useEvidence.completeTicket — 作業完了打刻の結合テスト", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc.mockReset();
  });

  async function arriveFirst(latOverride?: number, lonOverride?: number) {
    setupGeolocation({ lat: latOverride ?? 34.1, lon: lonOverride ?? 135.4 });
    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "get_nearest_facility") {
        return Promise.resolve({
          data: [{ id: "facility-001", name: "下関中央物流センター" }],
          error: null,
        });
      }
      if (rpcName === "issue_ticket") {
        return Promise.resolve({
          data: [
            {
              log_id: "log-abc-789",
              new_ticket_number: 7,
              new_arrival_time: "2026-04-18T09:00:00.000Z",
            },
          ],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const hook = renderHook(() => useEvidence());
    await waitFor(() => {
      expect(hook.result.current.position).not.toBeNull();
    });
    await act(async () => {
      await hook.result.current.submitEvidence();
    });
    expect(hook.result.current.lastResult).not.toBeNull();
    return hook;
  }

  it("正常系: 作業完了操作その場のGPS座標がp_latitude/p_longitudeとしてRPCに渡ること", async () => {
    const { result } = await arriveFirst(34.1, 135.4);

    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "complete_ticket") {
        return Promise.resolve({
          data: [
            {
              log_id: "log-abc-789",
              completed_at: "2026-04-18T10:30:00.000Z",
              waiting_minutes: 90,
            },
          ],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    await act(async () => {
      await result.current.completeTicket({
        species: "マグロ",
        weight_kg: 120.5,
        catch_number: "SH20260720TEST01",
      });
    });

    expect(mockRpc).toHaveBeenCalledWith("complete_ticket", {
      p_log_id: "log-abc-789",
      p_latitude: 34.1,
      p_longitude: 135.4,
      p_fishery_data: {
        species: "マグロ",
        weight_kg: 120.5,
        catch_number: "SH20260720TEST01",
      },
    });

    expect(result.current.completeResult).toEqual({
      logId: "log-abc-789",
      completedAt: "2026-04-18T10:30:00.000Z",
      waitingMinutes: 90,
    });
    expect(result.current.completeError).toBeNull();
    expect(result.current.isCompleting).toBe(false);
  });

  it("cancelTicket: DBのcancel_ticket RPCを呼び、成功時にlastResultがクリアされること", async () => {
    const { result } = await arriveFirst();

    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "cancel_ticket") {
        return Promise.resolve({
          data: [{ log_id: "log-abc-789", cancelled_at: "2026-07-28T01:00:00.000Z" }],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    await act(async () => {
      await result.current.cancelTicket();
    });

    // DBへ取消が伝わること（ローカルstateのクリアだけで終わらせない）
    expect(mockRpc).toHaveBeenCalledWith("cancel_ticket", {
      p_log_id: "log-abc-789",
    });
    expect(result.current.lastResult).toBeNull();
    expect(result.current.cancelError).toBeNull();
    expect(result.current.isCancelling).toBe(false);
  });

  it("cancelTicket: 署名済みで取消拒否された場合、lastResultを消さずエラーを表示すること", async () => {
    const { result } = await arriveFirst();

    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "cancel_ticket") {
        return Promise.resolve({
          data: null,
          error: {
            message: "[法的保護] 署名済みエビデンスが存在するため、この打刻は取り消せません。",
          },
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    await act(async () => {
      await result.current.cancelTicket();
    });

    expect(result.current.cancelError).toBe(
      "この打刻は確定済みのため取り消せません。管理者にご連絡ください。"
    );
    // 取消に失敗した以上、画面上の打刻は残したままにする
    expect(result.current.lastResult).not.toBeNull();
    expect(result.current.isCancelling).toBe(false);
  });

  it("異常系: DBがGPS座標必須の[法的保護]エラーを返した場合、日本語メッセージに変換されること", async () => {
    const { result } = await arriveFirst();

    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "complete_ticket") {
        return Promise.resolve({
          data: null,
          error: { message: "[法的保護] GPS座標(latitude/longitude)は必須です。" },
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    await act(async () => {
      await result.current.completeTicket({
        species: "マグロ",
        weight_kg: 120.5,
        catch_number: "SH20260720TEST01",
      });
    });

    expect(result.current.completeError).toBe(
      "GPS座標を取得できませんでした。取得完了後に再試行してください。"
    );
    expect(result.current.completeResult).toBeNull();
    expect(result.current.isCompleting).toBe(false);
  });
});
