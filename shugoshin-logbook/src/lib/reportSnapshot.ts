import type { Json } from "@/integrations/supabase/types";
import type { WaitLogTimelineEntry } from "@/lib/waitLogToTimeline";

const entryKey = (eventType: unknown, timestamp: unknown) => `${String(eventType)}|${String(timestamp)}`;

/**
 * 提出直前に取り直した wait_logs の行を、提出する timeline_snapshot の後ろに足す。
 * すでに snapshot にある打刻（eventType と timestamp が同じもの）は足さない。
 * 画面の timeline も同じ wait_logs から作られているため、除かないと同じ待機が2回入る。
 * ページを開いたあとに増えた打刻だけが足される。
 */
export function appendNewWaitLogEntries(snapshot: Json[], entries: WaitLogTimelineEntry[]): Json[] {
  const seen = new Set<string>();
  for (const item of snapshot) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      seen.add(entryKey(item.eventType, item.timestamp));
    }
  }
  const added = entries
    .filter((e) => !seen.has(entryKey(e.eventType, e.timestamp)))
    .map((e) => ({ ...e, source: "wait_log" }));
  return [...snapshot, ...added];
}
