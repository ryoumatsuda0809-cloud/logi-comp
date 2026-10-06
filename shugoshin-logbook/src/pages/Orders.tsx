import { isAbortError, toDisplayMessage } from "@/lib/dbErrors";
import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { FieldButton } from "@/components/ui/field-button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Mic, MicOff, Sparkles, AlertTriangle, Check, Loader2, Download, FileText, Pencil, CheckCircle, Lock, Truck } from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { LocationCombobox } from "@/components/LocationCombobox";
import { isSpeechSupported, startListening, stopListening } from "@/lib/speech";
import { format, isToday, isYesterday } from "date-fns";
import { isPaymentDateTooLate, latestPaymentDate } from "@/lib/paymentDeadline";
import type { Tables } from "@/integrations/supabase/types";
import { BottomNav } from "@/components/BottomNav";
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
import { PageHeader } from "@/components/PageHeader";

type ParsedOrder = {
  item_name: string;
  quantity: string;
  price: string;
  origin: string;
  destination: string;
  payment_date: string | null;
};

/** AI 解析（parse-order）を待つ上限。これを超えたら打ち切ってエラーを出す */
const PARSE_TIMEOUT_MS = 30_000;

const STATUS_LABELS: Record<string, {label: string;color: string;}> = {
  draft: { label: "下書き", color: "bg-muted text-muted-foreground" },
  approved: { label: "承認済", color: "bg-emerald-100 text-emerald-800 border border-emerald-300" },
  delivered: { label: "配送完了", color: "bg-primary text-primary-foreground" }
};

