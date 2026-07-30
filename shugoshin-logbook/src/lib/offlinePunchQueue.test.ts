import { describe, it, expect, beforeEach, vi } from "vitest";

// supabase クライアントは完全モック化する（実ネットワーク接続なしでRPCの応答を制御）
const rpcMock = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));

import {
  enqueuePunch,
  flushPunchQueue,
  getQueue,
  getRejected,
  clearRejected,
} from "./offlinePunchQueue";

function makePunch(overrides: Partial<Parameters<typeof enqueuePunch>[0]> = {}) {
  return enqueuePunch({
    punchType: "arrival",
    claimedAt: "2026-07-30T09:00:00.000Z",
    latitude: 33.9578,
    longitude: 130.9414,
    accuracyM: 12,
    note: null,
    waitLogId: null,
    ...overrides,
  });
}

describe("offlinePunchQueue — 圏外の仮記録キュー", () => {
  beforeEach(() => {
    localStorage.clear();
    rpcMock.mockReset();
  });

  it("仮記録ごとに一意な冪等キー(clientPunchId)が発番される", () => {
    const a = makePunch();
    const b = makePunch();

    expect(a.clientPunchId).toBeTruthy();
    expect(a.clientPunchId).not.toBe(b.clientPunchId);
    expect(getQueue()).toHaveLength(2);
  });

  it("送信が成功した仮記録はキューから外れ、claimed_at が端末の主張時刻のまま渡る", async () => {
    makePunch({ claimedAt: "2026-07-30T09:00:00.000Z" });
    rpcMock.mockResolvedValue({ data: [{ punch_id: "p1" }], error: null });

    const result = await flushPunchQueue();

    expect(result).toEqual({ accepted: 1, rejected: 0, retained: 0 });
    expect(getQueue()).toHaveLength(0);

    // サーバー時刻ではなく端末の主張時刻をそのまま送っていること
    const [fnName, args] = rpcMock.mock.calls[0];
    expect(fnName).toBe("queue_offline_punch");
    expect(args.p_claimed_at).toBe("2026-07-30T09:00:00.000Z");
  });

  it("通信エラーの仮記録はキューに残り、次回に再送される", async () => {
    makePunch();
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: "TypeError: Failed to fetch" },
    });

    const result = await flushPunchQueue();

    expect(result.retained).toBe(1);
    expect(result.rejected).toBe(0);
    expect(getQueue()).toHaveLength(1);
    expect(getRejected()).toHaveLength(0);

    // 電波が戻れば同じ冪等キーで再送され、今度は受理される
    rpcMock.mockResolvedValue({ data: [{ punch_id: "p1" }], error: null });
    const retry = await flushPunchQueue();
    expect(retry.accepted).toBe(1);
    expect(getQueue()).toHaveLength(0);
  });

  it("サーバーが恒久的に拒否した仮記録はキューから外し、理由を残す（無限再送を防ぐ）", async () => {
    makePunch();
    rpcMock.mockResolvedValue({
      data: null,
      error: {
        message: "[法的保護] 30日を超える過去の打刻は申請できません。",
      },
    });

    const result = await flushPunchQueue();

    expect(result.rejected).toBe(1);
    expect(result.retained).toBe(0);
    // 何度送っても通らないためキューには残さない
    expect(getQueue()).toHaveLength(0);
    // ただし理由はドライバーに見せるため保持する
    expect(getRejected()).toHaveLength(1);
    expect(getRejected()[0].reason).toContain("30日");
  });

  it("恒久拒否と通信エラーが混在しても、それぞれ正しく振り分けられる", async () => {
    makePunch({ claimedAt: "2026-07-30T09:00:00.000Z" });
    makePunch({ claimedAt: "2026-07-30T10:00:00.000Z" });
    makePunch({ claimedAt: "2026-07-30T11:00:00.000Z" });

    rpcMock
      .mockResolvedValueOnce({ data: [{ punch_id: "p1" }], error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { message: "[法的保護] 未来の時刻は申請できません。" },
      })
      .mockResolvedValueOnce({
        data: null,
        error: { message: "NetworkError when attempting to fetch resource." },
      });

    const result = await flushPunchQueue();

    expect(result).toEqual({ accepted: 1, rejected: 1, retained: 1 });
    expect(getQueue()).toHaveLength(1);
    expect(getQueue()[0].claimedAt).toBe("2026-07-30T11:00:00.000Z");
    expect(getRejected()).toHaveLength(1);
  });

  it("キューが空のときはRPCを一度も呼ばない", async () => {
    const result = await flushPunchQueue();
    expect(result).toEqual({ accepted: 0, rejected: 0, retained: 0 });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("clearRejected で拒否リストを消せる", async () => {
    makePunch();
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: "[法的保護] GPS座標(latitude/longitude)は必須です。" },
    });
    await flushPunchQueue();
    expect(getRejected()).toHaveLength(1);

    clearRejected();
    expect(getRejected()).toHaveLength(0);
  });
});
