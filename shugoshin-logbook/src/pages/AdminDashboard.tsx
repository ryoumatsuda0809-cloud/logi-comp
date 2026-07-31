import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

import { BottomNav } from "@/components/BottomNav";
import {
  Megaphone,
  Play,
  CheckCircle2,
  Clock,
  ChevronDown,
  ChevronUp,
  Truck,
  RefreshCw,
  
} from "lucide-react";

/* ─── 型定義 ─── */
interface WaitLog {
  id: string;
  facility_id: string;
  user_id: string;
  ticket_number: number;
  status: string | null;
  arrival_time: string;
  called_time: string | null;
  work_start_time: string | null;
  work_end_time: string | null;
}

interface Facility {
  id: string;
  name: string;
  client_name: string;
}

interface ActivityEntry {
  id: string;
  timestamp: Date;
  ticketNumber: number;
  eventType: "arrival" | "called" | "working" | "completed";
  message: string;
  icon: string;
}

const MAX_ACTIVITIES = 50;

/* ─── ステータス設定 ─── */
const STATUS_CONFIG: Record<string, {
  label: string;
  color: string;
  bgColor: string;
  borderColor: string;
  icon: typeof Clock;
}> = {
  waiting: {
    label: "待機中",
    color: "text-amber-700",
    bgColor: "bg-amber-50",
    borderColor: "border-amber-300",
    icon: Clock,
  },
  called: {
    label: "呼出済",
    color: "text-blue-700",
    bgColor: "bg-blue-50",
    borderColor: "border-blue-300",
    icon: Megaphone,
  },
  working: {
    label: "作業中",
    color: "text-emerald-700",
    bgColor: "bg-emerald-50",
    borderColor: "border-emerald-300",
    icon: Play,
  },
};

const ACTION_CONFIG: Record<string, {
  label: string;
  nextStatus: string;
  variant: "default" | "destructive" | "outline" | "secondary";
  icon: typeof Megaphone;
}> = {
  waiting: { label: "📢 呼出", nextStatus: "called", variant: "default", icon: Megaphone },
  called: { label: "▶ 作業開始", nextStatus: "working", variant: "secondary", icon: Play },
  working: { label: "✅ 完了", nextStatus: "completed", variant: "outline", icon: CheckCircle2 },
};

const EVENT_ICONS: Record<string, string> = {
  arrival: "🚚",
  called: "📢",
  working: "▶️",
  completed: "✅",
};

const EVENT_LABELS: Record<string, string> = {
  arrival: "到着",
  called: "呼出",
  working: "作業開始",
  completed: "完了",
};

