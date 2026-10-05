import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Check, CheckCircle2, Loader2, Lock, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { cleanText, displayRoute, displayText, displayYen, missingForApproval, orderHintsFromText } from "@/lib/orderContent";
import { latestPaymentDate } from "@/lib/paymentDeadline";
import { DemoOrderDocument, type DemoOrderDocumentData } from "@/components/demo/DemoOrderDocument";
import {
  DEMO_ORDER_APPROVED_AT_LABEL,
  DEMO_ORDER_EXAMPLES,
  DEMO_ORDER_TODAY,
  DEMO_ORDER_TODAY_ISO,
  DEMO_PARSE_DELAY_MS,
  DEMO_PARSE_NOTE,
  type DemoOrderExample,
} from "@/demo/demoOrders";

type OrderForm = {
  item_name: string;
  quantity: string;
  price: string;
  origin: string;
  destination: string;
};

const TEMPERATURE_ZONES = ["常温", "冷蔵", "冷凍"] as const;

/**
 * /demo/orders の「発注」。
 * 例文を選ぶ → 擬似AI解析（固定の結果）→ 内容を確認・入力 → 承認（取り消せない）→ 4条書面、の流れを見せる。
 * 実際の発注画面（/orders）と同じ判定関数（orderContent.ts）を使う。状態はこの画面の中だけ。
 * Supabase にも AI にもアクセスしない。
 */
