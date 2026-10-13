/**
 * サーバー（SQL）と画面（TypeScript）の待機時間・待機料の計算が一致することの確認。
 *
 * 提出される値は submit_daily_report が wait_logs から SQL で計算する。画面の見積もりは
 * convertWaitLogsToTimeline + sumWaitCost で計算する。2つの実装が食い違うと、
 * 「画面で見た金額」と「提出された金額」が違うことになる。
 *
 * 方法: 入力（待機ログの組）と期待値（手計算）を、SQL のテスト
 * supabase/tests/server_side_report_totals.sql の v_cases という1つの表に置く。
 *   - SQL 側は、その表からテストデータを作り、calc_daily_wait_totals の結果を期待値と比べる。
 *   - このテストは同じ表を SQL ファイルから読み、TypeScript の実装の結果を同じ期待値と比べる。
 * 同じ入力・同じ期待値を両方が満たすので、2つの実装は同じ答えを出すことになる。
 * ※ SQL 側は本番 DB 上で人が実行する（このテストは SQL を実行しない）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { convertWaitLogsToTimeline, isBillableWaitLog, loadingStartedAt, type WaitLogRow } from "./waitLogToTimeline";
import { getRate, sumWaitCost } from "./waitCostCalc";
import { isOnJstDay } from "./waitLogDay";

interface CaseLog {
  status: string;
  arrival_time: string;
  called_time: string | null;
  work_start_time: string | null;
  work_end_time: string | null;
  evidence_grade?: string;
  claimed_at?: string;
  claimed_loading_at?: string;
  claimed_end_at?: string;
}
interface CaseCheck {
  date: string;
  visit_count: number;
  unmeasured_visits: number;
  total_wait_minutes: number;
  estimated_wait_cost: number;
}
interface ParityCase {
  name: string;
  vehicle_class: string | null;
  yen_per_minute: number;
  logs: CaseLog[];
  checks: CaseCheck[];
}

// vitest はプロジェクトのルート（shugoshin-logbook/）で実行される
const SQL_TEST = resolve(process.cwd(), "supabase/tests/server_side_report_totals.sql");
const MIGRATION = resolve(process.cwd(), "supabase/migrations/20261013200000_server_side_report_totals.sql");

function loadCases(): ParityCase[] {
  const sql = readFileSync(SQL_TEST, "utf8");
  const m = sql.match(/\$json\$([\s\S]*?)\$json\$/);
  if (!m) throw new Error("v_cases ($json$ ... $json$) が SQL テストに見つかりません");
  return JSON.parse(m[1]) as ParityCase[];
}

function toRows(logs: CaseLog[]): WaitLogRow[] {
  return logs.map((l, i) => ({
    id: `log-${i}`,
    facility_id: "facility-1",
    ticket_number: i + 1,
    status: l.status,
    arrival_time: l.arrival_time,
    called_time: l.called_time,
    work_start_time: l.work_start_time,
    work_end_time: l.work_end_time,
    evidence_grade: l.evidence_grade ?? "A",
    claimed_at: l.claimed_at ?? null,
    claimed_loading_at: l.claimed_loading_at ?? null,
    claimed_end_at: l.claimed_end_at ?? null,
  }));
}

const cases = loadCases();

describe("SQL と TypeScript の待機計算の一致（supabase/tests/server_side_report_totals.sql の v_cases）", () => {
  it("ケースが読み込めて、必要な場面を含む", () => {
    const names = cases.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "normal-72min",
        "within-30min-is-free",
        "grade-C-approval-day-claimed-minutes",
        "cancelled-is-excluded",
        "unmeasured-and-called-fallback",
        "midnight-boundary-jst",
        "rate-for-vehicle-class-2t",
        "rate-for-vehicle-class-4t",
        "rate-for-vehicle-class-10t",
        "rate-for-vehicle-class-NULL",
      ]),
    );
  });

  for (const c of cases) {
    for (const chk of c.checks) {
      it(`${c.name} (${chk.date}): ${chk.total_wait_minutes}分 / ${chk.estimated_wait_cost}円`, () => {
        // 画面側の車格は profiles.vehicle_class ?? "4t"（useDailyTimeline）
        const vehicleClass = c.vehicle_class ?? "4t";
        // サーバーと同じ基準で「その日」の行を選ぶ（取消済みを除くのは convert 側と同じ）
        const dayLogs = toRows(c.logs).filter((l) => isOnJstDay(l, chk.date));
        const billable = dayLogs.filter(isBillableWaitLog);

        const { totalWaitMinutes, waitMinutesPerEvent } = convertWaitLogsToTimeline(dayLogs, {});
        const cost = sumWaitCost(waitMinutesPerEvent, vehicleClass);
        const unmeasured = billable.filter((l) => loadingStartedAt(l) === null).length;

        expect(getRate(vehicleClass)).toBe(c.yen_per_minute);
        expect(billable.length).toBe(chk.visit_count);
        expect(unmeasured).toBe(chk.unmeasured_visits);
        expect(totalWaitMinutes).toBe(chk.total_wait_minutes);
        expect(cost).toBe(chk.estimated_wait_cost);
      });
    }
  }
});

describe("料率: TypeScript の料率表と DB の初期データが同じ", () => {
  it("マイグレーションの wait_rates の初期値が waitCostCalc.ts と一致する", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const rows = [...sql.matchAll(/\('(\w+)',\s*(\d+),\s*(true|false)\)/g)].map((m) => ({
      vehicleClass: m[1],
      yen: Number(m[2]),
      isDefault: m[3] === "true",
    }));
    expect(rows.map((r) => r.vehicleClass).sort()).toEqual(["10t", "2t", "4t"]);
    for (const r of rows) {
      expect(getRate(r.vehicleClass)).toBe(r.yen);
    }
    const defaults = rows.filter((r) => r.isDefault);
    expect(defaults).toHaveLength(1);
    // 該当なし・未設定の車格は、既定行と同じ料率になる
    expect(getRate("trailer")).toBe(defaults[0].yen);
    expect(getRate("")).toBe(defaults[0].yen);
  });
});
