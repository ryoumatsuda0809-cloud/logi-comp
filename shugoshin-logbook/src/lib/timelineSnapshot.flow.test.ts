import { describe, it, expect } from "vitest";
import { convertWaitLogsToTimeline, type WaitLogRow, type WaitLogTimelineEntry } from "./waitLogToTimeline";
import { mergeWaitLogEntriesIntoSnapshot } from "./timelineSnapshot";

/**
 * 「wait_logs の行 → 画面の timeline → 提出時の timeline_snapshot」を通しで確かめる。
 *
 * useDailyTimeline.ts は convertWaitLogsToTimeline の entries を、eventType と timestamp を
 * そのまま引き継いだ項目にして timeline に入れる（id は `wl-<eventType>-<timestamp>`）。
 * 提出時（DailyReportConfirm.tsx）は wait_logs を取り直して同じ変換をかける。
 * ここではその2回の変換を同じ関数で再現する。実際のフック・Supabase・画面は通していない。
 */

const FACILITIES = { "fac-1": "下関中央卸売市場", "fac-2": "唐戸市場" };

const row = (over: Partial<WaitLogRow> & Pick<WaitLogRow, "id" | "ticket_number">): WaitLogRow => ({
  facility_id: "fac-1",
  status: "completed",
  arrival_time: "2026-10-11T00:00:00.000Z",
  called_time: null,
  work_start_time: null,
  work_end_time: null,
  ...over,
});

/** useDailyTimeline が wait_logs の entries から timeline の項目を作るところの再現 */
const toTimeline = (entries: WaitLogTimelineEntry[]) =>
  entries.map((e) => ({
    id: `wl-${e.eventType}-${e.timestamp}`,
    source: "gps" as const,
    eventType: e.eventType,
    timestamp: e.timestamp,
    label: e.eventType,
  }));

const countOf = (snapshot: unknown[], eventType: string, timestamp: string) =>
  (snapshot as { eventType: string; timestamp: string }[]).filter(
    (s) => s.eventType === eventType && s.timestamp === timestamp,
  ).length;

/** 画面を開いた時点の wait_logs と、提出ボタンを押した時点の wait_logs から snapshot を作る */
const submit = (atLoad: WaitLogRow[], atSubmit: WaitLogRow[], extraTimeline: object[] = []) => {
  const timeline = [
    ...extraTimeline,
    ...toTimeline(convertWaitLogsToTimeline(atLoad, FACILITIES).entries),
  ] as { eventType: string; timestamp: string }[];
  const { entries } = convertWaitLogsToTimeline(atSubmit, FACILITIES);
  return { timeline, entries, snapshot: mergeWaitLogEntriesIntoSnapshot(timeline, entries) };
};

const visit1 = row({
  id: "l1",
  ticket_number: 1,
  arrival_time: "2026-10-11T00:00:00.000Z",
  work_start_time: "2026-10-11T00:50:00.000Z",
  work_end_time: "2026-10-11T02:00:00.000Z",
});
const visit2 = row({
  id: "l2",
  ticket_number: 2,
  facility_id: "fac-2",
  arrival_time: "2026-10-11T04:00:00.000Z",
  work_start_time: "2026-10-11T04:40:00.000Z",
  work_end_time: "2026-10-11T05:30:00.000Z",
});

describe("提出までの通し — timeline_snapshot の二重計上", () => {
  it("1訪問: 到着・荷役開始・出発が1回ずつ（3件）", () => {
    const { snapshot } = submit([visit1], [visit1]);
    expect(snapshot).toHaveLength(3);
    expect(countOf(snapshot, "arrival", "2026-10-11T00:00:00.000Z")).toBe(1);
    expect(countOf(snapshot, "waiting_start", "2026-10-11T00:50:00.000Z")).toBe(1);
    expect(countOf(snapshot, "departure", "2026-10-11T02:00:00.000Z")).toBe(1);
  });

  it("1訪問: source: wait_log の項目が混ざらない（全部 timeline 側にある）", () => {
    const { snapshot } = submit([visit1], [visit1]);
    expect((snapshot as { source: string }[]).some((s) => s.source === "wait_log")).toBe(false);
  });

  it("2訪問（別施設・別時刻）: 6件で、1件も落ちない", () => {
    const { snapshot } = submit([visit1, visit2], [visit1, visit2]);
    expect(snapshot).toHaveLength(6);
  });

  it("等級C: 主張時刻（claimed_*）で出し、二重にならない", () => {
    const claimed = row({
      id: "l3",
      ticket_number: 3,
      evidence_grade: "C",
      arrival_time: "2026-10-11T09:00:00.000Z", // 承認処理の時刻（使われない）
      claimed_at: "2026-10-11T06:00:00.000Z",
      work_start_time: "2026-10-11T09:00:00.000Z",
      claimed_loading_at: "2026-10-11T06:45:00.000Z",
      claimed_end_at: "2026-10-11T07:30:00.000Z",
    });
    const { snapshot } = submit([claimed], [claimed]);
    expect(snapshot).toHaveLength(3);
    expect(countOf(snapshot, "arrival", "2026-10-11T06:00:00.000Z")).toBe(1);
  });

  it("取消済みの打刻は、画面にも snapshot にも出ない", () => {
    const cancelled = row({ id: "l4", ticket_number: 4, status: "cancelled", work_start_time: "2026-10-11T01:00:00.000Z" });
    const { snapshot } = submit([visit1, cancelled], [visit1, cancelled]);
    expect(snapshot).toHaveLength(3);
  });

  it("荷役開始がまだ無い訪問: 到着だけの1件で、二重にならない", () => {
    const waiting = row({ id: "l5", ticket_number: 5, status: "waiting", arrival_time: "2026-10-11T08:00:00.000Z" });
    const { snapshot } = submit([waiting], [waiting]);
    expect(snapshot).toHaveLength(1);
  });

  it("画面を開いたあとに出発が打刻された: 新しい出発だけが wait_log として足される", () => {
    const working = row({ ...visit1, id: "l1", work_end_time: null, status: "working" });
    const { snapshot } = submit([working], [visit1]);
    expect(snapshot).toHaveLength(3);
    expect(countOf(snapshot, "arrival", "2026-10-11T00:00:00.000Z")).toBe(1);
    expect(countOf(snapshot, "waiting_start", "2026-10-11T00:50:00.000Z")).toBe(1);
    const departure = (snapshot as { eventType: string; source: string }[]).find((s) => s.eventType === "departure");
    expect(departure?.source).toBe("wait_log");
  });

  it("音声日報など wait_logs 以外の項目は、そのまま残る", () => {
    const voice = { id: "voice-1", source: "voice", eventType: "voice_report", timestamp: "2026-10-11T03:00:00.000Z" };
    const { snapshot } = submit([visit1], [visit1], [voice]);
    expect(snapshot).toHaveLength(4);
    expect(countOf(snapshot, "voice_report", "2026-10-11T03:00:00.000Z")).toBe(1);
  });

  it("【回帰の証明】修正前の単純な連結だと、同じデータが二重になる", () => {
    const { timeline, entries } = submit([visit1], [visit1]);
    const oldSnapshot = [...timeline, ...entries.map((e) => ({ ...e, source: "wait_log" }))];
    expect(oldSnapshot).toHaveLength(6);
  });
});