/* ─── 経過時間ヘルパー ─── */
function formatElapsed(fromIso: string): string {
  const diff = Date.now() - new Date(fromIso).getTime();
  const totalMin = Math.max(0, Math.floor(diff / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}時間${m}分` : `${m}分`;
}

function formatTime(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

/* ─── WaitLogCard ─── */
function WaitLogCard({
  log,
  onAction,
  loading,
}: {
  log: WaitLog;
  onAction: (logId: string, nextStatus: string) => void;
  loading: boolean;
}) {
  const status = log.status || "waiting";
  const cfg = STATUS_CONFIG[status];
  const action = ACTION_CONFIG[status];

  if (!cfg) return null;

  const Icon = cfg.icon;

  return (
    <Card className={`border-2 ${cfg.borderColor} ${cfg.bgColor} transition-all`}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-4xl font-black tabular-nums tracking-tight">
            #{String(log.ticket_number).padStart(3, "0")}
          </span>
          <Badge className={`${cfg.bgColor} ${cfg.color} border ${cfg.borderColor}`}>
            <Icon className="mr-1 h-3 w-3" />
            {cfg.label}
          </Badge>
        </div>

        <div className="text-sm space-y-1">
          <div className="flex justify-between">
            <span className="text-muted-foreground">到着</span>
            <span className="font-medium">{formatTime(log.arrival_time)}</span>
          </div>
          {status === "waiting" && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">待機</span>
              <span className="font-bold text-amber-600">{formatElapsed(log.arrival_time)}</span>
            </div>
          )}
          {log.called_time && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">呼出</span>
              <span className="font-medium">{formatTime(log.called_time)}</span>
            </div>
          )}
          {log.work_start_time && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">開始</span>
              <span className="font-medium">{formatTime(log.work_start_time)}</span>
            </div>
          )}
        </div>

        {action && (
          <Button
            className="w-full text-base font-bold h-12"
            variant={action.variant}
            disabled={loading}
            onClick={() => onAction(log.id, action.nextStatus)}
          >
            {action.label}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── KanbanColumn ─── */
function KanbanColumn({
  status,
  logs,
  onAction,
  loadingId,
  recentActivities,
}: {
  status: string;
  logs: WaitLog[];
  onAction: (logId: string, nextStatus: string) => void;
  loadingId: string | null;
  recentActivities: ActivityEntry[];
}) {
  const cfg = STATUS_CONFIG[status];
  if (!cfg) return null;
  const Icon = cfg.icon;

  return (
    <div className="flex-1 min-w-[280px]">
      <div className={`flex items-center gap-2 mb-3 px-2 py-2 rounded-lg ${cfg.bgColor}`}>
        <Icon className={`h-5 w-5 ${cfg.color}`} />
        <h2 className={`text-lg font-bold ${cfg.color}`}>{cfg.label}</h2>
        <Badge variant="secondary" className="ml-auto text-sm">{logs.length}</Badge>
      </div>

      {recentActivities.length > 0 && (
        <div className="mb-2 space-y-1">
          {recentActivities.map((a) => (
            <div key={a.id}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md
                         bg-primary/5 border border-primary/10
                         text-xs text-muted-foreground animate-in fade-in">
              <span>{a.icon}</span>
              <span className="truncate font-medium">{a.message}</span>
              <span className="ml-auto whitespace-nowrap">
                {formatElapsed(a.timestamp.toISOString())}前
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-3">
        {logs.length === 0 && (
          <p className="text-center text-muted-foreground py-8 text-sm">なし</p>
        )}
        {logs.map((log) => (
          <WaitLogCard
            key={log.id}
            log={log}
            onAction={onAction}
            loading={loadingId === log.id}
          />
        ))}
      </div>
    </div>
  );
}

/* ─── CompletedRow ─── */
function CompletedRow({ log }: { log: WaitLog }) {
  return (
    <div className="flex items-center gap-2 text-sm py-2 border-b last:border-b-0">
      <span className="font-bold w-12">#{String(log.ticket_number).padStart(3, "0")}</span>
      <span className="text-muted-foreground">
        到着{formatTime(log.arrival_time)} → 呼出{formatTime(log.called_time)} → 開始{formatTime(log.work_start_time)} → 完了{formatTime(log.work_end_time)}
      </span>
    </div>
  );
}

/* ─── STATUS_TO_EVENT マッピング ─── */
const STATUS_TO_EVENT: Record<string, ActivityEntry["eventType"][]> = {
  waiting: ["arrival"],
  called: ["called"],
  working: ["working"],
};

/* ─── メインコンポーネント ─── */
export default function AdminDashboard() {
  const { user: _user } = useAuth();
  const { toast } = useToast();

  const navigate = useNavigate();

  const [logs, setLogs] = useState<WaitLog[]>([]);
  const [completedLogs, setCompletedLogs] = useState<WaitLog[]>([]);
  const [pendingPunchCount, setPendingPunchCount] = useState(0);
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [selectedFacilityId, setSelectedFacilityId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [isCompletedOpen, setIsCompletedOpen] = useState(false);
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const [, setTick] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval>>();
  const logsRef = useRef<WaitLog[]>([]);

  // テナント情報
  const [orgName, setOrgName] = useState<string | null>(null);
  const [orgLoading, setOrgLoading] = useState(true);
  const [showOnboarding, setShowOnboarding] = useState(false);

  // logsRefを常に最新に保つ
  useEffect(() => {
    logsRef.current = logs;
  }, [logs]);

  // 1分ごとに再描画（経過時間更新）
  useEffect(() => {
    tickRef.current = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(tickRef.current);
  }, []);

  // 組織名の取得
  useEffect(() => {
    if (!_user) return;
    setOrgLoading(true);
    supabase
      .from("profiles")
      .select("organization_id")
      .eq("user_id", _user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (!data?.organization_id) {
          setOrgLoading(false);
          return;
          return;
        }
        supabase
          .from("organizations")
          .select("name")
          .eq("id", data.organization_id)
          .maybeSingle()
          .then(({ data: org }) => {
            if (org?.name) {
              setOrgName(org.name);
              // 初回確認が済んでいなければオンボーディングを表示
              const alreadyOnboarded = localStorage.getItem(`onboarded_admin_${_user.id}`);
              if (!alreadyOnboarded) {
                setShowOnboarding(true);
              }
            } else {
            }
            setOrgLoading(false);
          });
      });
  }, [_user]);

  // 施設一覧を取得（テナントフィルタ付き）
  useEffect(() => {
    if (!orgName) return;
    supabase
      .from("facilities")
      .select("id, name, client_name")
      .eq("client_name", orgName)
      .then(({ data }) => {
        if (data && data.length > 0) {
          setFacilities(data);
          setSelectedFacilityId(data[0].id);
        }
      });
  }, [orgName]);

  // 初期データ取得
  const fetchLogs = useCallback(async () => {
    if (!selectedFacilityId) return;
    const today = new Date().toLocaleDateString("sv-SE");

    const { data: active } = await supabase
      .from("wait_logs")
      .select("*")
      .eq("facility_id", selectedFacilityId)
      .in("status", ["waiting", "called", "working"])
      .gte("arrival_time", `${today}T00:00:00+09:00`)
      .order("ticket_number", { ascending: true });

    if (active) setLogs(active);

    const { data: completed } = await supabase
      .from("wait_logs")
      .select("*")
      .eq("facility_id", selectedFacilityId)
      .eq("status", "completed")
      .gte("arrival_time", `${today}T00:00:00+09:00`)
      .order("ticket_number", { ascending: true });

    if (completed) setCompletedLogs(completed);

    // 圏外申請の承認待ち件数。RLSにより自組織の分だけが返る。
    // 施設で絞らないのは、申請時点で拠点が特定できなかった分も拾うため。
    const { count } = await supabase
      .from("pending_punches")
      .select("id", { count: "exact", head: true })
      .eq("review_status", "pending");

    setPendingPunchCount(count ?? 0);
  }, [selectedFacilityId]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // 施設切替時にフィードをクリア
  useEffect(() => {
    setActivities([]);
  }, [selectedFacilityId]);

  // Realtime購読
  useEffect(() => {
    if (!selectedFacilityId) return;

    const channel = supabase
      .channel("wait-logs-realtime")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "wait_logs",
          filter: `facility_id=eq.${selectedFacilityId}`,
        },
        (payload) => {
          // 既存ロジック維持
          fetchLogs();

          // フィード用エントリ生成
          const rec = payload.new as WaitLog;
          if (!rec || !rec.ticket_number) return;

          const eventType: ActivityEntry["eventType"] =
            payload.eventType === "INSERT"
              ? "arrival"
              : (rec.status as ActivityEntry["eventType"]) || "arrival";

          const icon = EVENT_ICONS[eventType] || "📋";
          const label = EVENT_LABELS[eventType] || "更新";
          const ticketStr = `#${String(rec.ticket_number).padStart(3, "0")}`;

          // 施設名を補完
          const facility = facilities.find((f) => f.id === rec.facility_id);
          const prefix = facility ? `[${facility.client_name}] ` : "";

          const message = `${prefix}${ticketStr} ${label}`;

          setActivities((prev) =>
            [
              {
                id: crypto.randomUUID(),
                timestamp: new Date(),
                ticketNumber: rec.ticket_number,
                eventType,
                message,
                icon,
              },
              ...prev,
            ].slice(0, MAX_ACTIVITIES)
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [selectedFacilityId, fetchLogs, facilities]);

  // ステータス進行アクション
  const handleAction = useCallback(
    async (logId: string, nextStatus: string) => {
      setLoadingId(logId);
      try {
        const { error } = await supabase.rpc("advance_wait_status", {
          p_log_id: logId,
          p_new_status: nextStatus,
        });
        if (error) {
          toast({ title: "操作に失敗しました", description: error.message, variant: "destructive" });
        }
        await fetchLogs();
      } catch {
        toast({ title: "通信エラー", variant: "destructive" });
      } finally {
        setLoadingId(null);
      }
    },
    [fetchLogs, toast]
  );

  const waitingLogs = logs.filter((l) => l.status === "waiting");
  const calledLogs = logs.filter((l) => l.status === "called");
  const workingLogs = logs.filter((l) => l.status === "working");

  // 組織未登録の場合
  if (!orgLoading && !orgName) {
    return (
      <div className="min-h-screen bg-background pb-20">
        <header className="sticky top-0 z-30 bg-primary px-4 py-3 shadow-md">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent">
              <img src="/icon-192.png" alt="守護神" className="h-6 w-6 rounded" />
            </div>
            <h1 className="text-lg font-bold text-primary-foreground">管理ダッシュボード</h1>
          </div>
        </header>
        <div className="flex flex-col items-center justify-center gap-6 p-8 pt-24">
          <div className="text-6xl">🏢</div>
          <h2 className="text-xl font-bold">組織設定が完了していません</h2>
          <p className="text-muted-foreground text-center max-w-md">
            カンバンを使用するには、まず組織の登録が必要です。<br />
            設定画面から組織を作成するか、招待コードで参加してください。
          </p>
          <Button size="lg" className="text-base font-bold h-12" onClick={() => navigate("/settings/organization")}>
            組織設定へ進む
          </Button>
        </div>
        <BottomNav />
      </div>
    );
  }

  // ローディング中
  if (orgLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-muted-foreground">読み込み中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-20">
      {/* 初回確認ダイアログ */}
      <Dialog open={showOnboarding} onOpenChange={() => {}}>
        <DialogContent className="sm:max-w-md [&>button]:hidden" onPointerDownOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle className="text-xl">所属組織の確認</DialogTitle>
            <DialogDescription className="text-base pt-2">
              あなたの所属組織は以下の通りです。この組織のカンバンを表示してよろしいですか？
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-3 p-4 rounded-lg bg-primary/5 border border-primary/10">
            <span className="text-3xl">🏢</span>
            <span className="text-lg font-bold">{orgName}</span>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => navigate("/settings/organization")}>
              いいえ、設定をやり直す
            </Button>
            <Button
              className="font-bold"
              onClick={() => {
                setShowOnboarding(false);
                localStorage.setItem(`onboarded_admin_${_user?.id}`, "true");
              }}
            >
              はい、この組織で始める
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ヘッダー */}
      <header className="sticky top-0 z-30 bg-primary px-4 py-3 shadow-md">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent">
              <img src="/icon-192.png" alt="守護神" className="h-6 w-6 rounded" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-primary-foreground">管理ダッシュボード</h1>
              <p className="text-xs text-primary-foreground/60">🏢 {orgName}</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* 圏外申請は放置するとドライバーが待機料を請求できないままになる。
                件数を常に見せて承認画面への導線にする。 */}
            <Button
              size="sm"
              variant={pendingPunchCount > 0 ? "secondary" : "ghost"}
              className={pendingPunchCount > 0 ? "font-bold" : "text-primary-foreground/70"}
              onClick={() => navigate("/pending-punches")}
            >
              圏外申請
              {pendingPunchCount > 0 && (
                <span className="ml-1 rounded-full bg-destructive px-2 py-0.5 text-xs text-destructive-foreground">
                  {pendingPunchCount}
                </span>
              )}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="text-primary-foreground"
              onClick={fetchLogs}
            >
              <RefreshCw className="h-5 w-5" />
            </Button>
          </div>
        </div>

        {facilities.length > 1 && (
          <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
            {facilities.map((f) => (
              <Button
                key={f.id}
                size="sm"
                variant={f.id === selectedFacilityId ? "secondary" : "ghost"}
                className={f.id === selectedFacilityId ? "" : "text-primary-foreground/70"}
                onClick={() => setSelectedFacilityId(f.id)}
              >
                {f.name}
              </Button>
            ))}
          </div>
        )}
      </header>

      {/* サマリーバー */}
      <div className="flex gap-2 px-4 py-3 border-b">
        <div className="flex items-center gap-1 text-sm">
          <Truck className="h-4 w-4 text-muted-foreground" />
          <span className="font-bold">{logs.length}</span>
          <span className="text-muted-foreground">台 待機中</span>
        </div>
        <div className="ml-auto text-xs text-muted-foreground">
          完了: {completedLogs.length}台
        </div>
      </div>

      {/* メインコンテンツ: カンバン */}
      <div className="p-4">
        <div className="flex flex-col lg:flex-row gap-6">
          <KanbanColumn
            status="waiting"
            logs={waitingLogs}
            onAction={handleAction}
            loadingId={loadingId}
            recentActivities={activities.filter((a) => STATUS_TO_EVENT["waiting"]?.includes(a.eventType)).slice(0, 2)}
          />
          <KanbanColumn
            status="called"
            logs={calledLogs}
            onAction={handleAction}
            loadingId={loadingId}
            recentActivities={activities.filter((a) => STATUS_TO_EVENT["called"]?.includes(a.eventType)).slice(0, 2)}
          />
          <KanbanColumn
            status="working"
            logs={workingLogs}
            onAction={handleAction}
            loadingId={loadingId}
            recentActivities={activities.filter((a) => STATUS_TO_EVENT["working"]?.includes(a.eventType)).slice(0, 2)}
          />
        </div>
      </div>

      {/* 完了済みセクション */}
      {completedLogs.length > 0 && (
        <div className="px-4 pb-4">
          <Collapsible open={isCompletedOpen} onOpenChange={setIsCompletedOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" className="w-full justify-between text-muted-foreground">
                <span>本日の完了済み ({completedLogs.length}件)</span>
                {isCompletedOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <Card className="mt-2">
                <CardContent className="p-4">
                  {completedLogs.map((log) => (
                    <CompletedRow key={log.id} log={log} />
                  ))}
                </CardContent>
              </Card>
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}

      <BottomNav />
    </div>
  );
}
