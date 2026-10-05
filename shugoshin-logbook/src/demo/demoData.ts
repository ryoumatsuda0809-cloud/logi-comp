/**
 * /demo 用の架空データ。
 *
 * 実在の施設・人物・取引とは無関係。本番DBには一切アクセスしない。
 * 金額・待機時間は表示用に固定せず、実際の算定ロジック
 * （convertWaitLogsToTimeline / sumWaitCost）に通して求める。
 */
import type { WaitLogRow } from "@/lib/waitLogToTimeline";

export const DEMO_VEHICLE_CLASS = "4t";
export const DEMO_GEOFENCE_RADIUS_M = 500;

export interface DemoFacility {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

export const DEMO_FACILITIES: DemoFacility[] = [
  { id: "demo-f1", name: "架空水産 第2荷捌き場", lat: 33.9525, lng: 130.9231 },
  { id: "demo-f2", name: "架空冷蔵 本社倉庫", lat: 33.9411, lng: 130.9408 },
  { id: "demo-f3", name: "架空物産 配送センター", lat: 33.9302, lng: 130.9152 },
];

export const DEMO_FACILITY_NAMES: Record<string, string> = Object.fromEntries(
  DEMO_FACILITIES.map((f) => [f.id, f.name]),
);

const JST = "+09:00";
const at = (hhmm: string) => `2026-10-03T${hhmm}:00${JST}`;

/** 1日分の待機ログ（DBの wait_logs と同じ形） */
export const DEMO_WAIT_LOGS: WaitLogRow[] = [
  {
    // 長い待機: 72分 → 課金対象
    id: "demo-log-1",
    facility_id: "demo-f1",
    ticket_number: 14,
    status: "completed",
    arrival_time: at("08:05"),
    called_time: at("09:10"),
    work_start_time: at("09:17"),
    work_end_time: at("09:52"),
    evidence_grade: "A",
  },
  {
    // 短い待機: 25分 → 30分控除により0円
    id: "demo-log-2",
    facility_id: "demo-f2",
    ticket_number: 6,
    status: "completed",
    arrival_time: at("11:02"),
    called_time: at("11:24"),
    work_start_time: at("11:27"),
    work_end_time: at("11:48"),
    evidence_grade: "A",
  },
  {
    // 圏外で打刻できず、後から申告し管理者が承認したケース（等級C）。
    // arrival_time 等は「承認処理を行ったサーバー時刻」。算定は claimed_* を使う。
    id: "demo-log-3",
    facility_id: "demo-f3",
    ticket_number: 3,
    status: "completed",
    arrival_time: at("17:40"),
    called_time: null,
    work_start_time: at("17:40"),
    work_end_time: at("17:40"),
    evidence_grade: "C",
    claimed_at: at("14:20"),
    claimed_loading_at: at("15:15"),
    claimed_end_at: at("15:40"),
    self_approved: false,
  },
];

// ---------------------------------------------------------------------------
// GPS 軌跡（1件目の訪問のみ）
// ---------------------------------------------------------------------------

export interface DemoGpsPoint {
  /** ISO 文字列（JST） */
  t: string;
  lat: number;
  lng: number;
  phase: "approach" | "waiting" | "loading" | "departure";
}

const M_PER_DEG_LAT = 110540;
const mPerDegLng = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);

const f1 = DEMO_FACILITIES[0];

/** 施設を原点とした東西・南北のメートル差を緯度経度に直す */
function offsetToLatLng(dxM: number, dyM: number) {
  return {
    lat: f1.lat + dyM / M_PER_DEG_LAT,
    lng: f1.lng + dxM / mPerDegLng(f1.lat),
  };
}

/** 乱数を使わない決定的な揺らぎ（GPSの測位誤差の見た目用）。テストが安定する */
function jitter(i: number, amplitudeM: number) {
  return {
    x: Math.sin(i * 12.9898) * amplitudeM,
    y: Math.cos(i * 78.233) * amplitudeM,
  };
}

function minutesToHhmm(totalMinutes: number) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function buildTrack(): DemoGpsPoint[] {
  const points: DemoGpsPoint[] = [];
  let i = 0;
  const push = (
    minute: number,
    dxM: number,
    dyM: number,
    phase: DemoGpsPoint["phase"],
    jitterM = 0,
  ) => {
    const j = jitter(i++, jitterM);
    const { lat, lng } = offsetToLatLng(dxM + j.x, dyM + j.y);
    points.push({ t: at(minutesToHhmm(minute)), lat, lng, phase });
  };

  // 07:50〜08:05 市場前の渋滞を進む。約1.3km手前から500m圏へ入る
  const start = { x: -1000, y: -850 };
  const gate = { x: -120, y: -90 };
  const approachMinutes = 15;
  for (let k = 0; k <= approachMinutes; k++) {
    const r = k / approachMinutes;
    push(
      7 * 60 + 50 + k,
      start.x + (gate.x - start.x) * r,
      start.y + (gate.y - start.y) * r,
      "approach",
      6,
    );
  }
  // 08:07〜09:17 待機列で停車（測位の揺らぎのみ）
  for (let m = 8 * 60 + 7; m <= 9 * 60 + 17; m += 2) {
    push(m, gate.x, gate.y, "waiting", 7);
  }
  // 09:18〜09:52 荷捌き場で荷役
  for (let m = 9 * 60 + 18; m <= 9 * 60 + 52; m += 3) {
    push(m, 30, 20, "loading", 5);
  }
  // 09:55〜10:10 退出
  const out = { x: 900, y: 650 };
  const departMinutes = 15;
  for (let k = 1; k <= departMinutes; k += 1) {
    const r = k / departMinutes;
    push(9 * 60 + 55 + k, 30 + (out.x - 30) * r, 20 + (out.y - 20) * r, "departure", 6);
  }
  return points;
}

export const DEMO_TRACK: DemoGpsPoint[] = buildTrack();

/** 軌跡上の主要イベント（再生バーの目印） */
export const DEMO_TRACK_EVENTS = [
  { label: "到着打刻", t: DEMO_WAIT_LOGS[0].arrival_time },
  { label: "荷役開始", t: DEMO_WAIT_LOGS[0].work_start_time as string },
  { label: "作業完了", t: DEMO_WAIT_LOGS[0].work_end_time as string },
];
