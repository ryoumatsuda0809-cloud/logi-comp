/**
 * /demo/orders の「自由入力」を解析する公開デモ専用の Edge Function（demo-parse-order）の呼び出し。
 *
 * ログイン不要・DB に書かない。supabase のクライアントは使わず、URL だけを環境変数から取る。
 * 失敗（接続できない・上限・タイムアウト・形式の誤り）はすべて DemoAiError で返す。
 * 画面側は、これを受けたら固定の例の結果に切り替える。
 */
import type { DemoAiOrderResult } from "@/demo/demoOrders";

/** 自由入力の最大文字数（Edge Function の上限と同じ） */
export const DEMO_FREE_TEXT_MAX = 200;
/** 応答を待つ上限（ミリ秒）。超えたら打ち切って固定の結果に切り替える */
export const DEMO_AI_TIMEOUT_MS = 15_000;

export class DemoAiError extends Error {
  constructor(
    message: string,
    /** 回数の上限（429）に当たったときだけ true */
    readonly rateLimited = false,
  ) {
    super(message);
    this.name = "DemoAiError";
  }
}

const isStringField = (v: unknown) => typeof v === "string";

export async function parseDemoOrderWithAi(text: string, signal?: AbortSignal): Promise<DemoAiOrderResult> {
  const base = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  if (!base) throw new DemoAiError("接続先が設定されていません");

  // 呼び出し側の中断と、時間切れの両方で止める
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEMO_AI_TIMEOUT_MS);
  signal?.addEventListener("abort", () => controller.abort());

  try {
    const res = await fetch(`${base}/functions/v1/demo-parse-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!res.ok) throw new DemoAiError(`AI解析に失敗しました（${res.status}）`, res.status === 429);

    const data = await res.json();
    if (
      !data ||
      !["item_name", "quantity", "price", "origin", "destination"].every((k) => isStringField(data[k])) ||
      !(data.payment_date === null || isStringField(data.payment_date))
    ) {
      throw new DemoAiError("AI解析の結果の形式が正しくありません");
    }
    return {
      item_name: data.item_name,
      quantity: data.quantity,
      price: data.price,
      origin: data.origin,
      destination: data.destination,
      payment_date: data.payment_date,
    };
  } catch (e) {
    if (e instanceof DemoAiError) throw e;
    throw new DemoAiError("AI解析に接続できませんでした");
  } finally {
    clearTimeout(timer);
  }
}
