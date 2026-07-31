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
  /** 'A'=サーバー検証済 / 'C'=圏外申告を管理者が承認したもの。未設定は 'A' 扱い */
  evidence_grade?: string | null;
  /** 等級Cのみ。ドライバーが主張する到着時刻。arrival_time は承認処理を行った時刻 */
  claimed_at?: string | null;
  /** 等級Cのみ。ドライバーが主張する作業完了時刻 */
  claimed_end_at?: string | null;
  /** 承認者と申請者が同一だった場合 true */
  self_approved?: boolean | null;
}

/**
 * 待機時間の算定に使う到着時刻を返す。
 *
 * 等級Cの行では `arrival_time` は「管理者が承認処理を行ったサーバー時刻」であって
 * 実際の到着時刻ではない。証拠カラムをサーバー時刻のまま据え置く代わりに
 * ドライバーの主張時刻を `claimed_at` に持つ設計のため、時間の算定はこちらを見る。
 * （DB側の waiting_minutes GENERATED 列も同じ COALESCE を行っている）
 */
export function effectiveArrival(log: WaitLogRow): string {
  return log.claimed_at ?? log.arrival_time;
}

/** 待機時間の算定に使う作業完了時刻を返す。理由は effectiveArrival と同じ */
export function effectiveWorkEnd(log: WaitLogRow): string | null {
  return log.claimed_end_at ?? log.work_end_time;
}

/** 等級C（管理者が承認した圏外申告）かどうか */
export function isApprovedClaim(log: WaitLogRow): boolean {
  return log.evidence_grade === "C";
}

export interface WaitLogTimelineEntry {
  source: string;
  timestamp: string;
  eventType: string;
  locationName?: string;
  waitMinutes?: number;
  waitCost?: number;
  ticketNumber?: number;
  /** 'A'=サーバー検証済 / 'C'=管理者が承認した圏外申告。荷主への提示で区別すること */
  evidenceGrade?: string;
  /** 等級Cで、承認者と申請者が同一だった場合 true */
  selfApproved?: boolean;
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
    // 等級Cでは arrival_time / work_end_time が承認処理を行った時刻になるため、
    // 表示・算定ともに主張時刻を優先する（詳細は effectiveArrival のコメント）
    const arrivalAt = effectiveArrival(log);
    const workEndAt = effectiveWorkEnd(log);
    const grade = log.evidence_grade ?? "A";
    const gradeFields =
      grade === "C"
        ? { evidenceGrade: "C", selfApproved: log.self_approved ?? false }
        : {};

    // 1. 到着
    entries.push({
      source: "gps",
      timestamp: arrivalAt,
      eventType: "arrival",
      locationName: facilityName,
      ticketNumber: log.ticket_number,
      ...gradeFields,
    });

    // 2. 呼出（= 待機終了）→ 待機時間を計算
    if (log.called_time) {
      const waitMins = diffMinutes(arrivalAt, log.called_time);
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
        ...gradeFields,
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
        ...gradeFields,
      });
    }

    // 4. 作業終了（出発）→ 作業時間を計算
    //    作業時間（荷役時間）は待機時間ではないため waitMinutes には入れない。
    //    ここに work 時間を waitMinutes として渡すと、待機料課金（calcWaitCost）に
    //    作業時間が混入し、待機料を過大計算してしまう。
    if (workEndAt) {
      const workMins = diffMinutes(log.work_start_time, workEndAt);
      if (workMins !== null) totalWorkMinutes += workMins;

      entries.push({
        source: "gps",
        timestamp: workEndAt,
        eventType: "departure",
        locationName: facilityName,
        ticketNumber: log.ticket_number,
        ...gradeFields,
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
    const arrivalAt = effectiveArrival(log);
    const workEndAt = effectiveWorkEnd(log);
    const arrivalStr = formatTimeOrNull(arrivalAt);
    const calledStr = formatTimeOrNull(log.called_time);
    const workStartStr = formatTimeOrNull(log.work_start_time);
    const workEndStr = formatTimeOrNull(workEndAt);

    const waitMins = diffMinutes(arrivalAt, log.called_time);
    const workMins = diffMinutes(log.work_start_time, workEndAt);

    lines.push(`▶ ${facilityName}（整理券 #${log.ticket_number}）`);
    lines.push(`  到着時刻: ${arrivalStr}`);
    lines.push(`  荷待ち時間: ${waitMins !== null ? `${waitMins}分（${arrivalStr}〜${calledStr}）` : "未記録"}`);
    lines.push(`  作業時間: ${workMins !== null ? `${workMins}分（${workStartStr}〜${workEndStr}）` : "未記録"}`);

    // 等級Cは時刻がサーバー検証されていない。等級Aと同じ体裁で出すと
    // 証拠の強さを偽ることになるため、必ず注記を添える。
    if (isApprovedClaim(log)) {
      lines.push(
        `  ※ 通信圏外のため端末に記録され、運行管理者が承認した記録です${
          log.self_approved ? "（承認者は運転者本人）" : ""
        }。時刻のサーバー自動検証は行われていません。`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
