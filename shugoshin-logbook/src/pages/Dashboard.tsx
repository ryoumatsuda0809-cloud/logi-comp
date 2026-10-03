import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useNavigate } from "react-router-dom";
import { FieldButton } from "@/components/ui/field-button";
import {
  LogOut, Truck, ClipboardList, MapPin,
  Building2, Building, ArrowRight, Plus, FileWarning, LayoutDashboard, ClipboardCheck,
} from "lucide-react";
import { BottomNav } from "@/components/BottomNav";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";
import type { Json } from "@/integrations/supabase/types";
import PwaInstallBanner from "@/components/PwaInstallBanner";

type OrderStatus = "draft" | "approved" | "delivered";

interface OrderRow {
  id: string;
  status: OrderStatus;
  content_json: Json;
  created_at: string;
  temperature_zone?: string;
}

interface KpiCounts {
  draft: number;
  approved: number;
  delivered: number;
}

const STATUS_CONFIG: Record<OrderStatus, { label: string; bg: string; text: string }> = {
  draft:     { label: "下書き",   bg: "bg-muted",    text: "text-muted-foreground" },
  approved:  { label: "承認済",   bg: "bg-accent",   text: "text-accent-foreground" },
  delivered: { label: "配送完了", bg: "bg-primary",  text: "text-primary-foreground" },
};