export default function Orders() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast } = useToast();

  const [tab, setTab] = useState("new");
  const [inputText, setInputText] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [parsed, setParsed] = useState<ParsedOrder | null>(null);
  const [deliveryDate, setDeliveryDate] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [orders, setOrders] = useState<Tables<"transport_orders">[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [orgId, setOrgId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [deliveringId, setDeliveringId] = useState<string | null>(null);
  // 取り消せない操作（承認・配送完了）の前に出す確認
  const [confirming, setConfirming] = useState<
    | { kind: "approve-form" }
    | { kind: "approve"; order: Tables<"transport_orders"> }
    | { kind: "deliver"; order: Tables<"transport_orders"> }
    | null
  >(null);
  const [temperatureZone, setTemperatureZone] = useState<string>("常温");

  // Get user's org + check admin role
  useEffect(() => {
    if (!user) return;
    supabase
      .from("profiles")
      .select("organization_id")
      .eq("user_id", user.id)
      .single()
      .then(({ data }) => {
        if (data?.organization_id) setOrgId(data.organization_id);
      });
    supabase
      .from("user_roles")
      .select("id")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle()
      .then(({ data }) => setIsAdmin(!!data));
  }, [user]);

  const fetchOrders = async (oid: string) => {
    const { data } = await supabase
      .from("transport_orders")
      .select("*")
      .eq("organization_id", oid)
      .order("created_at", { ascending: false });
    if (data) setOrders(data);
  };

  // Fetch orders
  useEffect(() => {
    if (!orgId) return;
    fetchOrders(orgId);
  }, [orgId, tab]);

  // openId クエリパラメータ処理: 発注データ取得後に一致する注文を開く
  useEffect(() => {
    const openId = searchParams.get("openId");
    if (!openId || orders.length === 0) return;
    const target = orders.find((o) => o.id === openId);
    if (!target) return;

    // draft のみ編集モードで開く（approved/delivered は一覧タブで対象カードを表示）
    if (target.status === "draft") {
      const content = target.content_json as any;
      setParsed({
        item_name: content.item_name || "",
        quantity: content.quantity || "",
        price: content.price || "",
        origin: content.origin || "",
        destination: content.destination || "",
        payment_date: content.payment_date || null,
      });
      setDeliveryDate(target.delivery_due_date || "");
      setTemperatureZone((target as any).temperature_zone || content.temperature_zone || "常温");
      setEditingOrderId(target.id);
      setInputText("");
      setTab("new");
    } else {
      // 承認済み・配送完了は一覧タブを開いてスクロール
      setTab("list");
    }

    // パラメータを削除（リロード時の再発火防止）
    setSearchParams({}, { replace: true });
  }, [orders, searchParams]);

function smartTimestamp(dateStr: string): { label: string; variant: "default" | "secondary" | "outline" } {
  const d = new Date(dateStr);
  if (isToday(d))     return { label: `今日 ${format(d, "HH:mm")}`, variant: "default" };
  if (isYesterday(d)) return { label: `昨日 ${format(d, "HH:mm")}`, variant: "secondary" };
  const dayNames = ["日","月","火","水","木","金","土"];
  return { label: `${format(d, "MM/dd")}(${dayNames[d.getDay()]}) ${format(d, "HH:mm")}`, variant: "outline" };
}

  const handleMic = () => {
    if (isListening) {
      stopListening();
      setIsListening(false);
      return;
    }
    if (!isSpeechSupported()) {
      toast({ title: "音声入力非対応", description: "このブラウザは音声入力に対応していません", variant: "destructive" });
      return;
    }
    setIsListening(true);
    startListening({
      onResult: (text) => {
        setInputText((prev) => prev ? prev + " " + text : text);
        setIsListening(false);
      },
      onEnd: () => setIsListening(false),
      onError: (err) => {
        toast({ title: "音声入力エラー", description: err, variant: "destructive" });
        setIsListening(false);
      }
    });
  };

  const handleParse = async () => {
    if (!inputText.trim()) return;
    setIsParsing(true);
    setParsed(null);
    try {
      // 応答が返らないときに「解析中...」のまま止まらないよう、30秒で打ち切る
      const { data, error } = await supabase.functions.invoke("parse-order", {
        body: { text: inputText },
        timeout: PARSE_TIMEOUT_MS,
      });
      if (error) throw error;
      if (!data || data.error) {
        toast({ title: "AI解析エラー", description: data?.error || "応答を解析できませんでした", variant: "destructive" });
      } else {
        // AI は入力に無い項目を "null" や "不明" で埋めることがある。空欄に戻して人に入れてもらう。
        setParsed({
          item_name: cleanText(data.item_name) ?? "",
          quantity: cleanText(data.quantity) ?? "",
          price: cleanText(data.price) ?? "",
          origin: cleanText(data.origin) ?? "",
          destination: cleanText(data.destination) ?? "",
          payment_date: cleanText(data.payment_date),
        });
        // 温度帯と納品日は AI が返さないので、入力文から読み取って補う
        const hints = orderHintsFromText(inputText);
        if (hints.temperatureZone) setTemperatureZone(hints.temperatureZone);
        if (hints.deliveryDate) setDeliveryDate(hints.deliveryDate);
        else if (cleanText(data?.payment_date)) setDeliveryDate(data.payment_date);
      }
    } catch (e: any) {
      const description = isAbortError(e)
        ? `${PARSE_TIMEOUT_MS / 1000}秒以内に解析が終わりませんでした。もう一度お試しください。`
        : toDisplayMessage(e, "AI解析に失敗しました");
      toast({ title: "エラー", description, variant: "destructive" });
    } finally {
      setIsParsing(false);
    }
  };

  const handleEditOrder = (order: Tables<"transport_orders">) => {
    const content = order.content_json as any;
    if (order.status === "approved") {
      toast({
        title: "🔒 承認済みの発注です",
        description: "承認済みのデータは改ざん防止のため編集できません。",
        variant: "destructive"
      });
      return;
    }
    if (order.status === "delivered") {
      toast({
        title: "配送完了済みです",
        description: "配送完了の発注は変更できません。",
        variant: "destructive"
      });
      return;
    }
    setParsed({
      item_name: content.item_name || "",
      quantity: content.quantity || "",
      price: content.price || "",
      origin: content.origin || "",
      destination: content.destination || "",
      payment_date: content.payment_date || null,
    });
    setDeliveryDate(order.delivery_due_date || "");
    setTemperatureZone((order as any).temperature_zone || content.temperature_zone || "常温");
    setEditingOrderId(order.id);
    setInputText("");
    setTab("new");
  };

  // 取適法第3条: 納品日（役務の提供を受ける日）から60日以内。受領日を算入するので上限は59日後
  const paymentDeadline = deliveryDate ? latestPaymentDate(deliveryDate) : null;

  const isPaymentLate = parsed?.payment_date && deliveryDate ?
    isPaymentDateTooLate(parsed.payment_date, deliveryDate) :
    false;

  // 承認に必要な項目が欠けていれば知らせて false を返す
  const checkApprovable = (content: Parameters<typeof missingForApproval>[0], dueDate: string | null | undefined, hint: string) => {
    const missing = missingForApproval(content, dueDate);
    if (missing.length === 0) return true;
    toast({
      title: "承認できません",
      description: `${missing.join("・")}が入っていません。${hint}`,
      variant: "destructive",
    });
    return false;
  };

  const handleSave = async (status: "draft" | "approved") => {
    if (!parsed) return;
    if (!orgId) {
      toast({
        title: "保存できません",
        description: "組織への参加が完了していません。管理者に招待を依頼するか、組織設定ページで組織を作成してください。",
        variant: "destructive"
      });
      return;
    }
    if (status === "approved" && !checkApprovable(parsed, deliveryDate, "入力してから承認してください。")) return;
    setIsSaving(true);
    try {
      if (editingOrderId) {
        // UPDATE モード
        const { error } = await supabase
          .from("transport_orders")
          .update({
            content_json: { ...parsed, temperature_zone: temperatureZone } as any,
            status,
            delivery_due_date: deliveryDate || null,
            temperature_zone: temperatureZone,
          } as any)
          .eq("id", editingOrderId);
        if (error) throw error;
        toast({ title: status === "approved" ? "承認・更新しました" : "下書きを更新しました" });
      } else {
        // INSERT モード
        const { error } = await supabase.from("transport_orders").insert({
          organization_id: orgId,
          content_json: { ...parsed, temperature_zone: temperatureZone } as any,
          status,
          delivery_due_date: deliveryDate || null,
          created_by: user?.id,
          temperature_zone: temperatureZone,
        } as any);
        if (error) throw error;
        toast({ title: status === "approved" ? "承認・保存しました" : "下書き保存しました" });
      }

      // 発地・着地を saved_locations に自動保存（バックグラウンド）
      const locationsToSave = [
        { location_type: "origin",      address: parsed.origin },
        { location_type: "destination", address: parsed.destination },
      ].filter((l) => l.address?.trim());
      for (const loc of locationsToSave) {
        await supabase.from("saved_locations").upsert(
          {
            user_id: user!.id,
            location_type: loc.location_type,
            address: loc.address.trim(),
            usage_count: 1,
            last_used_at: new Date().toISOString(),
          },
          { onConflict: "user_id,location_type,address" }
        );
      }

      setParsed(null);
      setInputText("");
      setDeliveryDate("");
      setTemperatureZone("常温");
      setEditingOrderId(null);
      setTab("list");
      if (orgId) await fetchOrders(orgId);
      // 保存した発注は一覧の先頭に出るので、先頭から見せる
      window.scrollTo({ top: 0 });
    } catch (e: any) {
      console.error("保存に失敗しました:", e);
      toast({ title: "保存に失敗しました", description: toDisplayMessage(e, "不明なエラーが発生しました"), variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  };

  const handleApprove = async (order: Tables<"transport_orders">) => {
    const orderId = order.id;
    if (!checkApprovable((order.content_json ?? {}) as any, order.delivery_due_date, "カードをタップして入力してから承認してください。")) return;
    setApprovingId(orderId);
    try {
      const { error } = await supabase
        .from("transport_orders")
        .update({
          status: "approved",
          approved_at: new Date().toISOString(),
          approved_by: user!.id,
        } as any)
        .eq("id", orderId);

      if (error) {
        if (error.code === "42501" || error.message.includes("row-level security")) {
          toast({ title: "承認できません", description: "承認済みのデータは変更できません", variant: "destructive" });
        } else {
          throw error;
        }
      } else {
        toast({ title: "✅ 承認しました", description: "発注が承認・確定されました。編集は不可になります。" });
        if (orgId) await fetchOrders(orgId);
      }
    } catch (e: any) {
      toast({ title: "エラー", description: toDisplayMessage(e), variant: "destructive" });
    } finally {
      setApprovingId(null);
    }
  };

  // 承認済み → 配送完了。DB 側（RLS とトリガー）でも管理者の approved → delivered だけを許している。
  const handleDeliver = async (order: Tables<"transport_orders">) => {
    setDeliveringId(order.id);
    try {
      const { error } = await supabase
        .from("transport_orders")
        .update({ status: "delivered" } as any)
        .eq("id", order.id);
      if (error) throw error;
      toast({ title: "配送完了にしました" });
      if (orgId) await fetchOrders(orgId);
    } catch (e: any) {
      toast({ title: "配送完了にできませんでした", description: toDisplayMessage(e), variant: "destructive" });
    } finally {
      setDeliveringId(null);
    }
  };

  const handleDownloadPdf = async (orderId: string, isDraftPdf = false) => {
    if (isDraftPdf) {
      toast({ title: "📄 DRAFT確認用PDF", description: "DRAFT透かし入りのPDFをダウンロードします。" });
    }
    setDownloadingId(orderId);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-order-pdf`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session?.access_token}`,
            apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
          },
          body: JSON.stringify({ order_id: orderId })
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "PDF生成に失敗しました");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Order_${orderId.slice(0, 8)}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast({ title: "PDFエラー", description: toDisplayMessage(e), variant: "destructive" });
    } finally {
      setDownloadingId(null);
    }
  };

  const filteredOrders = statusFilter === "all" ? orders : orders.filter((o) => o.status === statusFilter);

  return (
    <div className="min-h-screen bg-background">
      <PageHeader title="発注管理" />

      <main className="mx-auto max-w-4xl p-4 pb-24">
        <Tabs
          value={tab}
          onValueChange={(v) => {
            setTab(v);
            if (v !== "new") {
              setEditingOrderId(null);
              setParsed(null);
              setInputText("");
              setDeliveryDate("");
            }
          }}
        >
          <TabsList className="mb-4 w-full">
            <TabsTrigger value="new" className="flex-1">
              {editingOrderId ? "発注の編集" : "新規発注"}
            </TabsTrigger>
            <TabsTrigger value="list" className="flex-1">発注一覧</TabsTrigger>
          </TabsList>

          {/* 新規発注タブ */}
          <TabsContent value="new" className="space-y-4">
            {!orgId && (
              <p className="text-sm text-muted-foreground">
                組織に参加するまで、発注は保存できません（上の帯から招待コードを入力できます）。
                <button
                  onClick={() => navigate("/organization-settings")}
                  className="ml-1 underline">
                  組織設定へ →
                </button>
              </p>
            )}

            {/* 編集モード中のみ AI入力欄を非表示 */}
            {!editingOrderId && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">発注内容を入力（テキストまたは音声）</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Textarea
                    placeholder="例: 唐戸からフグ10箱を長府まで、運賃5万円"
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    className="min-h-[120px] text-base" />

                  <div className="flex gap-3">
                    <FieldButton
                      variant={isListening ? "destructive" : "outline"}
                      fullWidth={false}
                      size="default"
                      onClick={handleMic}
                      className="shrink-0">
                      {isListening ? <MicOff /> : <Mic />}
                      {isListening ? "停止" : "音声入力"}
                    </FieldButton>
                    <FieldButton
                      variant="accent"
                      fullWidth={false}
                      className="min-w-0 flex-1"
                      onClick={handleParse}
                      disabled={!inputText.trim() || isParsing}>
                      {isParsing ? <Loader2 className="animate-spin" /> : <Sparkles />}
                      {isParsing ? "解析中..." : "AI解析"}
                    </FieldButton>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* AI解析結果 / 編集フォーム */}
            {parsed &&
              <Card className="border-accent">
                <CardHeader>
                  <CardTitle className="text-base">
                    {editingOrderId ? "発注の編集" : "解析結果（編集可能）"}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <Label className="text-sm font-bold">品名</Label>
                      <Input
                        value={parsed.item_name}
                        onChange={(e) => setParsed({ ...parsed, item_name: e.target.value })} />
                    </div>
                    <div>
                      <Label className="text-sm font-bold">数量</Label>
                      <Input
                        value={parsed.quantity}
                        onChange={(e) => setParsed({ ...parsed, quantity: e.target.value })} />
                    </div>
                    <div>
                      <Label className="text-sm font-bold">運賃（円）</Label>
                      <Input
                        value={parsed.price}
                        onChange={(e) => setParsed({ ...parsed, price: e.target.value })} />
                    </div>
                    <div>
                      <Label className="text-sm font-bold">出発地</Label>
                      <LocationCombobox
                        value={parsed.origin}
                        onChange={(v) => setParsed({ ...parsed, origin: v })}
                        locationType="origin"
                        placeholder="例: 唐戸市場" />
                    </div>
                    <div>
                      <Label className="text-sm font-bold">到着地</Label>
                      <LocationCombobox
                        value={parsed.destination}
                        onChange={(v) => setParsed({ ...parsed, destination: v })}
                        locationType="destination"
                        placeholder="例: 長府港" />
                  </div>

                  {/* 温度帯セレクター */}
                  <div className="space-y-2">
                    <Label className="text-sm font-bold">温度帯（必須）</Label>
                    <RadioGroup
                      value={temperatureZone}
                      onValueChange={setTemperatureZone}
                      className="flex gap-2"
                    >
                      {[
                        { value: "常温", label: "常温", style: "data-[state=checked]:bg-muted data-[state=checked]:text-muted-foreground" },
                        { value: "冷蔵", label: "冷蔵", style: "data-[state=checked]:bg-cyan-100 data-[state=checked]:text-cyan-800" },
                        { value: "冷凍", label: "冷凍", style: "data-[state=checked]:bg-blue-100 data-[state=checked]:text-blue-800" },
                      ].map((tz) => (
                        <label
                          key={tz.value}
                          className="flex-1 cursor-pointer"
                        >
                          <RadioGroupItem value={tz.value} className="peer sr-only" />
                          <div className={`flex min-h-[48px] items-center justify-center rounded-lg border-2 border-border text-base font-bold transition-all peer-data-[state=checked]:border-primary ${
                            temperatureZone === tz.value
                              ? tz.value === "冷凍" ? "bg-blue-100 text-blue-800 border-blue-400"
                                : tz.value === "冷蔵" ? "bg-cyan-100 text-cyan-800 border-cyan-400"
                                : "bg-muted text-muted-foreground"
                              : "bg-card text-card-foreground"
                          }`}>
                            {tz.value === "冷凍" ? "❄️ " : tz.value === "冷蔵" ? "🧊 " : "📦 "}{tz.label}
                          </div>
                        </label>
                      ))}
                    </RadioGroup>
                  </div>
                    <div>
                      <Label className="text-sm font-bold">納品日</Label>
                      <Input
                        type="date"
                        value={deliveryDate}
                        min={new Date().toISOString().split("T")[0]}
                        onChange={(e) => setDeliveryDate(e.target.value)} />
                    </div>
                  </div>

                  {/* 60日ルールチェック */}
                  {paymentDeadline &&
                    <div className={`rounded-lg p-3 text-sm ${isPaymentLate ? "bg-destructive/10 text-destructive" : "bg-accent/10 text-accent-foreground"}`}>
                      {isPaymentLate ?
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="h-5 w-5 shrink-0" />
                          <span>支払期日が60日以内の上限を超えています。期限: {paymentDeadline}</span>
                        </div> :
                        <span className="text-left font-bold text-foreground">支払期限（納品日を含めて60日以内）: {paymentDeadline}</span>
                      }
                    </div>
                  }

                  <div className="flex gap-3 pt-2">
                    <FieldButton variant="outline" onClick={() => handleSave("draft")} disabled={isSaving}>
                      {editingOrderId ? "下書きを更新" : "下書き保存"}
                    </FieldButton>
                    <FieldButton variant="accent" onClick={() => {
                      if (checkApprovable(parsed, deliveryDate, "入力してから承認してください。")) setConfirming({ kind: "approve-form" });
                    }} disabled={isSaving}>
                      {isSaving ? <Loader2 className="animate-spin" /> : <Check />}
                      {editingOrderId ? "承認・更新" : "承認・保存"}
                    </FieldButton>
                  </div>
                </CardContent>
              </Card>
            }
          </TabsContent>

          {/* 発注一覧タブ */}
          <TabsContent value="list" className="space-y-4">
            <div className="flex gap-2 overflow-x-auto">
              {["all", "draft", "approved", "delivered"].map((s) =>
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                    statusFilter === s ?
                    "bg-primary text-primary-foreground" :
                    "bg-muted text-muted-foreground hover:bg-muted/80"}`
                  }>
                  {s === "all" ? "すべて" : STATUS_LABELS[s]?.label}
                </button>
              )}
            </div>

            {filteredOrders.length === 0 ?
              <p className="py-8 text-center text-muted-foreground">発注データがありません</p> :

              filteredOrders.map((order) => {
                const content = order.content_json as any;
                const st = STATUS_LABELS[order.status];
                const isDraft = order.status === "draft";
                const isApproved = order.status === "approved";
                const approvedAt = (order as any).approved_at as string | null;
                return (
                  <Card
                    key={order.id}
                    className={`transition-all ${
                      isDraft
                        ? "cursor-pointer hover:border-primary/50 hover:shadow-md active:scale-[0.98]"
                        : "cursor-default opacity-90"
                    }`}
                    onClick={() => isDraft ? handleEditOrder(order) : undefined}
                  >
                    <CardContent className="p-4 space-y-3">
                      {/* カードヘッダー行 */}
                      <div className="flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          {(() => {
                            const ts = smartTimestamp(order.created_at);
                            return <Badge variant={ts.variant} className={`text-base ${ts.variant === "default" ? "bg-orange-500 text-white border-orange-500 hover:bg-orange-600" : ""}`}>{ts.label}</Badge>;
                          })()}
                          <span className="font-bold text-card-foreground">
                            {displayText(content?.item_name)}
                          </span>
                          <Badge className={st?.color}>{st?.label}</Badge>
                          {(() => {
                            const tz = (order as any).temperature_zone || (content?.temperature_zone) || "常温";
                            const tzStyle = tz === "冷凍" ? "bg-blue-100 text-blue-800 border-blue-300"
                              : tz === "冷蔵" ? "bg-cyan-100 text-cyan-800 border-cyan-300"
                              : "bg-gray-100 text-gray-700 border-gray-300";
                            return <Badge className={tzStyle}>{tz === "冷凍" ? "❄️" : tz === "冷蔵" ? "🧊" : "📦"} {tz}</Badge>;
                          })()}
                          {isDraft && (
                            <span className="flex items-center gap-1 text-xs text-primary/70">
                              <Pencil className="h-3 w-3" />
                              タップで編集
                            </span>
                          )}
                          {isApproved && (
                            <span className="flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                              <Lock className="h-3 w-3" />
                              承認済み（編集不可）
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {displayRoute(content?.origin, content?.destination)}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          数量: {displayText(content?.quantity)} / 運賃: {displayYen(content?.price)}
                        </p>
                        {order.delivery_due_date &&
                          <p className="text-xs text-muted-foreground">
                            納品日: {order.delivery_due_date}
                            {" "}&nbsp;→&nbsp; 支払期限: {latestPaymentDate(order.delivery_due_date) ?? "—"}
                          </p>
                        }
                        {isApproved && approvedAt && (
                          <p className="text-xs font-medium text-emerald-700">
                            承認日時: {format(new Date(approvedAt), "yyyy-MM-dd HH:mm")}
                          </p>
                        )}
                      </div>

                      {/* ボタン群（カード下部、全幅） */}
                      <div className="space-y-2 border-t border-border pt-3">
                        {/* approved / delivered: 発注書PDFボタン（紺色） */}
                        {(isApproved || order.status === "delivered") && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDownloadPdf(order.id); }}
                            disabled={downloadingId === order.id}
                            className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
                          >
                            {downloadingId === order.id ? (
                              <Loader2 className="h-5 w-5 animate-spin" />
                            ) : (
                              <FileText className="h-5 w-5" />
                            )}
                            発注書PDFをダウンロード
                          </button>
                        )}

                        {/* draft: DRAFT確認用PDFボタン（グレー） */}
                        {isDraft && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDownloadPdf(order.id, true); }}
                            disabled={downloadingId === order.id}
                            className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg border border-border bg-muted px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/80 disabled:opacity-60"
                          >
                            {downloadingId === order.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Download className="h-4 w-4" />
                            )}
                            下書きの確認用PDF
                          </button>
                        )}

                        {/* 管理者のみ：draft カードに承認ボタン */}
                        {isAdmin && isDraft && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (checkApprovable((order.content_json ?? {}) as any, order.delivery_due_date, "カードをタップして入力してから承認してください。")) {
                                setConfirming({ kind: "approve", order });
                              }
                            }}
                            disabled={approvingId === order.id}
                            className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
                          >
                            {approvingId === order.id ? (
                              <Loader2 className="h-5 w-5 animate-spin" />
                            ) : (
                              <CheckCircle className="h-5 w-5" />
                            )}
                            承認して確定する
                          </button>
                        )}

                        {/* 管理者のみ：approved カードに「配送完了にする」ボタン。
                            承認済みの発注は書面として確定しているので、取り消し・修正はできない */}
                        {isAdmin && isApproved && (
                          <button
                            onClick={(e) => { e.stopPropagation(); setConfirming({ kind: "deliver", order }); }}
                            disabled={deliveringId === order.id}
                            className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-bold text-foreground transition-colors hover:bg-muted disabled:opacity-60"
                          >
                            {deliveringId === order.id ? (
                              <Loader2 className="h-5 w-5 animate-spin" />
                            ) : (
                              <Truck className="h-5 w-5" />
                            )}
                            配送完了にする
                          </button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })
            }
          </TabsContent>
        </Tabs>
      </main>

      <AlertDialog open={confirming !== null} onOpenChange={(open) => { if (!open) setConfirming(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming?.kind === "deliver" ? "配送完了にしますか？" : "この発注を承認しますか？"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.kind === "deliver"
                ? "配送完了にすると、元の「承認済」には戻せません。"
                : "承認すると発注書（4条書面）として確定し、内容は後から変更・削除できません。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>やめる</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const c = confirming;
                setConfirming(null);
                if (!c) return;
                if (c.kind === "approve-form") handleSave("approved");
                else if (c.kind === "approve") handleApprove(c.order);
                else handleDeliver(c.order);
              }}
            >
              {confirming?.kind === "deliver" ? "配送完了にする" : "承認して確定する"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <BottomNav />
    </div>
  );
}
