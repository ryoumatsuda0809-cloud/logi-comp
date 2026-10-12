import type { WaitLogTimelineEntry } from "@/lib/waitLogToTimeline";

/** 1回の訪問（到着〜荷役開始〜作業完了）に属する打刻をまとめたもの。/demo の打刻タイムラインの表示用 */
export interface TimelineVisit {
  key: string;
  locationName: string;
  /** 時刻の早い順 */
  entries: WaitLogTimelineEntry[];
  /** この訪問の待機（分）。荷役開始が記録されておらず算定できないときは null */
  waitMinutes: number | null;
  /** 'C' の打刻を含むとき 'C'（圏外承認）。それ以外は undefined */
  evidenceGrade?: string;
}

const timeOf = (e: WaitLogTimelineEntry) => new Date(e.timestamp).getTime();

/**
 * 打刻を訪問ごとにまとめる。表示の並べ替えだけで、時刻・待機の分数・等級は変えない。
 * 訪問の区別は「施設名＋整理券番号」。同じ施設に1日2回行っても、整理券が違えば別の訪問になる。
 * 整理券番号の無い打刻は施設名だけで区別する。訪問は最初の打刻の早い順に並べる。
 */
export function groupTimelineByVisit(entries: WaitLogTimelineEntry[]): TimelineVisit[] {
  const byKey = new Map<string, WaitLogTimelineEntry[]>();
  for (const e of entries) {
    const key = `${e.locationName ?? ""}#${e.ticketNumber ?? ""}`;
    const list = byKey.get(key);
    if (list) list.push(e);
    else byKey.set(key, [e]);
  }
  const visits = [...byKey.entries()].map(([key, list]): TimelineVisit => {
    const sorted = [...list].sort((a, b) => timeOf(a) - timeOf(b));
    const waitEntry = sorted.find((e) => e.eventType === "waiting_start");
    return {
      key,
      locationName: sorted[0].locationName ?? "不明な施設",
      entries: sorted,
      waitMinutes: waitEntry?.waitMinutes ?? null,
      evidenceGrade: sorted.some((e) => e.evidenceGrade === "C") ? "C" : undefined,
    };
  });
  return visits.sort((a, b) => timeOf(a.entries[0]) - timeOf(b.entries[0]));
}
