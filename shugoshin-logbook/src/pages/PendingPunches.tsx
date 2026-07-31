import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Loader2, MapPin, Clock, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Textarea } from "@/components/ui/textarea";
import { formatArrivalDateTime, formatElapsed } from "@/lib/staleTicket";

/**
 * 圏外申請の承認画面（オフライン打刻 Phase 2）
 *
 * 【この画面が担っている判断】
 * ドライバーの主張時刻(claimed_at)はサーバーが検証できない。検証できるのは
 * 「サーバーに届いた時刻(received_at)より前である」ことだけで、端末時計を
 * 巻き戻せば任意の過去を主張できる。技術で埋められないこの差を、
 * 管理者が材料を見て判断することで埋めるのがこの画面の役割。
 *
 * したがって承認しても等級Aにはならない。承認は「会社としてこの申告を認める」
 * 意思表示であって、サーバーが時刻を検証した事実ではない。
 * 承認された記録は wait_logs に等級Cとして入り、荷主向けの提示でも区別される。
 */

interface PendingPunchRow {
  id: string;
  user_id: string;
  punch_type: string;
  claimed_at: string;
  received_at: string;
  latitude: number;
  longitude: number;
  gps_accuracy_m: number | null;
  distance_m: number | null;
  within_geofence: boolean | null;
  driver_note: string | null;
  wait_log_id: string | null;
  facility_id: string | null;
  review_status: string;
  facilityName?: string;
  driverName?: string;
}

const PUNCH_TYPE_LABELS: Record<string, string> = {
  arrival: "到着打刻",
  completion: "作業完了打刻",
};

