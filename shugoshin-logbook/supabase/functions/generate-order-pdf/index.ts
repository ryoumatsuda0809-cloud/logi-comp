import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { PDFDocument, rgb, degrees } from "https://esm.sh/pdf-lib@1.17.1";
import fontkit from "https://esm.sh/@pdf-lib/fontkit@1.1.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const NOTO_SANS_JP_URL =
  "https://cdn.jsdelivr.net/npm/noto-sans-japanese@1.0.0/fonts/NotoSansJP-Regular.otf";

// --- Helpers ---
const clean = (s: string | undefined | null): string =>
  (s || "")
    .replace(/^[\["']+|[\]"']+$/g, "")   // leading/trailing quotes, brackets
    .replace(/\\"/g, "")                   // escaped quotes
    .replace(/,\s*$/, "")                  // trailing comma
    .trim() || "—";

const fmtDate = (d: string | null | undefined): string => {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return `${dt.getFullYear()}年${dt.getMonth() + 1}月${dt.getDate()}日`;
};

// 取適法第3条: 支払期日は、役務の提供を受けた日から起算して60日以内（受領日を算入）。
// 定めてよい最も遅い日は受領日の59日後。src/lib/paymentDeadline.ts の latestPaymentDate と同じ計算
// （画面と書面で日付が食い違わないよう、変えるときは両方を直す。src 側にテストがある）。
const latestPaymentDate = (receivedIso: string | null | undefined): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(receivedIso || "");
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  dt.setUTCDate(dt.getUTCDate() + 59);
  return dt;
};

// created_at（UTC の時刻）を日本時間の日付で出す。0〜9時に作った発注が前日の日付にならないように。
const fmtDateJst = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (isNaN(t)) return String(iso);
  const dt = new Date(t + 9 * 60 * 60 * 1000);
  return `${dt.getUTCFullYear()}年${dt.getUTCMonth() + 1}月${dt.getUTCDate()}日`;
};

const fmtCurrency = (v: string | undefined | null): string => {
  if (!v) return "—";
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  if (isNaN(n)) return clean(v);
  return `¥${n.toLocaleString()}`;
};

// Text wrapping: split text into lines that fit within maxWidth
const wrapText = (
  text: string,
  fontSize: number,
  font: any,
  maxWidth: number,
): string[] => {
  if (!text || text === "—") return [text];
  const lines: string[] = [];
  let current = "";
  for (const char of text) {
    const test = current + char;
    const w = font.widthOfTextAtSize(test, fontSize);
    if (w > maxWidth && current.length > 0) {
      lines.push(current);
      current = char;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : ["—"];
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // [STEP 1] Auth
    console.log("[STEP 1] Auth check start");
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "認証が必要です" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const userClient = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "認証に失敗しました" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    console.log("[STEP 1] Auth OK. user_id:", user.id);

    // [STEP 2] Parse request
    console.log("[STEP 2] Parsing request body...");
    const { order_id } = await req.json();
    if (!order_id || typeof order_id !== "string") {
      return new Response(JSON.stringify({ error: "order_id が必要です" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    console.log("[STEP 2] order_id parsed:", order_id);

    // [STEP 3] Fetch order (with org name only)
    console.log("[STEP 3] Fetching order from DB...");
    const { data: order, error: orderError } = await userClient
      .from("transport_orders")
      .select("*, organizations(name)")
      .eq("id", order_id)
      .maybeSingle();

    if (orderError || !order) {
      console.error("[STEP 3] Order fetch error:", orderError);
      return new Response(JSON.stringify({ error: "発注データが見つかりません" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    console.log("[STEP 3] Order fetched OK. status:", order.status);

    // [STEP 4] Fetch org details & financials using service role (bypasses RLS)
    console.log("[STEP 4] Fetching org details & financials via service role...");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const [detailsRes, financialsRes] = await Promise.all([
      adminClient
        .from("organization_details")
        .select("phone_number, postal_code, prefecture, city, address_line1, address_line2")
        .eq("organization_id", order.organization_id)
        .maybeSingle(),
      adminClient
        .from("organization_financials")
        .select("capital_amount, employee_count, is_regulated")
        .eq("organization_id", order.organization_id)
        .maybeSingle(),
    ]);

    const orgDetails = detailsRes.data;
    const financials = financialsRes.data;
    if (detailsRes.error) console.warn("[STEP 4] Details warning:", detailsRes.error);
    if (financialsRes.error) console.warn("[STEP 4] Financials warning:", financialsRes.error);
    console.log("[STEP 4] Fetched. is_regulated:", financials?.is_regulated);

    const content = order.content_json as Record<string, string>;
    const orgName = (order as any).organizations?.name || "（未登録）";

    // [STEP 5] Load font
    let fontBytes: ArrayBuffer;
    try {
      console.log("[STEP 5] Loading font from CDN:", NOTO_SANS_JP_URL);
      const fontRes = await fetch(NOTO_SANS_JP_URL);
      if (!fontRes.ok) throw new Error(`Font HTTP error: ${fontRes.status} ${fontRes.statusText}`);
      fontBytes = await fontRes.arrayBuffer();
      console.log(`[STEP 5] Font loaded OK (${fontBytes.byteLength} bytes)`);
    } catch (fontErr: any) {
      throw new Error(`Font loading failed: ${fontErr.message}`);
    }

    // [STEP 6] Create PDF
    console.log("[STEP 6] Creating PDF document...");
    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);
    const jpFont = await pdfDoc.embedFont(fontBytes);

    const page = pdfDoc.addPage([595.28, 841.89]); // A4
    const { width, height } = page.getSize();
    const margin = 50;
    const black = rgb(0, 0, 0);
    const gray = rgb(0.4, 0.4, 0.4);
    const navy = rgb(0.06, 0.09, 0.17);
    const lineColor = rgb(0.7, 0.7, 0.7);
    const red = rgb(0.87, 0.1, 0.1);
    const orangeBg = rgb(1.0, 0.93, 0.88);
    const labelBg = rgb(0.95, 0.96, 0.97);
    const white = rgb(1, 1, 1);
    const cellPad = 6; // cell padding in pt
    console.log("[STEP 6] PDF document created.");

    // [STEP 7] Draw content
    console.log("[STEP 7] Drawing PDF content...");

    const drawText = (text: string, x: number, yPos: number, size = 10, color = black) => {
      page.drawText(text, { x, y: yPos, size, font: jpFont, color });
    };

    const drawHLine = (yLine: number, x1 = margin, x2 = width - margin) => {
      page.drawLine({ start: { x: x1, y: yLine }, end: { x: x2, y: yLine }, thickness: 0.5, color: lineColor });
    };

    const drawVLine = (xLine: number, y1: number, y2: number) => {
      page.drawLine({ start: { x: xLine, y: y1 }, end: { x: xLine, y: y2 }, thickness: 0.5, color: lineColor });
    };

    // --- DRAFT watermark ---
    if (order.status !== "approved" && order.status !== "delivered") {
      page.drawText("DRAFT", {
        x: 130, y: 380, size: 110, font: jpFont,
        color: rgb(0.82, 0.82, 0.82), opacity: 0.25, rotate: degrees(45),
      });
    }

    // ========== HEADER BAR ==========
    page.drawRectangle({ x: 0, y: height - 70, width, height: 70, color: navy });
    drawText("発注書 兼 取引条件通知書", margin, height - 42, 18, white);
    drawText("製造委託等に係る中小受託事業者に対する代金の支払の遅延等の防止に関する法律 第4条の明示", margin, height - 60, 7.5, rgb(0.7, 0.8, 0.95));

    let y = height - 90;

    // ========== DATE / ORDER NUM + HANKO ==========
    const orderNum = `Order_${order_id.slice(0, 8)}`;
    const createdDate = fmtDateJst(order.created_at);

    drawText(`発行日: ${createdDate}`, margin, y, 9, gray);
    drawText(`発注番号: ${orderNum}`, margin, y - 14, 9, gray);

    // Hanko stamps
    const stampSize = 30;
    const stampGap = 8;
    const stampStartX = width - margin - (stampSize * 3 + stampGap * 2);
    const stampY = y - 5;
    const stampLabels = ["承認", "担当", "検印"];
    for (let i = 0; i < 3; i++) {
      const sx = stampStartX + i * (stampSize + stampGap);
      page.drawRectangle({
        x: sx, y: stampY - stampSize, width: stampSize, height: stampSize,
        borderColor: gray, borderWidth: 0.8, color: white,
      });
      drawText(stampLabels[i], sx + 5, stampY - stampSize - 11, 6.5, gray);
    }

    y -= 38;

    // ========== ISSUER INFO ==========
    drawText("【発注元】", margin, y, 10, navy);
    y -= 15;
    drawText(orgName, margin, y, 11, black);
    y -= 14;
    if (orgDetails?.prefecture || orgDetails?.city || orgDetails?.address_line1) {
      drawText(`${orgDetails?.prefecture || ""}${orgDetails?.city || ""}${orgDetails?.address_line1 || ""}`, margin, y, 8.5, gray);
      y -= 12;
    }
    if (orgDetails?.phone_number) {
      drawText(`TEL: ${orgDetails.phone_number}`, margin, y, 8.5, gray);
      y -= 12;
    }
    if (financials?.is_regulated) {
      drawText("★ 特定荷主（取適法 厳格規制対象）", margin, y, 8.5, red);
      y -= 12;
    }

    y -= 8;
    drawHLine(y);
    y -= 20;

    // ========== TRADE DETAILS TABLE ==========
    drawText("■ 取引明細", margin, y, 12, navy);
    y -= 22;

    // Payment deadline calc
    // 納品日（役務の提供を受ける日）から60日以内。受領日を算入するので上限は59日後
    const latestDue = latestPaymentDate(order.delivery_due_date);
    const paymentDeadlineStr = latestDue ? fmtDate(latestDue.toISOString()) : "—";

    const tableData: Array<{
      label: string;
      value: string;
      highlight?: boolean;
      emphasize?: boolean;
    }> = [
      { label: "品目名", value: clean(content?.item_name), emphasize: true },
      { label: "数量", value: clean(content?.quantity) },
      { label: "温度帯", value: clean(order.temperature_zone || content?.temperature_zone) || "常温" },
      { label: "出発地", value: clean(content?.origin), emphasize: true },
      { label: "到着地", value: clean(content?.destination), emphasize: true },
      { label: "運賃（税抜）", value: fmtCurrency(content?.price), emphasize: true },
      { label: "委託日（発注日）", value: createdDate },
      { label: "納品日（役務の提供を受ける日）", value: fmtDate(order.delivery_due_date), emphasize: true },
      { label: "支払期日（60日以内）", value: `${paymentDeadlineStr}（役務の提供を受けた日から起算して60日以内）`, highlight: true },
    ];

    const colW = 150;
    const valX = margin + colW;
    const tableW = width - margin * 2;
    const valColW = tableW - colW;
    const lineH = 13; // line height for wrapped text

    // Pre-calculate row heights with text wrapping
    const rowMeta: Array<{
      labelLines: string[];
      valueLines: string[];
      rowH: number;
      fontSize: number;
    }> = [];

    for (const row of tableData) {
      const fontSize = row.emphasize ? 11 : 10;
      const maxValW = valColW - cellPad * 2;
      const valueLines = wrapText(row.value, fontSize, jpFont, maxValW);
      const labelLines = [row.label]; // labels are short, no wrap needed
      const textLines = Math.max(valueLines.length, labelLines.length);
      const rowH = Math.max(textLines * lineH + cellPad * 2, 26);
      rowMeta.push({ labelLines, valueLines, rowH, fontSize });
    }

    // Draw table top border
    drawHLine(y + 2);

    for (let i = 0; i < tableData.length; i++) {
      const row = tableData[i];
      const meta = rowMeta[i];
      const rowTop = y + 2;
      const rowBottom = rowTop - meta.rowH;

      if (row.highlight) {
        // Orange bg for entire row
        page.drawRectangle({ x: margin, y: rowBottom, width: tableW, height: meta.rowH, color: orangeBg });
        page.drawRectangle({ x: margin, y: rowBottom, width: colW, height: meta.rowH, color: rgb(0.98, 0.82, 0.75) });
      } else {
        // Label col gray bg
        page.drawRectangle({ x: margin, y: rowBottom, width: colW, height: meta.rowH, color: labelBg });
      }

      // Vertical divider between label and value
      drawVLine(margin + colW, rowTop, rowBottom);

      // Calculate vertical center for text
      const totalTextH = meta.valueLines.length * lineH;
      const textStartY = rowBottom + (meta.rowH + totalTextH) / 2 - lineH + 2;

      // Draw label (vertically centered)
      const labelColor = row.highlight ? red : gray;
      const labelTotalH = meta.labelLines.length * lineH;
      const labelStartY = rowBottom + (meta.rowH + labelTotalH) / 2 - lineH + 2;
      for (let li = 0; li < meta.labelLines.length; li++) {
        drawText(meta.labelLines[li], margin + cellPad, labelStartY - li * lineH, 9, labelColor);
      }

      // Draw value lines (vertically centered)
      const valColor = row.highlight ? red : black;
      for (let li = 0; li < meta.valueLines.length; li++) {
        drawText(meta.valueLines[li], valX + cellPad, textStartY - li * lineH, meta.fontSize, valColor);
      }

      // Row bottom line
      drawHLine(rowBottom);

      y = rowBottom - 2;
    }

    // Left and right borders of the table
    const tableTop = height - 90 - 38 - 8 - 20 - 22 + 2; // approximate top
    // We'll draw side borders from first row top to last row bottom
    // Already handled by individual row rectangles + horizontal lines

    y -= 18;

    // ========== RECIPIENT ==========
    drawText("【発注先（運送事業者）】", margin, y, 11, navy);
    y -= 18;
    drawText("会社名: ___________________", margin, y, 9, gray);
    drawText("担当者名: ___________________", margin + 220, y, 9, gray);
    y -= 30;
    drawHLine(y);
    y -= 25;

    // ========== SIGNATURES ==========
    drawText("発注者 署名・押印:", margin, y, 10, black);
    drawText("受注者 署名・押印:", width / 2, y, 10, black);

    // ========== LEGAL FOOTER (boxed) ==========
    const footerH = 100;
    const footerY = margin;

    page.drawRectangle({
      x: margin, y: footerY, width: tableW, height: footerH,
      borderColor: lineColor, borderWidth: 0.5, color: rgb(0.99, 0.99, 0.99),
    });

    const legalLines = [
      "■ 法的注釈（製造委託等に係る中小受託事業者に対する代金の支払の遅延等の防止に関する法律 第4条の明示）",
      "本書面は、中小受託取引適正化法（取適法。2026年1月1日施行）第4条に基づく明示事項を記載した書面です。",
      "・代金の支払期日は、役務の提供を受けた日から起算して60日以内（受領日を算入）に定めます。",
      "・支払期日までに支払わない場合、役務の提供を受けた日から60日を経過した日から支払日まで、年率14.6%の遅延利息を支払います。",
      "・本書面の記載事項に変更が生じた場合は、速やかに書面にて通知します。",
      "・代金の減額、買いたたき、不当な給付内容の変更等は禁止されています。",
      "備考: 特段の検収期間を定めない限り、役務の提供を受けた日をもって検査完了とする。",
    ];

    let fy = footerY + footerH - 14;
    for (const line of legalLines) {
      const isTitle = line.startsWith("■");
      drawText(line, margin + 8, fy, isTitle ? 8.5 : 7.5, isTitle ? navy : gray);
      fy -= 12;
    }

    console.log("[STEP 7] PDF content drawn.");

    // [STEP 8] Serialize
    console.log("[STEP 8] Serializing PDF...");
    const pdfBytes = await pdfDoc.save();
    console.log(`[STEP 8] PDF serialized (${pdfBytes.byteLength} bytes).`);

    // [STEP 9] Send
    console.log("[STEP 9] Sending PDF response.");
    return new Response(pdfBytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="Order_${order_id.slice(0, 8)}.pdf"`,
      },
    });

  } catch (e: any) {
    const errorId = crypto.randomUUID();
    console.error(`[${errorId}] generate-order-pdf FATAL error:`, e);
    return new Response(
      JSON.stringify({
        error: "PDF生成中にエラーが発生しました。",
        error_id: errorId,
        error_message: e?.message ?? String(e),
        error_stack: e?.stack ?? null,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
