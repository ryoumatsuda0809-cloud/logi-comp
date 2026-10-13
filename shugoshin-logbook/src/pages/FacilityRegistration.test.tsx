import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import FacilityRegistration from "./FacilityRegistration";

const mockRpc = vi.hoisted(() => vi.fn());
const mockFacilities = vi.hoisted(() => ({ rows: [] as unknown[], error: null as unknown }));

vi.mock("@/integrations/supabase/client", () => {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.order = () => Promise.resolve({ data: mockFacilities.error ? null : mockFacilities.rows, error: mockFacilities.error });
  return { supabase: { rpc: mockRpc, from: () => chain } };
});
vi.mock("@/hooks/useOrganization", () => ({
  useOrganization: () => ({ orgId: "org-1", loading: false, refetch: vi.fn() }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

function mockGeolocation(result: "ok" | "denied" | { accuracy: number }) {
  const getCurrentPosition = vi.fn((onOk: PositionCallback, onErr: PositionErrorCallback) => {
    if (result === "denied") {
      onErr({ code: 1, message: "denied" } as GeolocationPositionError);
    } else {
      const accuracy = typeof result === "object" ? result.accuracy : 8;
      onOk({ coords: { latitude: 35.681236, longitude: 139.767125, accuracy } } as GeolocationPosition);
    }
  });
  Object.defineProperty(global.navigator, "geolocation", { value: { getCurrentPosition }, configurable: true });
  return getCurrentPosition;
}

function setup() {
  return render(
    <MemoryRouter>
      <FacilityRegistration />
    </MemoryRouter>,
  );
}

const registerButton = () => screen.getByRole("button", { name: /未確認の施設として登録する/ });
const fill = () => {
  fireEvent.change(screen.getByLabelText(/施設名/), { target: { value: "第二物流センター" } });
  fireEvent.change(screen.getByLabelText(/荷主名/), { target: { value: "株式会社サンプル" } });
};

describe("FacilityRegistration — 施設の登録", () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockRpc.mockResolvedValue({ data: "new-id", error: null });
    mockFacilities.rows = [];
    mockFacilities.error = null;
  });
  afterEach(() => cleanup());

  it("現在地を取るまでは登録できず、理由を日本語で示す", async () => {
    mockGeolocation("ok");
    setup();
    await waitFor(() => expect(screen.getByText("まだ登録した施設はありません。")).toBeTruthy());
    fill();
    expect((registerButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toMatch(/現在地を取得してから登録/);
  });

  it("位置情報が拒否されたら、登録できず理由が出る", async () => {
    mockGeolocation("denied");
    setup();
    await waitFor(() => expect(screen.getByText("まだ登録した施設はありません。")).toBeTruthy());
    fill();
    fireEvent.click(screen.getByRole("button", { name: /現在地を取得する/ }));
    expect(screen.getAllByText(/位置情報の利用が許可されていません/).length).toBeGreaterThan(0);
    expect((registerButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it("測位精度が粗いときは登録できない", async () => {
    mockGeolocation({ accuracy: 500 });
    setup();
    await waitFor(() => expect(screen.getByText("まだ登録した施設はありません。")).toBeTruthy());
    fill();
    fireEvent.click(screen.getByRole("button", { name: /現在地を取得する/ }));
    expect((registerButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(/精度が低い/).length).toBeGreaterThan(0);
  });

  it("現在地と必須項目がそろえば、register_facility を呼ぶ（半径などは送らない）", async () => {
    mockGeolocation("ok");
    setup();
    await waitFor(() => expect(screen.getByText("まだ登録した施設はありません。")).toBeTruthy());
    fill();
    fireEvent.click(screen.getByRole("button", { name: /現在地を取得する/ }));
    await waitFor(() => expect((registerButton() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(registerButton());
    await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(1));
    expect(mockRpc).toHaveBeenCalledWith("register_facility", {
      p_name: "第二物流センター",
      p_client_name: "株式会社サンプル",
      p_lat: 35.681236,
      p_lng: 139.767125,
      p_address: null,
      p_notification_number: null,
    });
  });

  it("登録済みの施設を「未確認」バッジ付きで一覧する", async () => {
    mockGeolocation("ok");
    mockFacilities.rows = [
      { id: "a", name: "A倉庫", client_name: "甲社", address: null, verification_status: "unverified", created_at: "2026-10-01T00:00:00Z" },
      { id: "b", name: "B倉庫", client_name: "乙社", address: "東京都", verification_status: "verified", created_at: "2026-09-01T00:00:00Z" },
    ];
    setup();
    await waitFor(() => expect(screen.getByText("A倉庫")).toBeTruthy());
    expect(screen.getByText("未確認")).toBeTruthy();
    expect(screen.getByText("確認済み")).toBeTruthy();
    expect(screen.getByText(/未確認 1 \/ 20件/)).toBeTruthy();
  });

  it("未確認が20件に達していたら登録できない", async () => {
    mockGeolocation("ok");
    mockFacilities.rows = Array.from({ length: 20 }, (_, i) => ({
      id: `f${i}`,
      name: `施設${i}`,
      client_name: "甲社",
      address: null,
      verification_status: "unverified",
      created_at: "2026-10-01T00:00:00Z",
    }));
    setup();
    await waitFor(() => expect(screen.getByText("施設0")).toBeTruthy());
    fill();
    fireEvent.click(screen.getByRole("button", { name: /現在地を取得する/ }));
    expect((registerButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toMatch(/最大20件/);
  });

  it("一覧を読み込めなかったら、0件と表示せず登録も止める", async () => {
    mockGeolocation("ok");
    mockFacilities.error = { message: "network" };
    setup();
    await waitFor(() => expect(screen.getByText(/読み込めませんでした/)).toBeTruthy());
    fill();
    fireEvent.click(screen.getByRole("button", { name: /現在地を取得する/ }));
    expect((registerButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("まだ登録した施設はありません。")).toBeNull();
  });
});
