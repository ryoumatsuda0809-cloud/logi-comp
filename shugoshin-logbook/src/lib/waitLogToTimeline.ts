/**
 * wait_logs → TimelineEntry 変換ユーティリティ
 * SharedReportView / DailyReportConfirm で使用
 */

export interface WaitLogRow {
  id: string;
  facility_id: string;
  ticket_number: number;
  status: string | null;
  arrival_time: string;
  called_time: string | null;
  work_start_time: string | null;
  work_end_time: string | null;
}

export interface WaitLogTimelineEntry {
  source: string;
  timestamp: string;
  eventType: string;
  locationName?: string;
  waitMinutes?: number;
  waitCost?: number;
  ticketNumber?: number;
}

export interface WaitLogSummary {
  entries: WaitLogTimelineEntry[];
  totalWaitMinutes: number;
  totalWorkMinutes: number;
  /**
   * 待機1回ごとの待機時間（分）。
   * 30分の控除は待機1回ごとに適用するため、待機料は totalWaitMinutes ではなく
   * この配列を sumWaitCost() に渡して算出すること（詳細は waitCostCalc.ts）。
   */
  waitMinutesPerEvent: number[];
}

/**
 * 取り消された打刻（cancel_ticket で status='cancelled' にした行）を除外する。
 *
 * cancel_ticket は証拠隠滅を防ぐためレコードを物理削除せず status のみを更新する。
 * そのため wait_logs を素朴に SELECT すると取消済みの行も返ってくる。
 * これを集計に含めると「取り消したはずの打刻が荷主向けの請求根拠に載る」ことになる。
 * 特に cancel_ticket は status が 'called' / 'working' の行も取消可能なため、
 * called_time が入った行＝待機時間が算出できる行がそのまま課金対象に混入する。
 *
 * 監査証跡はDB側に行が残ることで担保されており、帳票から除外して問題ない。
 */
export function isBillableWaitLog(log: WaitLogRow): boolean {
  return log.status !== "cancelled";
}

/**
 * 2つのISO文字列の差分を分で返す。どちらかがnullなら null を返す（NaN防止）
 */
export function diffMinutes(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const diff = Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
  return isNaN(diff) ? null : Math.max(0, diff);
}

/**
 * 時刻フォーマット（HH:MM）。nullの場合は "未記録" を返す
 */
export function formatTimeOrNull(iso: string | null): string {
  if (!iso) return "未記録";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "未記録";
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return "未記録";
  }
}

/**
 * wait_logs の配列を TimelineEntry[] + サマリーに変換
 */
export function convertWaitLogsToTimeline(
  logs: WaitLogRow[],
  facilityMap: Record<string, string>
): WaitLogSummary {
  const entries: WaitLogTimelineEntry[] = [];
  const waitMinutesPerEvent: number[] = [];
  let totalWaitMinutes = 0;
  let totalWorkMinutes = 0;

  for (const log of logs) {
    if (!isBillableWaitLog(log)) continue;

    const facilityName = facilityMap[log.facility_id] || "不明な施設";

    // 1. 到着
    entries.push({
      source: "gps",
      timestamp: log.arrival_time,
      eventType: "arrival",
      locationName: facilityName,
      ticketNumber: log.ticket_number,
    });

    // 2. 呼出（= 待機終了）→ 待機時間を計算
    if (log.called_time) {
      const waitMins = diffMinutes(log.arrival_time, log.called_time);
      if (waitMins !== null) {
        totalWaitMinutes += waitMins;
        waitMinutesPerEvent.push(waitMins);
      }

      entries.push({
        source: "gps",
        timestamp: log.called_time,
        eventType: "waiting_start",
        locationName: facilityName,
        waitMinutes: waitMins ?? undefined,
        ticketNumber: log.ticket_number,
      });
    }

    // 3. 作業開始
    if (log.work_start_time) {
      entries.push({
        source: "gps",
        timestamp: log.work_start_time,
        eventType: "loading_start",
        locationName: facilityName,
        ticketNumber: log.ticket_number,
      });
    }

    // 4. 作業終了（出発）→ 作業時間を計算
    //    作業時間（荷役時間）は待機時間ではないため waitMinutes には入れない。
    //    ここに work 時間を waitMinutes として渡すと、待機料課金（calcWaitCost）に
    //    作業時間が混入し、待機料を過大計算してしまう。
    if (log.work_end_time) {
      const workMins = diffMinutes(log.work_start_time, log.work_end_time);
      if (workMins !== null) totalWorkMinutes += workMins;

      entries.push({
        source: "gps",
        timestamp: log.work_end_time,
        eventType: "departure",
        locationName: facilityName,
        ticketNumber: log.ticket_number,
      });
    }
  }

  // 時系列ソート
  entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return { entries, totalWaitMinutes, totalWorkMinutes, waitMinutesPerEvent };
}

/**
 * wait_logs データから法定乗務記録テキストを自動生成
 */
export function generateFormalReportFromWaitLogs(
  logs: WaitLogRow[],
  facilityMap: Record<string, string>
): string {
  const billableLogs = logs.filter(isBillableWaitLog);
  if (billableLogs.length === 0) return "（記録なし）";

  const lines: string[] = ["【法定乗務記録】", ""];

  for (const log of billableLogs) {
    const facilityName = facilityMap[log.facility_id] || "不明な施設";
    const arrivalStr = formatTimeOrNull(log.arrival_time);
    const calledStr = formatTimeOrNull(log.called_time);
    const workStartStr = formatTimeOrNull(log.work_start_time);
    const workEndStr = formatTimeOrNull(log.work_end_time);

    const waitMins = diffMinutes(log.arrival_time, log.called_time);
    const workMins = diffMinutes(log.work_start_time, log.work_end_time);

    lines.push(`▶ ${facilityName}（整理券 #${log.ticket_number}）`);
    lines.push(`  到着時刻: ${arrivalStr}`);
    lines.push(`  荷待ち時間: ${waitMins !== null ? `${waitMins}分（${arrivalStr}〜${calledStr}）` : "未記録"}`);
    lines.push(`  作業時間: ${workMins !== null ? `${workMins}分（${workStartStr}〜${workEndStr}）` : "未記録"}`);
    lines.push("");
  }

  return lines.join("\n");
}
