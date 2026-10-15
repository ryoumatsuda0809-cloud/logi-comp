import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { DemoSubmitPanel } from "@/components/demo/DemoSubmitPanel";
import { DemoBottomNav } from "@/components/demo/DemoBottomNav";
import { NoticeMark } from "@/components/NoticeMark";
import { groupTimelineByVisit } from "@/demo/groupTimelineByVisit";
import { Building2, Check, ChevronRight, Clock, Coins, Layers, Lock, MapPin, MousePointerClick, Pause, Play, ShieldCheck, Truck } from "lucide-react";
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
  departure: "作業完了（出発）",
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
  // 到着打刻の時刻に当たる軌跡の位置（「到着打刻」を押したときに、そこまで進める）
  const arrivalIndex = useMemo(() => {
    const i = DEMO_TRACK.findIndex((p) => new Date(p.t) >= new Date(DEMO_WAIT_LOGS[0].arrival_time));
    return i < 0 ? last : i;
  }, [last]);

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
          <MapPin className="h-4 w-4" /> 到着の判定
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          GPSで、施設から{DEMO_GEOFENCE_RADIUS_M}m以内にいるかを確かめます。再生すると1日の動きを追えます。
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <svg
          viewBox={`0 0 ${VIEW_HALF_M * 2} ${VIEW_HALF_M * 2}`}
          className="mx-auto w-full max-w-md rounded-lg border bg-muted/40"
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
            <div className="text-xs text-muted-foreground">施設まで</div>
            <div className="font-semibold tabular-nums">{distance.toLocaleString()} m</div>
          </div>
          <div className="rounded-lg border p-2">
            <div className="text-xs text-muted-foreground">状態</div>
            <div className="font-semibold text-balance">{PHASE_LABEL[current.phase]}</div>
          </div>
        </div>

        {inFence && !stamped ? (
          // 施設の範囲に入った瞬間に、押すべきボタンを大きく出す。押すと到着打刻の時点まで進む（デモの中だけの動き）
          <div className="rounded-xl border-2 border-accent bg-accent/10 p-3 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <MapPin className="h-4 w-4 shrink-0 text-accent" aria-hidden />
              施設の{DEMO_GEOFENCE_RADIUS_M}m以内に入りました
            </p>
            <Button
              className="mt-2 min-h-14 w-full bg-accent text-lg font-bold text-accent-foreground hover:bg-accent/90"
              onClick={() => {
                if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(15);
                setPlaying(false);
                setIndex(arrivalIndex);
              }}
            >
              到着打刻
            </Button>
          </div>
        ) : stamped ? (
          // 記録が確定した瞬間の手応え。印が一瞬で大きくなって現れる（動きを減らす設定では出さない）
          <div
            role="status"
            className="flex items-center gap-3 rounded-xl border border-success/40 bg-success/10 p-3 motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95"
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-success text-success-foreground motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:duration-500">
              <Check className="h-6 w-6" strokeWidth={3} aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="font-bold">到着を記録しました</p>
              <p className="text-sm text-muted-foreground tabular-nums">
                整理券 {DEMO_WAIT_LOGS[0].ticket_number} 番・サーバー時刻 {formatTimeOrNull(DEMO_WAIT_LOGS[0].arrival_time)}
              </p>
            </div>
          </div>
        ) : (
          <Button className="min-h-12 w-full" disabled>
            <Lock className="mr-2 h-4 w-4" />
            500m超のため打刻できません
          </Button>
        )}
        {!inFence && !stamped && (
          <p className="flex items-center gap-2 rounded-lg border border-warning bg-warning/10 px-3 py-2 text-sm text-foreground">
            <MapPin className="h-4 w-4 shrink-0 text-warning" aria-hidden />
            施設から{DEMO_GEOFENCE_RADIUS_M}m以内に入ると押せます（あと {(distance - DEMO_GEOFENCE_RADIUS_M).toLocaleString()} m）
          </p>
        )}

        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant={!playing && index === 0 ? "default" : "outline"}
            className="min-h-11 shrink-0 gap-2"
            aria-label={playing ? "一時停止" : "1日の流れを再生"}
            onClick={() => {
              if (!playing && index >= last) setIndex(0);
              setPlaying((p) => !p);
            }}
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            {playing ? "一時停止" : "1日の流れを再生"}
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
              className="min-h-11 rounded-full border px-3 hover:bg-muted"
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

