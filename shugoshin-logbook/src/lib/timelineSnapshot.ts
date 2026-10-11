import type { Json } from "@/integrations/supabase/types";
import type { WaitLogTimelineEntry } from "./waitLogToTimeline";

/** 重複判定に使う最小の形。UnifiedTimelineItem もこれを満たす */
interface TimelineKey {
  eventType: string;
  timestamp: string;
}

/** 表記ゆれ（Z と +00:00 など）を吸収するため、時刻は epoch で比べる。読めない文字列はそのまま比べる */
function keyOf(item: TimelineKey): string {
  const t = new Date(item.timestamp).getTime();
  return `${item.eventType}|${Number.isNaN(t) ? item.timestamp : t}`;
}

/**
 * 提出用の timeline_snapshot を組み立てる。
 *
 * useDailyTimeline の timeline には、すでに wait_logs 由来の項目（id が `wl-...`）が入っている。
 * 提出時に wait_logs を取り直して足すと、同じ到着・荷役開始・出発が二重になって
 * 荷主向けの帳票に同じ待機が2回載る。eventType と timestamp が同じ項目は足さない。
 */
export function mergeWaitLogEntriesIntoSnapshot(
  timeline: readonly TimelineKey[],
  waitLogEntries: readonly WaitLogTimelineEntry[],
): Json[] {
  const snapshot: Json[] = JSON.parse(JSON.stringify(timeline));
  const existing = new Set(timeline.map(keyOf));
  const additions = waitLogEntries
    .filter((e) => !existing.has(keyOf(e)))
    .map((e) => ({ ...e, source: "wait_log" }));
  return [...snapshot, ...JSON.parse(JSON.stringify(additions))];
}
