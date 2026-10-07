import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoAiError, parseDemoOrderWithAi } from "./demoParseApi";

const okBody = {
  item_name: "ブリ",
  quantity: "20箱",
  price: "60000",
  origin: "架空水産 第2荷捌き場",
  destination: "架空冷蔵 本社倉庫",
  payment_date: null,
};

const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("parseDemoOrderWithAi", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://example.invalid");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("公開デモ専用の関数に、文だけを送る（ログイン情報は付けない）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(200, okBody));
    vi.stubGlobal("fetch", fetchMock);

    await expect(parseDemoOrderWithAi("文")).resolves.toEqual(okBody);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.invalid/functions/v1/demo-parse-order");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ text: "文" });
    expect(Object.keys(init.headers)).toEqual(["Content-Type"]);
  });

  it("回数の上限（429）は rateLimited として返す", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(429, { error: "上限" })));
    await expect(parseDemoOrderWithAi("文")).rejects.toMatchObject({ name: "DemoAiError", rateLimited: true });
  });

  it("サーバーの失敗（502 など）は DemoAiError にする", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(502, { error: "失敗" })));
    const err = await parseDemoOrderWithAi("文").catch((e) => e);
    expect(err).toBeInstanceOf(DemoAiError);
    expect(err.rateLimited).toBe(false);
  });

  it("デモ用のキーが未設定のとき（503）も DemoAiError にする（画面は固定の例の結果に切り替える）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(503, { error: "AI解析を利用できません" })));
    const err = await parseDemoOrderWithAi("文").catch((e) => e);
    expect(err).toBeInstanceOf(DemoAiError);
    expect(err.rateLimited).toBe(false);
  });

  it("返事の形が違えば、画面に使わず DemoAiError にする", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, { ...okBody, price: 60000 })));
    await expect(parseDemoOrderWithAi("文")).rejects.toBeInstanceOf(DemoAiError);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, null)));
    await expect(parseDemoOrderWithAi("文")).rejects.toBeInstanceOf(DemoAiError);
  });

  it("通信できないときも DemoAiError にする", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(parseDemoOrderWithAi("文")).rejects.toBeInstanceOf(DemoAiError);
  });

  it("接続先が設定されていないときは、通信せず DemoAiError にする", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(parseDemoOrderWithAi("文")).rejects.toBeInstanceOf(DemoAiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("時間切れで打ち切ったときも DemoAiError にする", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
        ),
      );
      const result = parseDemoOrderWithAi("文").catch((e) => e);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await result).toBeInstanceOf(DemoAiError);
    } finally {
      vi.useRealTimers();
    }
  });
});
