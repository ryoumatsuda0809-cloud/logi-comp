import { useEffect, useRef, useState } from "react";
import { Check, FileText, Loader2, Lock, RotateCcw, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { FieldButton } from "@/components/ui/field-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/PageHeader";
import { DemoBottomNav } from "@/components/demo/DemoBottomNav";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cleanText, displayRoute, displayText, displayYen, invalidForApproval, missingForApproval, orderHintsFromText, quantityProblem } from "@/lib/orderContent";
import { latestPaymentDate } from "@/lib/paymentDeadline";
import { DemoOrderDocument, type DemoOrderDocumentData } from "@/components/demo/DemoOrderDocument";
import {
  DEMO_AI_FALLBACK_NOTE,
  DEMO_AI_NOTE,
  DEMO_FREE_TEXT_DISCLOSURE,
  DEMO_ORDER_APPROVED_AT_LABEL,
  DEMO_ORDER_EXAMPLES,
  DEMO_ORDER_TODAY,
  DEMO_ORDER_TODAY_ISO,
  DEMO_PARSE_DELAY_MS,
  DEMO_PARSE_NOTE,
  type DemoAiOrderResult,
  type DemoOrderExample,
} from "@/demo/demoOrders";
import { DEMO_FREE_TEXT_MAX, parseDemoOrderWithAi } from "@/demo/demoParseApi";

type OrderForm = {
  item_name: string;
  quantity: string;
  price: string;
  origin: string;
  destination: string;
};

const TEMPERATURE_ZONES = ["常温", "冷蔵", "冷凍"] as const;

/** 解析結果がどこから来たか。画面の注記を切り替える */
type ParseSource = "example" | "ai" | "fallback";

/**
 * /demo/orders の「発注管理」。実際の発注画面（/orders）と同じ並び（共通ヘッダー・「新規発注」「発注一覧」の
 * タブ・下のナビ）で、入力 → AI解析 → 内容を確認・入力 → 承認（取り消せない）→ 一覧に承認済みで載り、
 * 4条書面が出る、の流れを見せる。
 * 入力欄は1つ。例文のボタンを押すと、その文が入力欄に入る。文を書き換えずに解析すると固定の結果が返る
 * （AI は呼ばない）。書き換えた文・自由に打った文は、公開デモ専用の Edge Function（demoParseApi.ts）で
 * 本物の AI に解析させ、失敗したら固定の例の結果に切り替える。
 * 実際の発注画面（/orders）と同じ判定関数（orderContent.ts）を使う。状態はこの画面の中だけ。
 * DB には書かない。Supabase のクライアントも使わない。
 */