export default function DemoOrders() {
  const [example, setExample] = useState<DemoOrderExample | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [form, setForm] = useState<OrderForm | null>(null);
  const [deliveryDate, setDeliveryDate] = useState("");
  const [temperatureZone, setTemperatureZone] = useState<string>("常温");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [approved, setApproved] = useState<DemoOrderDocumentData | null>(null);
  const [editAttempted, setEditAttempted] = useState(false);
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  useEffect(() => clearTimer, []);

  const locked = approved !== null;

  const selectExample = (ex: DemoOrderExample) => {
    if (locked || isParsing) return;
    setExample(ex);
    setForm(null);
    setDeliveryDate("");
    setTemperatureZone("常温");
    setRefusal(null);
  };

  /** 実際の handleParse と同じ流れ。違うのは、AI を呼ばず固定の結果を返すところだけ */
  const handleParse = () => {
    if (!example || isParsing || locked) return;
    setIsParsing(true);
    setForm(null);
    setRefusal(null);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const data = example.aiResult;
      // AI は入力に無い項目を "不明" などで埋めることがある。空欄に戻して人に入れてもらう（実際の画面と同じ）。
      setForm({
        item_name: cleanText(data.item_name) ?? "",
        quantity: cleanText(data.quantity) ?? "",
        price: cleanText(data.price) ?? "",
        origin: cleanText(data.origin) ?? "",
        destination: cleanText(data.destination) ?? "",
      });
      // 温度帯と納品日は AI が返さないので、入力文から読み取って補う（実際の画面と同じ関数）
      const hints = orderHintsFromText(example.sentence, DEMO_ORDER_TODAY);
      setTemperatureZone(hints.temperatureZone ?? "常温");
      if (hints.deliveryDate) setDeliveryDate(hints.deliveryDate);
      else if (cleanText(data.payment_date)) setDeliveryDate(data.payment_date as string);
      else setDeliveryDate("");
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
    setRefusal(null);
    setConfirmOpen(true);
  };

  const confirmApprove = () => {
    setConfirmOpen(false);
    if (!form) return;
    // 承認した内容をその場で固定する。以後は form を書き換えても書面は変わらない。
    setApproved({ ...form, temperatureZone, deliveryDate });
    setEditAttempted(false);
  };

  const reset = () => {
    clearTimer();
    setExample(null);
    setIsParsing(false);
    setForm(null);
    setDeliveryDate("");
    setTemperatureZone("常温");
    setRefusal(null);
    setConfirmOpen(false);
    setApproved(null);
    setEditAttempted(false);
  };

  // 納品日（役務の提供を受ける日）から60日以内。受領日を算入するので上限は59日後
  const paymentDeadline = deliveryDate ? latestPaymentDate(deliveryDate) : null;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b bg-primary px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-primary-foreground">守護神 デモ：発注</h1>
            <p className="text-xs text-primary-foreground/70">入力文から4条書面まで</p>
          </div>
        </div>
      </header>

      <div className="border-b bg-muted px-4 py-2 text-center text-xs text-muted-foreground">
        表示しているのは架空のデータです。実在の施設・人物・取引とは関係ありません。
      </div>

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-4 pb-16">
        <Button asChild variant="ghost" size="sm" className="-ml-2 gap-2 text-muted-foreground">
          <Link to="/demo">
            <ArrowLeft className="h-4 w-4" />
            デモに戻る
          </Link>
        </Button>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">1. 発注内容の入力</CardTitle>
            <p className="text-xs text-muted-foreground">
              実際の画面では、文章を打つか声で話します。ここでは例文から選びます。
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2" role="group" aria-label="発注の例文">
              {DEMO_ORDER_EXAMPLES.map((ex) => (
                <Button
                  key={ex.id}
                  type="button"
                  variant={example?.id === ex.id ? "default" : "outline"}
                  size="sm"
                  className="h-auto justify-start whitespace-normal py-2 text-left"
                  aria-pressed={example?.id === ex.id}
                  disabled={locked || isParsing}
                  onClick={() => selectExample(ex)}
                >
                  {ex.label}
                </Button>
              ))}
            </div>

            {example && (
              <p data-testid="demo-order-sentence" className="rounded-lg border bg-muted/40 p-3 text-sm">
                {example.sentence}
              </p>
            )}

            <Button className="w-full gap-2" onClick={handleParse} disabled={!example || isParsing || locked}>
              {isParsing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {isParsing ? "解析中..." : "AI解析"}
            </Button>
            <p className="text-xs text-muted-foreground">{DEMO_PARSE_NOTE}</p>
          </CardContent>
        </Card>

        {form && !locked && (
          <Card className="border-accent">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">2. 解析結果（編集可能）</CardTitle>
              <p className="text-xs text-muted-foreground">
                空欄の項目は、入力文から読み取れなかったものです。入力してから承認してください。
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="demo-order-item" className="text-sm font-bold">品名</Label>
                  <Input id="demo-order-item" value={form.item_name} onChange={(e) => updateField("item_name", e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="demo-order-qty" className="text-sm font-bold">数量</Label>
                  <Input id="demo-order-qty" value={form.quantity} onChange={(e) => updateField("quantity", e.target.value)} />
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
                        className={`flex min-h-[44px] items-center justify-center rounded-lg border-2 text-base font-bold transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring ${
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

              <Button className="w-full gap-2" onClick={handleApproveClick}>
                <Check className="h-4 w-4" />
                承認・保存
              </Button>
            </CardContent>
          </Card>
        )}

        {approved && (
          <>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">3. 承認済みの発注</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-col items-center justify-center gap-0.5 rounded-xl border bg-muted/40 py-3">
                  <div className="flex items-center gap-2 text-lg font-bold text-muted-foreground">
                    <CheckCircle2 className="h-5 w-5" />
                    承認済み・編集不可
                  </div>
                  <p className="text-xs tabular-nums text-muted-foreground">承認日時: {DEMO_ORDER_APPROVED_AT_LABEL}</p>
                </div>

                <div className="space-y-1 rounded-lg border p-3 text-sm">
                  <p className="font-bold">{displayText(approved.item_name)}（{approved.temperatureZone}）</p>
                  <p className="break-words text-muted-foreground">{displayRoute(approved.origin, approved.destination)}</p>
                  <p className="text-muted-foreground">
                    数量: {displayText(approved.quantity)} / 運賃: {displayYen(approved.price)}
                  </p>
                </div>

                <Button variant="outline" className="w-full gap-2" onClick={() => setEditAttempted(true)}>
                  <Lock className="h-4 w-4" />
                  内容を修正してみる
                </Button>
                {editAttempted && (
                  <div role="alert" className="rounded-lg border p-3 text-sm">
                    <p className="font-bold">承認済みの発注です</p>
                    <p className="mt-0.5">承認済みのデータは改ざん防止のため編集できません。</p>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">4. 4条書面</CardTitle>
                <p className="text-xs text-muted-foreground">
                  承認すると、この内容が発注書として確定します。実際の画面ではPDFでダウンロードできます（デモでは画面表示のみ）。
                </p>
              </CardHeader>
              <CardContent>
                <DemoOrderDocument data={approved} />
              </CardContent>
            </Card>
          </>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={reset}>
            最初の状態に戻す
          </Button>
        </div>
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
    </div>
  );
}