// 列ごとの色（待機=橙、呼出=青、荷役=緑）。色だけに頼らず、列の名前・件数・文字も残す
const KANBAN_COLUMNS: {
  status: KanbanStatus;
  label: string;
  action?: { label: string; next: KanbanStatus };
  column: string;
  badge: string;
  card: string;
  dot: string;
}[] = [
  {
    status: "waiting",
    label: "待機中",
    action: { label: "呼出", next: "called" },
    column: "border-warning/50 bg-warning/10",
    badge: "bg-warning text-black",
    card: "border-l-warning",
    dot: "bg-warning",
  },
  {
    status: "called",
    label: "呼出済",
    action: { label: "荷役開始", next: "working" },
    column: "border-sky-500/50 bg-sky-500/10",
    badge: "bg-sky-600 text-white",
    card: "border-l-sky-500",
    dot: "bg-sky-500",
  },
  {
    status: "working",
    label: "荷役中",
    column: "border-success/50 bg-success/10",
    badge: "bg-success text-success-foreground",
    card: "border-l-success",
    dot: "bg-success",
  },
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
        <CardTitle className="text-base">荷主カンバン</CardTitle>
        <p className="text-xs text-muted-foreground">
          {DEMO_FACILITIES[0].name}・{formatTimeOrNull(KANBAN_NOW)} 時点
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          {KANBAN_COLUMNS.map((col) => {
            const items = tickets.filter((t) => t.status === col.status);
            return (
              <div key={col.status} className={`rounded-lg border p-2 ${col.column}`}>
                <div className="mb-2 flex items-center justify-between text-sm font-bold">
                  <span className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${col.dot}`} aria-hidden />
                    {col.label}
                  </span>
                  <span className={`min-w-7 rounded-full px-2 py-0.5 text-center text-xs font-bold tabular-nums ${col.badge}`}>
                    {items.length}
                  </span>
                </div>
                <div className="space-y-2">
                  {items.length === 0 && (
                    <p className="py-3 text-center text-xs text-muted-foreground">なし</p>
                  )}
                  {items.map((t) => (
                    <div key={t.no} className={`rounded-md border border-l-4 bg-background p-3 text-sm shadow-sm ${col.card}`}>
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
                          className="mt-2 min-h-11 w-full"
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
          荷主が押せるのは「呼出」と「荷役開始」まで。完了はドライバーの打刻だけが確定します。
        </p>
        <Button variant="outline" size="sm" className="min-h-11" onClick={() => setTickets(KANBAN_INITIAL)}>
          最初の状態に戻す
        </Button>
      </CardContent>
    </Card>
  );
}

/** 訪問ごとの待機分と待機料（待機料タブと、要約の内訳シートで同じものを使う） */
function demoFeeRows() {
  return DEMO_WAIT_LOGS.filter(isBillableWaitLog).map((log) => {
    const mins = diffMinutes(effectiveArrival(log), loadingStartedAt(log));
    return {
      log,
      mins,
      fee: mins === null ? null : calcWaitCost(mins, DEMO_VEHICLE_CLASS),
    };
  });
}

function FeePanel() {
  const rate = getRate(DEMO_VEHICLE_CLASS);
  const summary = useMemo(
    () => convertWaitLogsToTimeline(DEMO_WAIT_LOGS, DEMO_FACILITY_NAMES),
    [],
  );
  const total = sumWaitCost(summary.waitMinutesPerEvent, DEMO_VEHICLE_CLASS);

  const rows = demoFeeRows();

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
                <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap pl-2 text-base font-semibold">
                  {fee === null && <NoticeMark />}
                  {fee === null ? "算定不能" : `${fee.toLocaleString()}円`}
                </span>
              </div>
              {mins !== null && mins <= 30 && (
                <p className="mt-1 text-xs text-muted-foreground">30分以内のため課金対象外</p>
              )}
              {log.evidence_grade === "C" && (
                <p className="mt-1 flex items-start gap-1 text-xs text-muted-foreground">
                  <NoticeMark className="mt-0.5" />
                  電波圏外のため後から申告。申告された時刻で算定し、等級Cと明示します。
                </p>
              )}
            </li>
          ))}
        </ul>
        <div className="flex items-baseline justify-between border-t pt-3">
          <span className="text-sm text-muted-foreground">
            1日の合計（待機1回ごとに30分を控除）
          </span>
          <span className="shrink-0 whitespace-nowrap pl-2 text-2xl font-bold tabular-nums">{total.toLocaleString()}円</span>
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
  const visits = useMemo(() => groupTimelineByVisit(summary.entries), [summary]);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">打刻タイムライン</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          {visits.map((v) => (
            <li key={v.key} className="rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{v.locationName}</span>
                <span className="flex flex-wrap items-center gap-2">
                  {v.evidenceGrade === "C" && (
                    <span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs">
                      <NoticeMark />
                      等級C
                    </span>
                  )}
                  {v.waitMinutes === null ? (
                    <span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs font-semibold">
                      <NoticeMark />
                      待機 算定不能
                    </span>
                  ) : (
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-semibold ${
                        v.waitMinutes > 30 ? "border border-warning bg-warning/15" : "bg-muted"
                      }`}
                    >
                      待機 {v.waitMinutes}分{v.waitMinutes > 30 && "・30分超"}
                    </span>
                  )}
                </span>
              </div>
              <ol className="mt-2 space-y-1 border-l pl-3">
                {v.entries.map((e, i) => (
                  <li key={i}>
                    <span className="tabular-nums font-medium">{formatTimeOrNull(e.timestamp)}</span>{" "}
                    {EVENT_LABEL[e.eventType] ?? e.eventType}
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

// lines はタイルで語の途中で折れないように、折り返してよい位置で分けたもの（つなげると title と同じ）
const INTEGRITY_POINTS = [
  { title: "時刻はサーバーが決める", lines: ["時刻は", "サーバーが決める"], body: "到着時刻は端末の時計ではなく DB サーバー時刻で記録。端末の時計を変えても打刻時刻は変わりません。" },
  { title: "500m超では打刻できない", lines: ["500m超では", "打刻できない"], body: "施設から500m超ではボタンが無効になり、画面を回避してもサーバー側が拒否します。" },
  { title: "確定した証拠は書き換え不可", lines: ["確定した証拠は", "書き換え不可"], body: "署名済みの証拠は、管理者権限でも変更・削除できません。" },
  { title: "例外は等級で区別", lines: ["例外は", "等級で区別"], body: "電波圏外の申告は管理者の承認を経た「等級C」として、通常の記録と区別して提示します。" },
];

/**
 * 最初に見える要約。初めて開いた人が、技術の説明より先に「何のアプリで、何が残るか」を読めるようにする。
 * 数字は待機料タブと同じ計算（convertWaitLogsToTimeline / sumWaitCost）から出す。
 */
function DemoHero() {
  const summary = useMemo(
    () => convertWaitLogsToTimeline(DEMO_WAIT_LOGS, DEMO_FACILITY_NAMES),
    [],
  );
  const minutes = summary.waitMinutesPerEvent.reduce((a, b) => a + b, 0);
  const fee = sumWaitCost(summary.waitMinutesPerEvent, DEMO_VEHICLE_CLASS);
  const [openPoint, setOpenPoint] = useState<number | null>(null);
  const [feeOpen, setFeeOpen] = useState(false);
  const feeRows = useMemo(() => demoFeeRows(), []);
  const overThirty = feeRows.filter((r) => r.mins !== null && r.mins > 30).length;
  const point = openPoint === null ? null : INTEGRITY_POINTS[openPoint];

  return (
    <section className="mb-5" aria-labelledby="demo-hero-title">
      <h2 id="demo-hero-title" className="text-[1.75rem] font-extrabold leading-tight tracking-tight lg:text-4xl">
        {/* 読点で折り返す（語の途中で切れないように、句ごとにまとめる） */}
        <span className="inline-block">荷待ち時間を、</span>
        <span className="inline-block">書き換えにくい記録に。</span>
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        施設で待たされた時間を記録し、荷主に出せる報告書と待機料の根拠にします。
      </p>

      {/* 大小のタイルで並べる（Bento）。いちばん伝えたい金額を大きく、根拠を小さく並べる。どれも押すと下から詳しく出る */}
      <p className="mt-4 text-sm font-semibold lg:mt-6">架空のドライバーの1日（3施設を訪問）</p>
      <div className="mt-2 grid grid-cols-2 gap-2.5 lg:grid-cols-4 lg:gap-4">
        <button
          type="button"
          onClick={() => setFeeOpen(true)}
          className="col-span-2 rounded-2xl bg-primary p-4 text-left text-primary-foreground shadow-sm"
          aria-label={`この1日の待機料の目安 ${fee}円。内訳を見る`}
        >
          <div className="text-sm text-primary-foreground/70">この1日の待機料（目安）</div>
          <div className="mt-1 text-5xl font-extrabold tracking-tight tabular-nums">¥{fee.toLocaleString()}</div>
          <div className="mt-1 text-sm text-primary-foreground/70">
            30分を超えた待機 × {getRate(DEMO_VEHICLE_CLASS)}円/分
          </div>
          <TapHint tone="onDark">施設ごとの内訳を見る</TapHint>
        </button>

        <button
          type="button"
          onClick={() => setFeeOpen(true)}
          className="rounded-2xl border bg-card p-4 text-left shadow-sm"
          aria-label={`この1日の待機 ${minutes}分。内訳を見る`}
        >
          <div className="text-sm text-muted-foreground">待たされた時間の合計</div>
          <div className="mt-1 text-3xl font-extrabold tracking-tight tabular-nums">
            {minutes.toLocaleString()}
            <span className="ml-0.5 text-base font-bold">分</span>
          </div>
          <TapHint>内訳</TapHint>
        </button>
        <button
          type="button"
          onClick={() => setFeeOpen(true)}
          className="rounded-2xl border bg-card p-4 text-left shadow-sm"
          aria-label={`訪問 ${feeRows.length}件、うち30分超 ${overThirty}件。内訳を見る`}
        >
          <div className="text-sm text-muted-foreground">訪問した施設</div>
          <div className="mt-1 text-3xl font-extrabold tracking-tight tabular-nums">
            {feeRows.length}
            <span className="ml-0.5 text-base font-bold">件</span>
          </div>
          <div className="text-xs text-muted-foreground">うち30分超 {overThirty}件</div>
          <TapHint>内訳</TapHint>
        </button>

        {/* 下の4枚が何の話かを先に言う */}
        <p className="col-span-2 mt-2 text-sm font-semibold lg:col-span-4 lg:mt-1">記録が書き換えにくい理由</p>

        {INTEGRITY_POINTS.map((p, i) => {
          const Icon = POINT_ICONS[i] ?? ShieldCheck;
          return (
            <button
              key={p.title}
              type="button"
              onClick={() => setOpenPoint(i)}
              className="flex min-h-[96px] flex-col justify-between gap-2 rounded-2xl border bg-card p-3 text-left shadow-sm lg:min-h-[120px] lg:p-4"
              aria-label={`${p.title}。詳しく見る`}
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-success/15 text-success">
                <Icon className="h-4 w-4" aria-hidden />
              </span>
              <span className="text-sm font-semibold leading-snug">
                {p.lines.map((l) => (
                  <span key={l} className="inline-block">
                    {l}
                  </span>
                ))}
              </span>
              <TapHint>詳しく</TapHint>
            </button>
          );
        })}
      </div>

      <Drawer open={point !== null} onOpenChange={(open) => !open && setOpenPoint(null)}>
        <DrawerContent className={SHEET_PC}>
          {point && (
            <>
              <DrawerHeader className="text-left">
                <DrawerTitle className="flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5 shrink-0 text-success" aria-hidden />
                  {point.title}
                </DrawerTitle>
                <DrawerDescription className="text-base text-foreground">{point.body}</DrawerDescription>
              </DrawerHeader>
              <DrawerFooter style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}>
                <DrawerClose asChild>
                  <Button variant="outline" className="min-h-12">
                    閉じる
                  </Button>
                </DrawerClose>
              </DrawerFooter>
            </>
          )}
        </DrawerContent>
      </Drawer>

      <Drawer open={feeOpen} onOpenChange={setFeeOpen}>
        <DrawerContent className={SHEET_PC}>
          <DrawerHeader className="text-left">
            <DrawerTitle>待機料の内訳</DrawerTitle>
            <DrawerDescription>
              {vehicleClassLabel(DEMO_VEHICLE_CLASS)}・{getRate(DEMO_VEHICLE_CLASS)}円/分。待機1回ごとに30分を控除し、超えた分だけ数えます。
            </DrawerDescription>
          </DrawerHeader>
          <ul className="space-y-2 px-4">
            {feeRows.map(({ log, mins, fee: rowFee }) => (
              <li key={log.id} className="flex items-baseline justify-between gap-2 rounded-lg border p-3 text-sm">
                <span className="min-w-0">
                  <span className="block font-medium">{DEMO_FACILITY_NAMES[log.facility_id]}</span>
                  <span className="text-muted-foreground tabular-nums">待機 {mins ?? "-"}分</span>
                </span>
                <span className="shrink-0 text-base font-semibold tabular-nums">
                  {rowFee === null ? "算定不能" : rowFee === 0 ? "対象外" : `¥${rowFee.toLocaleString()}`}
                </span>
              </li>
            ))}
          </ul>
          <div className="mx-4 mt-3 flex items-baseline justify-between border-t pt-3">
            <span className="text-sm text-muted-foreground">合計 {minutes.toLocaleString()}分</span>
            <span className="text-2xl font-bold tabular-nums">¥{fee.toLocaleString()}</span>
          </div>
          <DrawerFooter style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}>
            <DrawerClose asChild>
              <Button variant="outline" className="min-h-12">
                閉じる
              </Button>
            </DrawerClose>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </section>
  );
}

/**
 * タイルが押せることを文字で示す（押さないと何かわからない、を防ぐ）。
 * 色だけに頼らず「›」と言葉を添える。読み上げはボタンの aria-label に任せる。
 */
function TapHint({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "onDark" }) {
  return (
    <span
      aria-hidden
      className={`mt-2 inline-flex items-center gap-0.5 text-xs font-semibold ${tone === "onDark" ? "text-accent" : "text-primary"}`}
    >
      {children}
      <ChevronRight className="h-3.5 w-3.5" />
    </span>
  );
}

/**
 * PC では下から出るシートを画面いっぱいに広げず、本文（左のサイドバーを除いた幅）の中央に浮いたカードとして出す。
 * スマホは今までどおり画面下いっぱいのシート。
 */
// after:hidden は vaul がシートの下に伸ばす背景（引っぱったときの隙間埋め）を消す。浮かせると下に白い帯として見えるため
const SHEET_PC = "lg:left-60 lg:mx-auto lg:bottom-6 lg:max-w-lg lg:rounded-2xl lg:after:hidden";

/** 「改ざんされにくい理由」のタイルの印（INTEGRITY_POINTS と同じ順） */
const POINT_ICONS = [Clock, MapPin, Lock, Layers];

/** 「3つの立場」のタブ */
const DEMO_TABS = [
  { value: "punch", label: "ドライバー", Icon: Truck },
  { value: "kanban", label: "荷主", Icon: Building2 },
  { value: "fee", label: "待機料", Icon: Coins },
] as const;

/** 切り替えても、再生位置・押したボタン・提出の状態を失わないよう、使っていないタブも残して隠す */
const KEEP_TAB = "data-[state=inactive]:hidden";

/**
 * /demo。実際のアプリと同じ共通のナビ（下のバー）と、「打刻」「荷主」「待機料」のタブで、
 * 1日の流れを操作しながら見られるようにしてある。
 */
export default function Demo() {
  return (
    <div className="demo-app min-h-screen bg-background">
      <header className="sticky top-0 z-30 bg-primary px-4 py-3 shadow-md lg:hidden" style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}>
        <div className="mx-auto flex max-w-4xl items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent">
            <img src="/icon-192.png" alt="" className="h-8 w-8 rounded-md" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold text-primary-foreground">守護神</h1>
            <p className="truncate text-xs text-primary-foreground/70">デモ</p>
          </div>
        </div>
      </header>

      <div className="border-b bg-muted px-4 py-2 text-center text-xs text-muted-foreground">
        架空のデータです。実在の施設・人物・取引とは無関係です。
      </div>

      <main className="mx-auto max-w-4xl p-4 pb-28 lg:max-w-6xl lg:px-8 lg:pb-12 lg:pt-8">
        <DemoHero />
        <Tabs defaultValue="punch">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
            同じ1日を、3つの立場で見る
            <span className="inline-flex items-center gap-1 rounded-full bg-accent/25 px-2 py-0.5 text-xs font-bold text-foreground">
              <MousePointerClick className="h-3.5 w-3.5" aria-hidden />
              押して切り替え
            </span>
          </p>
          {/* 3つあることが分かるよう、枠・アイコン・濃い文字にする。今開いている画面だけ色を塗る */}
          <TabsList className="mb-4 h-auto w-full gap-2 bg-transparent p-0 text-foreground lg:max-w-xl">
            {DEMO_TABS.map(({ value, label, Icon }) => (
              <TabsTrigger
                key={value}
                value={value}
                className="min-h-12 flex-1 gap-1.5 border border-border bg-background text-sm font-semibold shadow-sm data-[state=inactive]:hover:bg-muted data-[state=active]:border-primary data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm lg:text-base"
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          <p className="-mt-2 mb-3 text-xs text-muted-foreground">タップで切り替え。ドライバー・荷主・待機料で、同じデータの見え方が変わります。</p>

          <TabsContent value="punch" forceMount className={`space-y-4 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4 lg:space-y-0 ${KEEP_TAB}`}>
            <GpsPanel />
            <TimelinePanel />
          </TabsContent>

          <TabsContent value="kanban" forceMount className={`space-y-4 ${KEEP_TAB}`}>
            <KanbanPanel />
          </TabsContent>

          <TabsContent value="fee" forceMount className={`space-y-4 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4 lg:space-y-0 ${KEEP_TAB}`}>
            <FeePanel />
            <DemoSubmitPanel />
          </TabsContent>
        </Tabs>
      </main>

      <DemoBottomNav />
    </div>
  );
}