export default function DemoOrders() {
  const [example, setExample] = useState<DemoOrderExample | null>(null);
  const [freeText, setFreeText] = useState("");
  const [source, setSource] = useState<ParseSource>("example");
  const [fallbackExample, setFallbackExample] = useState<DemoOrderExample | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [form, setForm] = useState<OrderForm | null>(null);
  const [deliveryDate, setDeliveryDate] = useState("");
  const [temperatureZone, setTemperatureZone] = useState<string>("常温");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [approved, setApproved] = useState<DemoOrderDocumentData | null>(null);
  const [editAttempted, setEditAttempted] = useState(false);
  const [tab, setTab] = useState("new");
  const [showDocument, setShowDocument] = useState(true);
  const { toast } = useToast();
  const timerRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const abortAi = () => {
    abortRef.current?.abort();
    abortRef.current = null;
  };
  useEffect(
    () => () => {
      clearTimer();
      abortAi();
    },
    [],
  );

  const locked = approved !== null;
  // 入力欄の文が、選んだ例文のまま（書き換えていない）か。そのままなら固定の結果、書き換えたら本物の AI
  const textIsExample = example !== null && freeText === example.sentence;

  const selectExample = (ex: DemoOrderExample) => {
    if (locked || isParsing) return;
    setExample(ex);
    setFreeText(ex.sentence);
    setSource("example");
    setForm(null);
    setDeliveryDate("");
    setTemperatureZone("常温");
    setRefusal(null);
  };

  const changeFreeText = (value: string) => {
    if (locked || isParsing) return;
    const next = value.slice(0, DEMO_FREE_TEXT_MAX);
    setFreeText(next);
    // 例文を書き換えたら、もう固定の例ではなく自由入力として扱う
    if (example && next !== example.sentence) setExample(null);
    setSource("example");
  };

  /** 解析結果（AI の返事でも固定の結果でも）を、確認用のフォームに入れる */
  const applyResult = (data: DemoAiOrderResult, sentence: string) => {
    // AI は入力に無い項目を "不明" などで埋めることがある。空欄に戻して人に入れてもらう（実際の画面と同じ）。
    setForm({
      item_name: cleanText(data.item_name) ?? "",
      quantity: cleanText(data.quantity) ?? "",
      price: cleanText(data.price) ?? "",
      origin: cleanText(data.origin) ?? "",
      destination: cleanText(data.destination) ?? "",
    });
    // 温度帯と納品日は AI が返さないので、入力文から読み取って補う（実際の画面と同じ関数）
    const hints = orderHintsFromText(sentence, DEMO_ORDER_TODAY);
    setTemperatureZone(hints.temperatureZone ?? "常温");
    if (hints.deliveryDate) setDeliveryDate(hints.deliveryDate);
    else if (cleanText(data.payment_date)) setDeliveryDate(data.payment_date as string);
    else setDeliveryDate("");
  };

  /** 自由入力: 公開デモ専用の AI に解析させる。失敗したら、固定の例の結果に切り替える */
  const parseFreeText = async (text: string) => {
    setIsParsing(true);
    setForm(null);
    setRefusal(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const data = await parseDemoOrderWithAi(text, controller.signal);
      if (controller.signal.aborted) return;
      setSource("ai");
      applyResult(data, text);
    } catch {
      if (controller.signal.aborted) return;
      const fallback = DEMO_ORDER_EXAMPLES[0];
      setSource("fallback");
      setFallbackExample(fallback);
      applyResult(fallback.aiResult, fallback.sentence);
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setIsParsing(false);
      }
    }
  };

  /** 実際の handleParse と同じ流れ。例文のままのときは、AI を呼ばず固定の結果を返す */
  const handleParse = () => {
    if (isParsing || locked) return;
    const text = freeText.trim();
    if (!text) return;
    if (!example || !textIsExample) {
      void parseFreeText(text);
      return;
    }
    setIsParsing(true);
    setForm(null);
    setRefusal(null);
    setSource("example");
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      applyResult(example.aiResult, example.sentence);
      setIsParsing(false);
    }, DEMO_PARSE_DELAY_MS);
  };

  const updateField = (key: keyof OrderForm, value: string) => {
    setForm((f) => (f ? { ...f, [key]: value } : f));
    setRefusal(null);
  };

  /** 実際の checkApprovable と同じ文言。欠けていれば拒否する */
  const handleApproveClick = () => {
    if (!form) return;
    const missing = missingForApproval(form, deliveryDate);
    if (missing.length > 0) {
      setRefusal(`${missing.join("・")}が入っていません。入力してから承認してください。`);
      return;
    }
    const invalid = invalidForApproval(form);
    if (invalid.length > 0) {
      setRefusal(`${invalid.join("。")}。直してから承認してください。`);
      return;
    }
    setRefusal(null);
    setConfirmOpen(true);
  };

  const confirmApprove = () => {
    setConfirmOpen(false);
    if (!form) return;
    // 承認した内容をその場で固定する。以後は form を書き換えても書面は変わらない。
    setApproved({ ...form, temperatureZone, deliveryDate });
    setEditAttempted(false);
    // 実際の画面と同じく、承認・保存すると一覧に移る
    toast({ title: "承認・保存しました" });
    setShowDocument(true);
    setTab("list");
  };

  const reset = () => {
    clearTimer();
    abortAi();
    setExample(null);
    setFreeText("");
    setSource("example");
    setFallbackExample(null);
    setIsParsing(false);
    setForm(null);
    setDeliveryDate("");
    setTemperatureZone("常温");
    setRefusal(null);
    setConfirmOpen(false);
    setApproved(null);
    setEditAttempted(false);
    setTab("new");
  };

  // 納品日（役務の提供を受ける日）から60日以内。受領日を算入するので上限は59日後
  const paymentDeadline = deliveryDate ? latestPaymentDate(deliveryDate) : null;
  const approvedDeadline = approved ? latestPaymentDate(approved.deliveryDate) : null;

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        title="発注管理"
        subtitle="デモ"
        backTo="/demo"
        right={
          <button
            type="button"
            aria-label="最初の状態に戻す"
            onClick={reset}
            className="flex h-11 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-primary-foreground/80 hover:bg-primary-foreground/10"
          >
            <RotateCcw className="h-4 w-4" aria-hidden />
            <span>やり直す</span>
          </button>
        }
      />

      <div className="border-b bg-muted px-4 py-2 text-center text-xs text-muted-foreground">
        表示しているのは架空のデータです。実在の施設・人物・取引とは関係ありません。
      </div>

      <main className="mx-auto max-w-4xl p-4 pb-24">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-4 w-full">
            <TabsTrigger value="new" className="flex-1">新規発注</TabsTrigger>
            <TabsTrigger value="list" className="flex-1">発注一覧</TabsTrigger>
          </TabsList>

          {/* 新規発注タブ */}
          <TabsContent value="new" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">発注内容を入力</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1">
                  <Textarea
                    aria-label="発注内容（自由入力）"
                    value={freeText}
                    maxLength={DEMO_FREE_TEXT_MAX}
                    placeholder="例：架空水産の第2荷捌き場から架空冷蔵の本社倉庫まで、冷凍のブリ20箱、運賃6万円、明日納品"
                    disabled={locked || isParsing}
                    onChange={(e) => changeFreeText(e.target.value)}
                    className="min-h-[120px] text-base"
                  />
                  <p className="flex justify-between gap-2 text-xs text-muted-foreground">
                    <span>{DEMO_FREE_TEXT_DISCLOSURE}</span>
                    <span className="shrink-0 tabular-nums">{freeText.length}/{DEMO_FREE_TEXT_MAX}</span>
                  </p>
                </div>

                <div className="flex flex-wrap gap-2" role="group" aria-label="発注の例文">
                  {DEMO_ORDER_EXAMPLES.map((ex) => (
                    <button
                      key={ex.id}
                      type="button"
                      aria-pressed={example?.id === ex.id}
                      disabled={locked || isParsing}
                      onClick={() => selectExample(ex)}
                      className={`rounded-full px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
                        example?.id === ex.id
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground hover:bg-muted/80"
                      }`}
                    >
                      {ex.label}
                    </button>
                  ))}
                </div>

                <FieldButton
                  variant="accent"
                  onClick={handleParse}
                  disabled={!freeText.trim() || isParsing || locked}
                >
                  {isParsing ? <Loader2 className="animate-spin" /> : <Sparkles />}
                  {isParsing ? "解析中..." : "AI解析"}
                </FieldButton>
                {source === "example" && (!freeText.trim() || textIsExample) && (
                  <p className="text-xs text-muted-foreground">{DEMO_PARSE_NOTE}</p>
                )}
                {source === "ai" && (
                  <p role="status" className="text-xs font-medium text-muted-foreground">
                    {DEMO_AI_NOTE}
                  </p>
                )}
                {source === "fallback" && (
                  <p role="status" className="rounded-lg border bg-muted/40 p-2 text-xs font-medium text-muted-foreground">
                    {DEMO_AI_FALLBACK_NOTE}
                    {fallbackExample ? `（${fallbackExample.label.split("：")[0]}の結果）` : ""}
                  </p>
                )}
                {locked && (
                  <p className="text-sm text-muted-foreground">
                    承認済みの発注があります。右上の「やり直す」で最初の状態に戻せます。
                  </p>
                )}
              </CardContent>
            </Card>

            {form && !locked && (
              <Card className="border-accent">
                <CardHeader>
                  <CardTitle className="text-base">解析結果（編集可能）</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <Label htmlFor="demo-order-item" className="text-sm font-bold">品名</Label>
                      <Input id="demo-order-item" value={form.item_name} onChange={(e) => updateField("item_name", e.target.value)} />
                    </div>
                    <div>
                      <Label htmlFor="demo-order-qty" className="text-sm font-bold">数量</Label>
                      <Input
                        id="demo-order-qty"
                        value={form.quantity}
                        aria-invalid={quantityProblem(form.quantity) !== null}
                        onChange={(e) => updateField("quantity", e.target.value)}
                      />
                      {quantityProblem(form.quantity) && (
                        <p className="mt-1 text-xs text-destructive">{quantityProblem(form.quantity)}</p>
                      )}
                    </div>
                    <div>
                      <Label htmlFor="demo-order-price" className="text-sm font-bold">運賃（円）</Label>
                      <Input id="demo-order-price" inputMode="numeric" value={form.price} onChange={(e) => updateField("price", e.target.value)} />
                    </div>
                    <div>
                      <Label htmlFor="demo-order-origin" className="text-sm font-bold">出発地</Label>
                      <Input id="demo-order-origin" value={form.origin} onChange={(e) => updateField("origin", e.target.value)} />
                    </div>
                    <div>
                      <Label htmlFor="demo-order-dest" className="text-sm font-bold">到着地</Label>
                      <Input id="demo-order-dest" value={form.destination} onChange={(e) => updateField("destination", e.target.value)} />
                    </div>
                    <div>
                      <Label htmlFor="demo-order-date" className="text-sm font-bold">納品日</Label>
                      <Input
                        id="demo-order-date"
                        type="date"
                        value={deliveryDate}
                        min={DEMO_ORDER_TODAY_ISO}
                        onChange={(e) => {
                          setDeliveryDate(e.target.value);
                          setRefusal(null);
                        }}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-sm font-bold">温度帯（必須）</Label>
                    <RadioGroup value={temperatureZone} onValueChange={setTemperatureZone} className="flex gap-2">
                      {TEMPERATURE_ZONES.map((zone) => (
                        <label key={zone} className="flex-1 cursor-pointer">
                          <RadioGroupItem value={zone} className="peer sr-only" />
                          <div
                            className={`flex min-h-[48px] items-center justify-center rounded-lg border-2 text-base font-bold transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring ${
                              temperatureZone === zone ? "border-primary bg-primary/10" : "border-border bg-card"
                            }`}
                          >
                            {zone}
                          </div>
                        </label>
                      ))}
                    </RadioGroup>
                  </div>

                  {paymentDeadline && (
                    <div className="rounded-lg bg-accent/10 p-3 text-sm">
                      <span className="font-bold text-foreground">支払期限（納品日を含めて60日以内）: {paymentDeadline}</span>
                    </div>
                  )}

                  {refusal && (
                    <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
                      <p className="font-bold text-destructive">承認できません</p>
                      <p className="mt-0.5 text-destructive">{refusal}</p>
                    </div>
                  )}

                  <div className="pt-2">
                    <FieldButton variant="accent" onClick={handleApproveClick}>
                      <Check />
                      承認・保存
                    </FieldButton>
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* 発注一覧タブ */}
          <TabsContent value="list" className="space-y-4">
            {!approved ? (
              <p className="py-8 text-center text-muted-foreground">発注データがありません</p>
            ) : (
              <Card className="cursor-default">
                <CardContent className="space-y-3 p-4">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-bold text-card-foreground">{displayText(approved.item_name)}</span>
                      <Badge className="border border-emerald-300 bg-emerald-100 text-emerald-800 hover:bg-emerald-100">承認済</Badge>
                      <Badge variant="outline">{approved.temperatureZone}</Badge>
                      <span className="flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                        <Lock className="h-3 w-3" />
                        承認済み（編集不可）
                      </span>
                    </div>
                    <p className="break-words text-sm text-muted-foreground">
                      {displayRoute(approved.origin, approved.destination)}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      数量: {displayText(approved.quantity)} / 運賃: {displayYen(approved.price)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      納品日: {approved.deliveryDate} &nbsp;→&nbsp; 支払期限: {approvedDeadline ?? "—"}
                    </p>
                    <p className="text-xs font-medium tabular-nums text-emerald-700">
                      承認日時: {DEMO_ORDER_APPROVED_AT_LABEL}
                    </p>
                  </div>

                  <div className="space-y-2 border-t border-border pt-3">
                    <button
                      type="button"
                      aria-expanded={showDocument}
                      onClick={() => setShowDocument((v) => !v)}
                      className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-foreground transition-colors hover:bg-primary/90"
                    >
                      <FileText className="h-5 w-5" />
                      {showDocument ? "発注書（4条書面）を閉じる" : "発注書（4条書面）を表示"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditAttempted(true)}
                      className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-bold text-foreground transition-colors hover:bg-muted"
                    >
                      <Lock className="h-5 w-5" />
                      内容を修正してみる
                    </button>
                    {editAttempted && (
                      <div role="alert" className="rounded-lg border p-3 text-sm">
                        <p className="font-bold">承認済みの発注です</p>
                        <p className="mt-0.5">承認済みのデータは改ざん防止のため編集できません。</p>
                      </div>
                    )}
                  </div>

                  {showDocument && (
                    <div className="space-y-2 border-t border-border pt-3">
                      <DemoOrderDocument data={approved} />
                      <p className="text-xs text-muted-foreground">実際の画面では、この書面をPDFでダウンロードします。</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </main>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>この発注を承認しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              承認すると発注書（4条書面）として確定し、内容は後から変更・削除できません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>やめる</AlertDialogCancel>
            <AlertDialogAction onClick={confirmApprove}>承認して確定する</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <DemoBottomNav />
    </div>
  );
}