function getJson(json: Json): Record<string, unknown> {
  if (typeof json === "object" && json !== null && !Array.isArray(json)) {
    return json as Record<string, unknown>;
  }
  return {};
}

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [kpi, setKpi] = useState<KpiCounts>({ draft: 0, approved: 0, delivered: 0 });
  const [recentOrders, setRecentOrders] = useState<OrderRow[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!user) return;

    // 管理者チェック（user_roles テーブルをサーバーサイドで確認）
    supabase
      .from("user_roles")
      .select("id")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle()
      .then(({ data }) => setIsAdmin(!!data));

    supabase
      .from("profiles")
      .select("organization_id")
      .eq("user_id", user.id)
      .single()
      .then(({ data }) => {
        if (data?.organization_id) {
          fetchOrderSummary(data.organization_id);
        } else {
          setLoading(false);
        }
      });
  }, [user]);

  async function fetchOrderSummary(orgId: string) {
    const { data } = await supabase
      .from("transport_orders")
      .select("id, status, content_json, created_at, temperature_zone")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(20);

    if (data) {
      const counts: KpiCounts = { draft: 0, approved: 0, delivered: 0 };
      data.forEach((o) => {
        if (o.status in counts) counts[o.status as OrderStatus]++;
      });
      setKpi(counts);
      setRecentOrders((data as OrderRow[]).slice(0, 3));
    }
    setLoading(false);
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="bg-primary px-4 py-4 shadow-lg">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent">
              <img src="/icon-192.png" alt="守護神" className="h-8 w-8 rounded-md" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-primary-foreground">守護神</h1>
              <p className="text-xs text-primary-foreground/60">{user?.email}</p>
            </div>
          </div>
          <button
            onClick={signOut}
            className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm text-primary-foreground/70 hover:bg-primary-foreground/10"
          >
            <LogOut className="h-4 w-4" />
            <span className="hidden sm:inline">ログアウト</span>
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-6 p-4 pb-28">

        {/* PWA Install Banner */}
        <PwaInstallBanner />

        {/* Quick Action Banner — 組織設定への導線（全員に表示） */}
        <button
          onClick={() => navigate("/organization-settings")}
          className="flex w-full min-h-[56px] items-center gap-3 rounded-xl border border-dashed border-border bg-card px-4 py-3 text-left transition-all hover:border-primary/50 hover:bg-card/80 active:scale-[0.98]"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Building className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-card-foreground">組織情報の確認・変更</p>
            <p className="text-xs text-muted-foreground">住所・財務情報・会社名</p>
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>

        {/* KPI Banner */}
        <section>
          <h2 className="mb-3 text-base font-semibold text-muted-foreground">発注状況サマリー</h2>
          {loading ? (
            <div className="grid grid-cols-3 gap-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-[80px] rounded-xl" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              <KpiCard label="下書き" count={kpi.draft} colorClass="bg-muted text-muted-foreground" />
              <KpiCard label="承認済" count={kpi.approved} colorClass="bg-accent text-accent-foreground" />
              <KpiCard label="配送完了" count={kpi.delivered} colorClass="bg-primary text-primary-foreground" />
            </div>
          )}
        </section>

        {/* Recent Orders */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold text-muted-foreground">最新の発注</h2>
            <button
              onClick={() => navigate("/orders")}
              className="flex items-center gap-1 text-sm font-medium text-primary hover:underline"
            >
              すべて見る <ArrowRight className="h-4 w-4" />
            </button>
          </div>

          {loading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[72px] rounded-xl" />)}
            </div>
          ) : recentOrders.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card p-6 text-center text-muted-foreground">
              <p className="text-base">発注記録がありません</p>
              <p className="mt-1 text-sm">下のボタンから最初の発注を記録しましょう</p>
            </div>
          ) : (
            <div className="space-y-3">
              {recentOrders.map((order) => {
                const content = getJson(order.content_json);
                const itemName = (content.item_name as string) || "（品目未設定）";
                const origin = (content.origin as string) || "";
                const destination = (content.destination as string) || "";
                const cfg = STATUS_CONFIG[order.status];
                return (
                  <button
                    key={order.id}
                    onClick={() => navigate(`/orders?openId=${order.id}`)}
                    className="flex w-full items-center justify-between rounded-xl border border-border bg-card px-4 py-4 text-left shadow-sm transition-all hover:border-primary/40 hover:bg-primary/5 hover:shadow-md active:scale-[0.98]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-base font-bold text-card-foreground">{itemName}</p>
                      {(origin || destination) && (
                        <p className="mt-0.5 truncate text-sm text-muted-foreground">
                          {origin}{origin && destination ? " → " : ""}{destination}
                        </p>
                      )}
                    </div>
                    <span className={`ml-3 shrink-0 rounded-full px-3 py-1 text-sm font-semibold ${cfg.bg} ${cfg.text}`}>
                      {cfg.label}
                    </span>
                    {(() => {
                      const tz = order.temperature_zone || (getJson(order.content_json).temperature_zone as string) || "常温";
                      const tzStyle = tz === "冷凍" ? "bg-blue-100 text-blue-800"
                        : tz === "冷蔵" ? "bg-cyan-100 text-cyan-800"
                        : "bg-gray-100 text-gray-700";
                      return <span className={`ml-1 shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${tzStyle}`}>{tz}</span>;
                    })()}
                  </button>
                );
              })}
            </div>
          )}

          {/* Shortcut Button */}
          <div className="mt-4">
            <FieldButton
              variant="accent"
              size="lg"
              onClick={() => navigate("/orders")}
            >
              <Plus className="h-6 w-6" />
              新しい発注を記録する
            </FieldButton>
          </div>
        </section>

        {/* Main Menu */}
        <section>
          <h2 className="mb-3 text-base font-semibold text-muted-foreground">メインメニュー</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <MenuCard
              icon={<ClipboardList className="h-8 w-8" />}
              title="発注管理"
              description="AI解析で4条書面を自動生成"
              color="accent"
              onClick={() => navigate("/orders")}
            />
            <MenuCard
              icon={<MapPin className="h-8 w-8" />}
              title="打刻・日報"
              description="GPS検証付き到着打刻"
              color="primary"
              onClick={() => navigate("/check-in")}
            />
            <MenuCard
              icon={<Truck className="h-8 w-8" />}
              title="配送状況"
              description="コンプライアンスログ確認"
              color="primary"
              onClick={() => navigate("/delivery-status")}
            />
            <MenuCard
              icon={<Building2 className="h-8 w-8" />}
              title="組織管理"
              description="企業情報・住所・財務情報の確認・変更"
              color="primary"
              onClick={() => navigate("/organization-settings")}
            />
            {isAdmin && (
              <MenuCard
                icon={<LayoutDashboard className="h-8 w-8" />}
                title="荷主カンバン"
                description="施設の待機状況・呼出・荷役開始"
                color="primary"
                onClick={() => navigate("/admin")}
              />
            )}
            {isAdmin && (
              <MenuCard
                icon={<ClipboardCheck className="h-8 w-8" />}
                title="圏外申請の承認"
                description="圏外で記録された打刻の確認・承認"
                color="primary"
                onClick={() => navigate("/pending-punches")}
              />
            )}
            {isAdmin && (
              <MenuCard
                icon={<FileWarning className="h-8 w-8" />}
                title="📑 警告レポート"
                description="荷主別・取適法リスク診断"
                color="primary"
                onClick={() => navigate("/report")}
              />
            )}
          </div>

        </section>
      </main>

      {/* Bottom Navigation */}
      <BottomNav />
    </div>
  );
}




// ── Sub-components ──────────────────────────────────────────

function KpiCard({ label, count, colorClass }: { label: string; count: number; colorClass: string }) {
  return (
    <div className={`flex h-[80px] flex-col items-center justify-center rounded-xl ${colorClass} px-2`}>
      <span className="text-2xl font-extrabold leading-none">{count}</span>
      <span className="mt-1 text-xs font-medium opacity-80">{label}</span>
    </div>
  );
}

function MenuCard({
  icon,
  title,
  description,
  color,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  color: "accent" | "primary";
  onClick?: () => void;
}) {
  return (
    <button onClick={onClick} className="flex items-center gap-4 rounded-2xl border border-border bg-card p-5 text-left shadow-sm transition-all hover:shadow-md active:scale-[0.98]">
      <div
        className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-xl ${
          color === "accent"
            ? "bg-accent text-accent-foreground"
            : "bg-primary text-primary-foreground"
        }`}
      >
        {icon}
      </div>
      <div>
        <h3 className="text-lg font-bold text-card-foreground">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </button>
  );
}
