import { render, screen, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import { EvidenceCollector } from "./EvidenceCollector";

// useAuth をモック: Supabase Auth 接続を完全にバイパス
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "test-uid", email: "driver@test.com" },
    session: null,
    loading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
  }),
}));

// supabase クライアントをモック: 実ネットワーク接続を防ぐ
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    auth: {
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
    },
    // 状態復元クエリ（wait_logs）のチェーンを完全にモックする。
    // in / order / limit が欠けていると復元処理が例外で止まり、
    // 画面が「打刻状態を確認中...」のまま先に進まなくなる。
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
  },
}));

// jsdom には navigator.geolocation が存在しないためテストごとにモック差し込み
function mockGeolocation(
  behavior: "success" | "error",
  errorCode: number = 1
) {
  const watchPosition = vi.fn().mockImplementation(
    (onSuccess: PositionCallback, onError: PositionErrorCallback) => {
      if (behavior === "success") {
        onSuccess({
          coords: {
            latitude: 34.123456,
            longitude: 135.456789,
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
          code: errorCode,
          message: "mock geolocation error",
          PERMISSION_DENIED: 1,
          POSITION_UNAVAILABLE: 2,
          TIMEOUT: 3,
        } as GeolocationPositionError);
      }
      return 1; // watchId
    }
  );

  Object.defineProperty(global.navigator, "geolocation", {
    value: {
      watchPosition,
      clearWatch: vi.fn(),
      getCurrentPosition: vi.fn(),
    },
    writable: true,
    configurable: true,
  });
}

describe("EvidenceCollector — GPS 状態によるUIフェイルセーフ検証", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("正常系: GPS座標取得後、打刻ボタンが活性化（enabled）される", async () => {
    mockGeolocation("success");
    render(<EvidenceCollector />);

    // position が反映されたあと "到着打刻" ボタンが enabled になること
    await waitFor(() => {
      const button = screen.getByRole("button", { name: /到着打刻/ });
      expect(button).not.toBeDisabled();
    });
  });

  it("異常系(許可拒否): GPSエラー時、Alert Destructiveが表示されボタンがdisabled（物理ロック）になる", async () => {
    mockGeolocation("error", 1 /* PERMISSION_DENIED */);
    render(<EvidenceCollector />);

    // GPS エラー Alert（role="alert"）が表示されること
    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert).toBeInTheDocument();
      expect(alert).toHaveTextContent("GPS エラー");
    });

    // 打刻ボタンが disabled であること（物理ロック）
    const button = screen.getByRole("button", { name: /GPS取得中/ });
    expect(button).toBeDisabled();
  });

  it("異常系(取得失敗): POSITION_UNAVAILABLEエラー時もAlertが表示されボタンがロックされる", async () => {
    mockGeolocation("error", 2 /* POSITION_UNAVAILABLE */);
    render(<EvidenceCollector />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    const button = screen.getByRole("button", { name: /GPS取得中/ });
    expect(button).toBeDisabled();
  });
});
