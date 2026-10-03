import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Lock, MapPin, Pause, Play, ShieldCheck } from "lucide-react";
import { haversineDistance } from "@/lib/haversine";
import { calcWaitCost, getRate, sumWaitCost, vehicleClassLabel } from "@/lib/waitCostCalc";
import {
  convertWaitLogsToTimeline,
  diffMinutes,
  effectiveArrival,
  isBillableWaitLog,
  loadingStartedAt,
} from "@/lib/waitLogToTimeline";
import {
  DEMO_FACILITIES,
  DEMO_FACILITY_NAMES,
  DEMO_GEOFENCE_RADIUS_M,
  DEMO_TRACK,
  DEMO_TRACK_EVENTS,
  DEMO_VEHICLE_CLASS,
  DEMO_WAIT_LOGS,
} from "@/demo/demoData";

const VIEW_HALF_M = 1300;

/** 端末のタイムゾーンに関係なく日本時間で HH:MM を出す（デモは常に日本の1日を再現する） */
const jstFormatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
function formatTimeOrNull(iso: string | null): string {
  if (!iso) return "未記録";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "未記録" : jstFormatter.format(d);
}
const M_PER_DEG_LAT = 110540;
const origin = DEMO_FACILITIES[0];

function toLocalMeters(lat: number, lng: number) {
  const mPerDegLng = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  return { x: (lng - origin.lng) * mPerDegLng, y: (lat - origin.lat) * M_PER_DEG_LAT };
}

const EVENT_LABEL: Record<string, string> = {
  arrival: "到着打刻",
  waiting_start: "荷役開始（荷待ち終了）",
  departure: "作業完了",
  work_end: "作業完了",
};

const PHASE_LABEL: Record<string, string> = {
  approach: "施設へ接近中",
  waiting: "待機列で停車中",
  loading: "荷役中",
  departure: "退出中",
};

