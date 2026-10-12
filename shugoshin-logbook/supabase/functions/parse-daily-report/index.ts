import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// TODO: [PROTOTYPE ONLY] 本番稼働時（リアルデータ取扱時）は、学習利用を防ぐため必ず有料枠の正式版モデルへ切り替えること
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent";

const SYSTEM_PROMPT = `あなたは下関の水産物流に特化したコンプライアンスAIです。
ドライバーの音声日報を聞き取り、以下の項目を正確に抽出してください。

- raw_text: 音声の文字起こし原文（できるだけ忠実に）
- summary: 日報内容の簡潔な要約（1〜2文）
- waiting_minutes: 荷待ち時間（分単位の数値。言及がなければ0）
- uncompensated_work: 無償荷役（手積み・手降ろし等の対価なし作業）の有無（true/false。言及がなければfalse）
- shipper_name: 荷主名（言及がなければ "不明"）
- formal_report: 運送業の法定乗務記録テンプレートに沿った報告文章。以下の項目を含む公的書類調の文章を生成してください：
  ・出庫時刻（言及があれば。なければ「記録なし」）
  ・到着時刻・到着場所
  ・荷待ち時間（分単位）
  ・附帯作業の有無と内容（無償荷役＝手積み・手降ろし等）
  ・休憩時間（言及があれば。なければ「記録なし」）
  ・帰庫時刻（言及があれば。なければ「記録なし」）
  フォーマット例：
  「出庫 06:30 → ○○水産到着 08:15 ／ 荷待ち 45分 ／ 附帯作業：手降ろし（無償）／ 休憩：記録なし ／ 帰庫：未定」`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    raw_text: { type: "string" },
    summary: { type: "string" },
    waiting_minutes: { type: "number" },
    uncompensated_work: { type: "boolean" },
    shipper_name: { type: "string" },
    formal_report: { type: "string" },
  },
  required: ["raw_text", "summary", "waiting_minutes", "uncompensated_work", "shipper_name", "formal_report"],
};

const ALLOWED_MIME_TYPES = [
  "audio/webm",
  "audio/mp3",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/mp4",
  "audio/aac",
  "audio/flac",
];

const MAX_BASE64_LENGTH = 10 * 1024 * 1024; // ~7.5 MB decoded

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // --- [STEP 1] Auth ---
    console.log("[STEP 1] Auth check");
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

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "無効な認証トークン" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // --- [STEP 2] Input validation ---
    console.log("[STEP 2] Input validation");
    const { audio_base64, mime_type } = await req.json();

    if (!audio_base64 || typeof audio_base64 !== "string") {
      return new Response(
        JSON.stringify({ error: "audio_base64 が必要です" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (audio_base64.length > MAX_BASE64_LENGTH) {
      return new Response(
        JSON.stringify({ error: "音声ファイルが大きすぎます（最大約7.5MB）" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const resolvedMime = mime_type && ALLOWED_MIME_TYPES.includes(mime_type)
      ? mime_type
      : "audio/webm";

    // --- [STEP 3] Gemini API call ---
    console.log("[STEP 3] Calling Gemini API");
    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
    if (!GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not configured");
    }

    const geminiResponse = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      // 鍵は URL ではなくヘッダーで渡す（URL はログやエラー文に残りやすい）
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: SYSTEM_PROMPT }],
        },
        contents: [
          {
            parts: [
              {
                inline_data: {
                  mime_type: resolvedMime,
                  data: audio_base64,
                },
              },
              {
                text: "この音声日報を解析し、指定されたJSON形式で結果を返してください。",
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    });

    // --- [STEP 4] Handle Gemini response ---
    console.log("[STEP 4] Processing Gemini response, status:", geminiResponse.status);

    if (!geminiResponse.ok) {
      const errText = await geminiResponse.text();
      console.error("Gemini API error:", geminiResponse.status, errText);

      if (geminiResponse.status === 429) {
        return new Response(
          JSON.stringify({ error: "レート制限に達しました。しばらく待ってから再試行してください。" }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({
          error: "音声解析に失敗しました",
          detail: errText,
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const geminiData = await geminiResponse.json();
    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawText) {
      console.error("No text in Gemini response:", JSON.stringify(geminiData));
      return new Response(
        JSON.stringify({ error: "AI解析結果を取得できませんでした" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const parsed = JSON.parse(rawText);
    console.log("[STEP 5] Success — returning parsed result");

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("parse-daily-report error:", e);
    return new Response(
      JSON.stringify({
        error: "処理中にエラーが発生しました",
        detail: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
