import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SHIMONOSEKI_PLACES: Record<string, string> = {
  唐戸: "下関市唐戸町（唐戸市場）",
  南風泊: "下関市彦島西山町（南風泊市場）",
  長府: "下関市長府",
  彦島: "下関市彦島",
  新下関: "下関市秋根（新下関駅周辺）",
  下関駅: "下関市竹崎町（下関駅前）",
  幡生: "下関市幡生",
  安岡: "下関市安岡",
  小月: "下関市小月",
  王司: "下関市王司",
  川中: "下関市川中",
  勝山: "下関市勝山",
  垢田: "下関市垢田",
  吉見: "下関市吉見",
};

const MAX_TEXT_LENGTH = 1000;

// TODO: [PROTOTYPE ONLY] 本番稼働時（リアルデータ取扱時）は、複雑な商流データの正確な読み取りと学習利用防止のため、必ず有料枠の高知能正式版モデルへ切り替えること
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // --- Authentication ---
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "認証が必要です" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    );

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      return new Response(
        JSON.stringify({ error: "無効な認証トークン" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // --- Input validation ---
    const { text } = await req.json();
    if (!text || typeof text !== "string") {
      return new Response(
        JSON.stringify({ error: "テキストが必要です" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const trimmedText = text.trim();
    if (trimmedText.length === 0) {
      return new Response(
        JSON.stringify({ error: "空のテキストは処理できません" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (trimmedText.length > MAX_TEXT_LENGTH) {
      return new Response(
        JSON.stringify({ error: `テキストが長すぎます（最大${MAX_TEXT_LENGTH}文字）` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // --- AI processing ---
    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
    if (!GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not configured");
    }

    const placeDictionary = Object.entries(SHIMONOSEKI_PLACES)
      .map(([k, v]) => `${k} → ${v}`)
      .join("\n");

    const systemPrompt = `あなたは下関の水産物流に特化した発注書解析AIです。
ユーザーの入力テキストから、取適法（中小受託取引適正化法。旧下請法。2026年1月施行）の「4条書面」に必要な項目を抽出してください。

## 下関ローカル地名辞書（略称→正式住所）
${placeDictionary}

地名が略称で入力された場合、上記辞書を使って正式住所に補完してください。
辞書にない地名はそのまま返してください。

抽出する項目:
- item_name: 品名（例: フグ、アジ、サバ）
- quantity: 数量（例: 10箱、500kg）
- price: 運賃（数値、円単位。「5万円」→50000）
- origin: 出発地（地名辞書で補完）
- destination: 到着地（地名辞書で補完）
- payment_date: 支払期日（YYYY-MM-DD形式、不明ならnull）

必ず extract_order_data 関数を呼び出して結果を返してください。`;

    const response = await fetch(
      `${GEMINI_ENDPOINT}?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: systemPrompt }],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: trimmedText }],
            },
          ],
          tools: [
            {
              function_declarations: [
                {
                  name: "extract_order_data",
                  description: "発注テキストから抽出した4条書面項目を返す",
                  parameters: {
                    type: "object",
                    properties: {
                      item_name: { type: "string", description: "品名" },
                      quantity: { type: "string", description: "数量" },
                      price: { type: "string", description: "運賃（円単位の数値文字列）" },
                      origin: { type: "string", description: "出発地（正式住所）" },
                      destination: { type: "string", description: "到着地（正式住所）" },
                      payment_date: {
                        type: "string",
                        nullable: true,
                        description: "支払期日（YYYY-MM-DD、不明ならnull）",
                      },
                    },
                    required: ["item_name", "quantity", "price", "origin", "destination"],
                  },
                },
              ],
            },
          ],
          tool_config: {
            function_calling_config: {
              mode: "ANY",
              allowed_function_names: ["extract_order_data"],
            },
          },
        }),
      }
    );

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "レート制限に達しました。しばらく待ってから再試行してください。" }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: "AI利用クレジットが不足しています。" }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const errText = await response.text();
      console.error("Gemini API error:", response.status, errText);
      return new Response(
        JSON.stringify({ error: "AI解析に失敗しました" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const data = await response.json();
    const functionCall = data.candidates?.[0]?.content?.parts?.[0]?.functionCall;

    if (!functionCall?.args) {
      console.error("No function call in response:", JSON.stringify(data));
      return new Response(
        JSON.stringify({ error: "AI解析結果を取得できませんでした" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const parsed = functionCall.args;

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("parse-order error:", e);
    return new Response(
      JSON.stringify({ error: "処理中にエラーが発生しました" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