function GpsPanel() {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const last = DEMO_TRACK.length - 1;

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setIndex((i) => {
        if (i >= last) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, 180);
    return () => clearInterval(id);
  }, [playing, last]);

  const current = DEMO_TRACK[index];
  const distance = Math.round(haversineDistance(current.lat, current.lng, origin.lat, origin.lng));
  const inFence = distance <= DEMO_GEOFENCE_RADIUS_M;
  const stamped = new Date(current.t) >= new Date(DEMO_WAIT_LOGS[0].arrival_time);

  const pts = useMemo(
    () => DEMO_TRACK.map((p) => toLocalMeters(p.lat, p.lng)),
    [],
  );
  // SVG は y 軸が下向きなので南北を反転する
  const sx = (x: number) => x + VIEW_HALF_M;
  const sy = (y: number) => VIEW_HALF_M - y;
  const trail = pts
    .slice(0, index + 1)
    .map((p) => `${sx(p.x)},${sy(p.y)}`)
    .join(" ");
  const cur = pts[index];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <MapPin className="h-4 w-4" /> GPS とジオフェンス
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <svg
          viewBox={`0 0 ${VIEW_HALF_M * 2} ${VIEW_HALF_M * 2}`}
          className="w-full rounded-lg border bg-muted/40"
          role="img"
          aria-label="施設周辺のGPS軌跡"
        >
          {[-1000, -500, 0, 500, 1000].map((g) => (
            <g key={g} className="stroke-border" strokeWidth={4}>
              <line x1={sx(g)} y1={0} x2={sx(g)} y2={VIEW_HALF_M * 2} />
              <line x1={0} y1={sy(g)} x2={VIEW_HALF_M * 2} y2={sy(g)} />
            </g>
          ))}
          <circle
            cx={sx(0)}
            cy={sy(0)}
            r={DEMO_GEOFENCE_RADIUS_M}
            className={inFence ? "fill-primary/15 stroke-primary" : "fill-muted/60 stroke-muted-foreground"}
            strokeWidth={8}
            strokeDasharray="30 20"
          />
          <polyline points={trail} fill="none" className="stroke-primary" strokeWidth={10} />
          <rect x={sx(0) - 28} y={sy(0) - 28} width={56} height={56} className="fill-foreground" />
          <circle cx={sx(cur.x)} cy={sy(cur.y)} r={34} className="fill-destructive stroke-background" strokeWidth={10} />
          <text x={sx(0) + 40} y={sy(0) - 40} className="fill-foreground text-[88px] font-semibold">
            施設
          </text>
          <text x={sx(0) + DEMO_GEOFENCE_RADIUS_M * 0.72} y={sy(0) - DEMO_GEOFENCE_RADIUS_M * 0.72 - 20} className="fill-muted-foreground text-[80px]">
            500m
          </text>
        </svg>

        <div className="grid grid-cols-3 gap-2 text-center text-sm">
          <div className="rounded-lg border p-2">
            <div className="text-xs text-muted-foreground">時刻</div>
            <div className="font-semibold tabular-nums">{formatTimeOrNull(current.t)}</div>
          </div>
          <div className="rounded-lg border p-2">
            <div className="text-xs text-muted-foreground">施設までの距離</div>
            <div className="font-semibold tabular-nums">{distance.toLocaleString()} m</div>
          </div>
          <div className="rounded-lg border p-2">
            <div className="text-xs text-muted-foreground">状態</div>
            <div className="font-semibold">{PHASE_LABEL[current.phase]}</div>
          </div>
        </div>

        <Button className="w-full" disabled={!inFence || stamped} variant={stamped ? "secondary" : "default"}>
          {stamped ? (
            <>
              <ShieldCheck className="mr-2 h-4 w-4" />
              打刻済み　整理券 {DEMO_WAIT_LOGS[0].ticket_number} 番（サーバー時刻 {formatTimeOrNull(DEMO_WAIT_LOGS[0].arrival_time)}）
            </>
          ) : inFence ? (
            "到着打刻"
          ) : (
            <>
              <Lock className="mr-2 h-4 w-4" />
              500m圏外のため打刻できません
            </>
          )}
        </Button>

        <div className="flex items-center gap-3">
          <Button
            size="icon"
            variant="outline"
            aria-label={playing ? "一時停止" : "再生"}
            onClick={() => {
              if (!playing && index >= last) setIndex(0);
              setPlaying((p) => !p);
            }}
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>
          <Slider
            value={[index]}
            min={0}
            max={last}
            step={1}
            onValueChange={(v) => {
              setPlaying(false);
              setIndex(v[0]);
            }}
          />
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          {DEMO_TRACK_EVENTS.map((e) => (
            <button
              key={e.label}
              type="button"
              className="rounded-full border px-2 py-0.5 hover:bg-muted"
              onClick={() => {
                const i = DEMO_TRACK.findIndex((p) => new Date(p.t) >= new Date(e.t));
                setPlaying(false);
                setIndex(i < 0 ? last : i);
              }}
            >
              {formatTimeOrNull(e.t)} {e.label}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}


type KanbanStatus = "waiting" | "called" | "working";
interface KanbanTicket {
  no: number;
  arrival: string;
  status: KanbanStatus;
  calledAt?: string;
  startedAt?: string;
}

/** 荷主カンバンの再現用。時刻は固定（デモは常に 09:10 の時点） */
const KANBAN_NOW = "2026-10-03T09:10:00+09:00";
const KANBAN_INITIAL: KanbanTicket[] = [
  { no: 13, arrival: "2026-10-03T08:20:00+09:00", status: "working", calledAt: "2026-10-03T08:38:00+09:00", startedAt: "2026-10-03T08:41:00+09:00" },
  { no: 14, arrival: "2026-10-03T08:05:00+09:00", status: "called", calledAt: "2026-10-03T09:08:00+09:00" },
  { no: 15, arrival: "2026-10-03T08:50:00+09:00", status: "waiting" },
  { no: 16, arrival: "2026-10-03T09:02:00+09:00", status: "waiting" },
];

const KANBAN_COLUMNS: { status: KanbanStatus; label: string; action?: { label: string; next: KanbanStatus } }[] = [
  { status: "waiting", label: "待機中", action: { label: "呼出", next: "called" } },
  { status: "called", label: "呼出済", action: { label: "荷役開始", next: "working" } },
  { status: "working", label: "荷役中" },
];

function elapsedMinutes(from: string) {
  return Math.max(0, Math.round((new Date(KANBAN_NOW).getTime() - new Date(from).getTime()) / 60000));
}

function KanbanPanel() {
  const [tickets, setTickets] = useState<KanbanTicket[]>(KANBAN_INITIAL);

  const advance = (no: number, next: KanbanStatus) =>
    setTickets((list) =>
      list.map((t) =>
        t.no !== no
          ? t
          : {
              ...t,
              status: next,
              calledAt: next === "called" ? KANBAN_NOW : t.calledAt,
              startedAt: next === "working" ? KANBAN_NOW : t.startedAt,
            },
      ),
    );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">荷主側の画面（施設の待機状況）</CardTitle>
        <p className="text-xs text-muted-foreground">
          {DEMO_FACILITIES[0].name}・{formatTimeOrNull(KANBAN_NOW)} 時点。ボタンを押すと、実際の画面と同じように動きます。
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          {KANBAN_COLUMNS.map((col) => {
            const items = tickets.filter((t) => t.status === col.status);
            return (
              <div key={col.status} className="rounded-lg border bg-muted/30 p-2">
                <div className="mb-2 flex items-center justify-between text-sm font-medium">
                  <span>{col.label}</span>
                  <Badge variant="secondary">{items.length}</Badge>
                </div>
                <div className="space-y-2">
                  {items.length === 0 && (
                    <p className="py-3 text-center text-xs text-muted-foreground">なし</p>
                  )}
                  {items.map((t) => (
                    <div key={t.no} className="rounded-md border bg-background p-3 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-xl font-bold tabular-nums">#{String(t.no).padStart(3, "0")}</span>
                        {col.status === "waiting" && (
                          <span className="text-xs font-semibold text-amber-600 tabular-nums">
                            待機 {elapsedMinutes(t.arrival)}分
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                        到着 {formatTimeOrNull(t.arrival)}
                        {t.calledAt && <>　呼出 {formatTimeOrNull(t.calledAt)}</>}
                        {t.startedAt && <>　開始 {formatTimeOrNull(t.startedAt)}</>}
                      </div>
                      {col.action && (
                        <Button
                          size="sm"
                          className="mt-2 w-full"
                          onClick={() => advance(t.no, col.action!.next)}
                        >
                          {col.action.label}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          荷主側のボタンは「呼出」と「荷役開始」までです。完了は、GPS と署名を伴うドライバー側の打刻だけが確定させます。荷主が完了にできないことで、記録の信頼性を保っています。
        </p>
        <Button variant="outline" size="sm" onClick={() => setTickets(KANBAN_INITIAL)}>
          最初の状態に戻す
        </Button>
      </CardContent>
    </Card>
  );
}

function FeePanel() {
  const rate = getRate(DEMO_VEHICLE_CLASS);
  const summary = useMemo(
    () => convertWaitLogsToTimeline(DEMO_WAIT_LOGS, DEMO_FACILITY_NAMES),
    [],
  );
  const total = sumWaitCost(summary.waitMinutesPerEvent, DEMO_VEHICLE_CLASS);

  const rows = DEMO_WAIT_LOGS.filter(isBillableWaitLog).map((log) => {
    const mins = diffMinutes(effectiveArrival(log), loadingStartedAt(log));
    return {
      log,
      mins,
      fee: mins === null ? null : calcWaitCost(mins, DEMO_VEHICLE_CLASS),
    };
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          待機料の算定（{vehicleClassLabel(DEMO_VEHICLE_CLASS)}・{rate}円/分・30分超過分のみ）
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-2">
          {rows.map(({ log, mins, fee }) => (
            <li key={log.id} className="rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{DEMO_FACILITY_NAMES[log.facility_id]}</span>
                <Badge variant={log.evidence_grade === "C" ? "outline" : "secondary"}>
                  {log.evidence_grade === "C" ? "等級C：承認済みの申告" : "等級A：サーバー検証済"}
                </Badge>
              </div>
              <div className="mt-1 flex items-baseline justify-between tabular-nums">
                <span className="text-muted-foreground">
                  到着 {formatTimeOrNull(effectiveArrival(log))} → 荷役開始 {formatTimeOrNull(loadingStartedAt(log))}（{mins ?? "-"}分）
                </span>
                <span className="text-base font-semibold">
                  {fee === null ? "算定不能" : `${fee.toLocaleString()}円`}
                </span>
              </div>
              {mins !== null && mins <= 30 && (
                <p className="mt-1 text-xs text-muted-foreground">30分以内のため課金対象外</p>
              )}
              {log.evidence_grade === "C" && (
                <p className="mt-1 text-xs text-muted-foreground">
                  圏外のため打刻できず、後から申告。管理者が承認した時刻ではなく、ドライバーが申告した時刻で算定し、等級を明示します。
                </p>
              )}
            </li>
          ))}
        </ul>
        <div className="flex items-baseline justify-between border-t pt-3">
          <span className="text-sm text-muted-foreground">
            1日の合計（待機1回ごとに30分を控除）
          </span>
          <span className="text-2xl font-bold tabular-nums">{total.toLocaleString()}円</span>
        </div>
      </CardContent>
    </Card>
  );
}

function TimelinePanel() {
  const summary = useMemo(
    () => convertWaitLogsToTimeline(DEMO_WAIT_LOGS, DEMO_FACILITY_NAMES),
    [],
  );
  const entries = [...summary.entries].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">打刻タイムライン</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="space-y-2 border-l pl-4">
          {entries.map((e, i) => (
            <li key={i} className="text-sm">
              <span className="tabular-nums font-medium">{formatTimeOrNull(e.timestamp)}</span>{" "}
              {EVENT_LABEL[e.eventType] ?? e.eventType}
              <span className="text-muted-foreground">　{e.locationName}</span>
              {e.waitMinutes !== undefined && (
                <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">待機 {e.waitMinutes}分</span>
              )}
              {e.evidenceGrade === "C" && (
                <span className="ml-2 rounded border px-1.5 py-0.5 text-xs">等級C</span>
              )}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

const INTEGRITY_POINTS = [
  { title: "時刻はサーバーが決める", body: "到着時刻は端末の時計ではなく DB サーバー時刻で記録。端末の時計を変えても打刻時刻は変わりません。" },
  { title: "圏外では打刻できない", body: "500m 圏外はボタンが無効になり、画面を回避してもサーバー側が拒否します。" },
  { title: "確定した証拠は書き換え不可", body: "署名済みの証拠は、管理者権限でも変更・削除できません。" },
  { title: "例外は等級で区別", body: "圏外の申告は管理者の承認を経た「等級C」として、通常の記録と区別して提示します。" },
];

export default function Demo() {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b bg-primary px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-primary-foreground">守護神 デモ</h1>
            <p className="text-xs text-primary-foreground/70">荷待ちの記録から待機料の算定まで</p>
          </div>
          <Button asChild variant="secondary" size="sm">
            <Link to="/auth">ログイン</Link>
          </Button>
        </div>
      </header>

      <div className="border-b bg-muted px-4 py-2 text-center text-xs text-muted-foreground">
        表示しているのは架空のデータです。実在の施設・人物・取引とは関係ありません。
      </div>

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-4 pb-16">
        <GpsPanel />
        <TimelinePanel />
        <KanbanPanel />
        <FeePanel />
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">記録が改ざんされにくい理由</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-3 sm:grid-cols-2">
              {INTEGRITY_POINTS.map((p) => (
                <li key={p.title} className="rounded-lg border p-3 text-sm">
                  <div className="font-medium">{p.title}</div>
                  <p className="mt-1 text-muted-foreground">{p.body}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