export default function PendingPunches() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();

  const [rows, setRows] = useState<PendingPunchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const fetchRows = useCallback(async () => {
    setLoading(true);

    const { data, error } = await supabase
      .from("pending_punches")
      .select("*")
      .eq("review_status", "pending")
      .order("claimed_at", { ascending: true });

    if (error || !data) {
      setRows([]);
      setLoading(false);
      return;
    }

    // 施設名とドライバー名を引き当てる（承認判断の材料として表示する）
    const facilityIds = [...new Set(data.map((r) => r.facility_id).filter(Boolean))] as string[];
    const userIds = [...new Set(data.map((r) => r.user_id))];

    const [facilitiesRes, profilesRes] = await Promise.all([
      facilityIds.length > 0
        ? supabase.from("facilities").select("id, name").in("id", facilityIds)
        : Promise.resolve({ data: [] as { id: string; name: string }[] }),
      supabase.from("profiles").select("user_id, display_name").in("user_id", userIds),
    ]);

    const facilityMap = new Map((facilitiesRes.data ?? []).map((f) => [f.id, f.name]));
    const driverMap = new Map(
      (profilesRes.data ?? []).map((p) => [p.user_id, p.display_name ?? "名称未設定"])
    );

    setRows(
      data.map((r) => ({
        ...r,
        facilityName: r.facility_id ? facilityMap.get(r.facility_id) : undefined,
        driverName: driverMap.get(r.user_id),
      }))
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  const handleApprove = async (row: PendingPunchRow) => {
    setBusyId(row.id);
    const { error } = await supabase.rpc("approve_pending_punch", {
      p_punch_id: row.id,
      p_review_note: notes[row.id]?.trim() || null,
    });
    setBusyId(null);

    if (error) {
      toast({
        variant: "destructive",
        title: "承認できませんでした",
        description: error.message ?? "再試行してください。",
      });
      return;
    }

    toast({
      title: "承認しました",
      description:
        row.user_id === user?.id
          ? "自己承認として記録しました。荷主向けの提示にもその旨が表示されます。"
          : "正式な打刻として記録されました。",
    });
    void fetchRows();
  };

  const handleReject = async (row: PendingPunchRow) => {
    const note = notes[row.id]?.trim();
    if (!note) {
      toast({
        variant: "destructive",
        title: "却下理由が必要です",
        description: "理由が伝わらないとドライバーは再申請の判断ができません。",
      });
      return;
    }

    setBusyId(row.id);
    const { error } = await supabase.rpc("reject_pending_punch", {
      p_punch_id: row.id,
      p_review_note: note,
    });
    setBusyId(null);

    if (error) {
      toast({
        variant: "destructive",
        title: "却下できませんでした",
        description: error.message ?? "再試行してください。",
      });
      return;
    }

    toast({ title: "却下しました", description: "記録は監査証跡として残ります。" });
    void fetchRows();
  };

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate("/admin")}>
            <ArrowLeft className="mr-1 h-4 w-4" />
            戻る
          </Button>
          <h1 className="text-xl font-bold">圏外打刻の承認</h1>
        </div>

        <Alert>
          <AlertTitle>承認の意味</AlertTitle>
          <AlertDescription className="text-xs leading-relaxed">
            ドライバーが主張する時刻はサーバーで検証できません（端末の時計は変更できるため）。
            承認は「会社としてこの申告を認める」判断であり、
            <strong>サーバーが時刻を検証した記録にはなりません</strong>。
            承認された記録は荷主向けの帳票でも通常の打刻と区別して表示されます。
            GPS座標と拠点からの距離は打刻時点の実測値なので、判断材料にしてください。
          </AlertDescription>
        </Alert>

        {loading && (
          <div className="flex items-center justify-center gap-2 p-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            読み込み中...
          </div>
        )}

        {!loading && rows.length === 0 && (
          <div className="rounded-xl border border-dashed p-12 text-center text-muted-foreground">
            承認待ちの申請はありません。
          </div>
        )}

        {rows.map((row) => {
          const isSelf = row.user_id === user?.id;
          const outOfRange = row.within_geofence === false;
          const noFacility = row.facility_id === null;
          const lag = formatElapsed(
            Math.max(0, new Date(row.received_at).getTime() - new Date(row.claimed_at).getTime())
          );

          return (
            <div key={row.id} className="rounded-xl border bg-card p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-bold">
                    {PUNCH_TYPE_LABELS[row.punch_type] ?? row.punch_type}
                    {row.facilityName && ` — ${row.facilityName}`}
                  </p>
                  <p className="text-sm text-muted-foreground">{row.driverName ?? "不明な運転者"}</p>
                </div>
                {isSelf && (
                  <span className="shrink-0 rounded-full bg-amber-100 dark:bg-amber-900/40 px-3 py-1 text-xs font-bold text-amber-900 dark:text-amber-200">
                    自分の申請
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-lg bg-muted p-2">
                  <p className="text-xs text-muted-foreground">主張する打刻時刻（未検証）</p>
                  <p className="font-mono font-bold">{formatArrivalDateTime(row.claimed_at)}</p>
                </div>
                <div className="rounded-lg bg-muted p-2">
                  <p className="text-xs text-muted-foreground">サーバー受信時刻</p>
                  <p className="font-mono font-bold">{formatArrivalDateTime(row.received_at)}</p>
                </div>
              </div>

              <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  圏外だった時間: 最大 {lag}
                </span>
                <span className="flex items-center gap-1">
                  <MapPin className="h-3 w-3" />
                  拠点から {row.distance_m != null ? `約${Math.round(row.distance_m)}m` : "不明"}
                  {row.gps_accuracy_m != null && `（測位精度 ±${Math.round(row.gps_accuracy_m)}m）`}
                </span>
              </div>

              {row.driver_note && (
                <p className="rounded-lg bg-muted p-2 text-sm">
                  <span className="text-xs text-muted-foreground">運転者の申告理由: </span>
                  {row.driver_note}
                </p>
              )}

              {(outOfRange || noFacility) && (
                <Alert variant="destructive">
                  <AlertTitle className="flex items-center gap-2 text-sm">
                    <AlertTriangle className="h-4 w-4" />
                    この申請は承認できません
                  </AlertTitle>
                  <AlertDescription className="text-xs">
                    {noFacility
                      ? "近傍に登録拠点がありません。拠点を登録すれば承認できるようになります。"
                      : "拠点の範囲外で記録されています。拠点の範囲設定が実態に合っていない場合は設定を修正してください。修正後は承認できるようになります。"}
                  </AlertDescription>
                </Alert>
              )}

              <Textarea
                placeholder="審査メモ（却下する場合は必須）"
                value={notes[row.id] ?? ""}
                onChange={(e) => setNotes((prev) => ({ ...prev, [row.id]: e.target.value }))}
                rows={2}
                className="text-sm"
              />

              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  disabled={busyId === row.id || outOfRange || noFacility}
                  onClick={() => handleApprove(row)}
                >
                  {busyId === row.id ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                  )}
                  承認する
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 border-destructive text-destructive hover:bg-destructive/10"
                  disabled={busyId === row.id}
                  onClick={() => handleReject(row)}
                >
                  <XCircle className="mr-2 h-4 w-4" />
                  却下する
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
