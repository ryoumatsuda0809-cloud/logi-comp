import { describe, it, expect } from "vitest";
import {
  convertWaitLogsToTimeline,
  diffMinutes,
  generateFormalReportFromWaitLogs,
  type WaitLogRow,
} from "./waitLogToTimeline";
import { calcWaitCost, sumWaitCost } from "./waitCostCalc";

describe("convertWaitLogsToTimeline — 待機料誤課金防止の回帰テスト", () => {
  const facilityMap = { "facility-1": "下関中央卸売市場" };

  it("departureエントリのwaitMinutesは未設定であること（作業時間を待機時間として計上しない）", () => {
    const logs: WaitLogRow[] = [
      {
        id: "log-1",
        facility_id: "facility-1",
        ticket_number: 1,
        status: "completed",
        arrival_time: "2026-07-20T09:00:00.000Z",
        called_time: "2026-07-20T09:20:00.000Z", // 荷待ち20分（30分以下なので待機料は0円だが分は計上される）
        work_start_time: "2026-07-20T09:20:00.000Z",
        work_end_time: "2026-07-20T11:20:00.000Z", // 作業時間120分（これが待機時間扱いされるとバグ）
      },
    ];

    const { entries, totalWaitMinutes, totalWorkMinutes } = convertWaitLogsToTimeline(
      logs,
      facilityMap
    );

    const departureEntry = entries.find((e) => e.eventType === "departure");
    expect(departureEntry).toBeDefined();
    // 作業時間(120分)がwaitMinutesとして紛れ込んでいないこと
    expect(departureEntry?.waitMinutes).toBeUndefined();

    const waitingStartEntry = entries.find((e) => e.eventType === "waiting_start");
    expect(waitingStartEntry?.waitMinutes).toBe(20);

    // 待機時間の合計は荷待ち20分のみ（作業時間120分を含まない）
    expect(totalWaitMinutes).toBe(20);
    expect(totalWorkMinutes).toBe(120);
  });

  it("diffMinutesは負の差分を0にクランプする", () => {
    expect(
      diffMinutes("2026-07-20T10:00:00.000Z", "2026-07-20T09:00:00.000Z")
    ).toBe(0);
  });

  it("取消済み(cancelled)の打刻は待機時間・待機料・法定乗務記録のいずれにも計上しない", () => {
    // cancel_ticket は status='called'/'working' の行も取消可能なため、
    // called_time が入ったまま cancelled になった行が課金対象に混入しうる。
    const logs: WaitLogRow[] = [
      {
        id: "log-live",
        facility_id: "facility-1",
        ticket_number: 1,
        status: "completed",
        arrival_time: "2026-07-20T09:00:00.000Z",
        called_time: "2026-07-20T09:40:00.000Z", // 荷待ち40分（有効）
        work_start_time: "2026-07-20T09:40:00.000Z",
        work_end_time: "2026-07-20T10:00:00.000Z",
      },
      {
        id: "log-cancelled",
        facility_id: "facility-1",
        ticket_number: 2,
        status: "cancelled",
        arrival_time: "2026-07-20T13:00:00.000Z",
        called_time: "2026-07-20T15:00:00.000Z", // 取消済みなので計上してはいけない120分
        work_start_time: null,
        work_end_time: null,
      },
    ];

    const { entries, totalWaitMinutes, waitMinutesPerEvent } = convertWaitLogsToTimeline(
      logs,
      facilityMap
    );

    // 取消済みログ由来のエントリが一切生成されていないこと（到着エントリも含む）
    expect(entries.some((e) => e.ticketNumber === 2)).toBe(false);
    expect(totalWaitMinutes).toBe(40);
    expect(waitMinutesPerEvent).toEqual([40]);

    // 荷主へ提示する法定乗務記録にも取消済みの打刻が現れないこと
    const report = generateFormalReportFromWaitLogs(logs, facilityMap);
    expect(report).toContain("整理券 #1");
    expect(report).not.toContain("整理券 #2");
  });

  it("全ログが取消済みの場合、法定乗務記録は「記録なし」になる", () => {
    const logs: WaitLogRow[] = [
      {
        id: "log-cancelled",
        facility_id: "facility-1",
        ticket_number: 1,
        status: "cancelled",
        arrival_time: "2026-07-20T09:00:00.000Z",
        called_time: null,
        work_start_time: null,
        work_end_time: null,
      },
    ];
    expect(generateFormalReportFromWaitLogs(logs, facilityMap)).toBe("（記録なし）");
  });
});

describe("荷待ち時間の終端（荷役開始）", () => {
  const facilityMap = { "facility-1": "下関中央卸売市場" };

  const base = {
    id: "log-1",
    facility_id: "facility-1",
    ticket_number: 1,
    status: "completed",
    arrival_time: "2026-07-31T09:00:00.000Z",
  };

  it("荷役開始(work_start_time)が終端になり、呼出から荷役開始までも荷待ちに含まれる", () => {
    // 到着9:00 → 呼出9:30 → 荷役開始9:50 → 完了10:30
    // 呼出〜荷役開始の20分もドライバーは荷役を待っているため荷待ちに含む
    const logs: WaitLogRow[] = [
      {
        ...base,
        called_time: "2026-07-31T09:30:00.000Z",
        work_start_time: "2026-07-31T09:50:00.000Z",
        work_end_time: "2026-07-31T10:30:00.000Z",
      },
    ];

    const { totalWaitMinutes, totalWorkMinutes, entries } = convertWaitLogsToTimeline(
      logs,
      facilityMap
    );

    expect(totalWaitMinutes).toBe(50); // 呼出までの30分ではなく荷役開始までの50分
    expect(totalWorkMinutes).toBe(40); // 荷役開始〜完了

    const wait = entries.find((e) => e.eventType === "waiting_start");
    expect(wait?.timestamp).toBe("2026-07-31T09:50:00.000Z");
  });

  it("荷役開始が無い場合は呼出で代替する（従来データの後方互換）", () => {
    const logs: WaitLogRow[] = [
      {
        ...base,
        called_time: "2026-07-31T09:40:00.000Z",
        work_start_time: null,
        work_end_time: "2026-07-31T10:30:00.000Z",
      },
    ];

    const { totalWaitMinutes } = convertWaitLogsToTimeline(logs, facilityMap);
    expect(totalWaitMinutes).toBe(40);
  });

  it("荷役開始も呼出も無い場合、荷待ちは算定不能とし、作業完了へフォールバックしない", () => {
    // ここで work_end_time にフォールバックすると荷役作業時間が待機料に混入する
    const logs: WaitLogRow[] = [
      {
        ...base,
        called_time: null,
        work_start_time: null,
        work_end_time: "2026-07-31T12:00:00.000Z", // 到着から3時間
      },
    ];

    const { totalWaitMinutes, waitMinutesPerEvent, entries } = convertWaitLogsToTimeline(
      logs,
      facilityMap
    );

    expect(totalWaitMinutes).toBe(0);
    expect(waitMinutesPerEvent).toEqual([]);
    expect(entries.some((e) => e.eventType === "waiting_start")).toBe(false);
    // 到着と出発は記録として残る
    expect(entries.map((e) => e.eventType)).toEqual(["arrival", "departure"]);
  });

  it("法定乗務記録の荷待ち時間も荷役開始を終端にする", () => {
    const report = generateFormalReportFromWaitLogs(
      [
        {
          ...base,
          called_time: "2026-07-31T09:30:00.000Z",
          work_start_time: "2026-07-31T09:50:00.000Z",
          work_end_time: "2026-07-31T10:30:00.000Z",
        },
      ],
      facilityMap
    );
    expect(report).toContain("荷待ち時間: 50分");
    expect(report).toContain("作業時間: 40分");
  });
});

describe("等級C（圏外申告の承認記録）の扱い", () => {
  const facilityMap = { "facility-1": "下関中央卸売市場" };

  // 圏外の到着を9:00に主張し、管理者が翌日15:00に承認したケース。
  // arrival_time には承認時刻が入るため、これを起点にすると待機時間が壊れる。
  const gradeCLog: WaitLogRow = {
    id: "log-c",
    facility_id: "facility-1",
    ticket_number: 1,
    status: "completed",
    arrival_time: "2026-07-31T15:00:00.000Z", // 承認処理を行ったサーバー時刻
    claimed_at: "2026-07-30T09:00:00.000Z", // ドライバーが主張する実際の到着
    called_time: "2026-07-30T10:00:00.000Z", // 荷待ち60分
    work_start_time: "2026-07-30T10:00:00.000Z",
    work_end_time: "2026-07-31T15:00:00.000Z", // 承認時刻
    claimed_end_at: "2026-07-30T11:00:00.000Z", // 主張する作業完了
    evidence_grade: "C",
    self_approved: false,
  };

  it("待機時間は承認時刻ではなく主張時刻から算出される", () => {
    const { entries, totalWaitMinutes, waitMinutesPerEvent } = convertWaitLogsToTimeline(
      [gradeCLog],
      facilityMap
    );

    // 承認時刻(7/31 15:00)を起点にすると負の値になる。主張時刻(7/30 9:00)が使われること
    expect(totalWaitMinutes).toBe(60);
    expect(waitMinutesPerEvent).toEqual([60]);

    const arrival = entries.find((e) => e.eventType === "arrival");
    expect(arrival?.timestamp).toBe("2026-07-30T09:00:00.000Z");

    const departure = entries.find((e) => e.eventType === "departure");
    expect(departure?.timestamp).toBe("2026-07-30T11:00:00.000Z");
  });

  it("等級Cのエントリには等級が伝播し、荷主向けに区別できる", () => {
    const { entries } = convertWaitLogsToTimeline([gradeCLog], facilityMap);
    expect(entries.every((e) => e.evidenceGrade === "C")).toBe(true);
  });

  it("等級A（通常の打刻）には等級が付かず、従来通りの挙動になる", () => {
    const gradeALog: WaitLogRow = {
      id: "log-a",
      facility_id: "facility-1",
      ticket_number: 2,
      status: "completed",
      arrival_time: "2026-07-30T09:00:00.000Z",
      called_time: "2026-07-30T09:40:00.000Z",
      work_start_time: "2026-07-30T09:40:00.000Z",
      work_end_time: "2026-07-30T10:00:00.000Z",
    };

    const { entries, totalWaitMinutes } = convertWaitLogsToTimeline([gradeALog], facilityMap);
    expect(totalWaitMinutes).toBe(40);
    expect(entries.every((e) => e.evidenceGrade === undefined)).toBe(true);
  });

  it("法定乗務記録に、サーバー検証されていない旨の注記が入る", () => {
    const report = generateFormalReportFromWaitLogs([gradeCLog], facilityMap);
    expect(report).toContain("運行管理者が承認した記録");
    expect(report).toContain("時刻のサーバー自動検証は行われていません");
    // 主張時刻ベースの荷待ち時間が出ていること
    expect(report).toContain("60分");
  });

  it("自己承認の場合はその旨も法定乗務記録に明示される", () => {
    const report = generateFormalReportFromWaitLogs(
      [{ ...gradeCLog, self_approved: true }],
      facilityMap
    );
    expect(report).toContain("承認者は運転者本人");
  });

  it("等級Aの記録には承認の注記が付かない", () => {
    const report = generateFormalReportFromWaitLogs(
      [
        {
          id: "log-a",
          facility_id: "facility-1",
          ticket_number: 1,
          status: "completed",
          arrival_time: "2026-07-30T09:00:00.000Z",
          called_time: "2026-07-30T09:40:00.000Z",
          work_start_time: "2026-07-30T09:40:00.000Z",
          work_end_time: "2026-07-30T10:00:00.000Z",
        },
      ],
      facilityMap
    );
    expect(report).not.toContain("運行管理者が承認した記録");
  });
});

describe("sumWaitCost — 30分控除の適用単位（過大請求防止）", () => {
  it("30分の控除は待機1回ごとに適用される（日次合計に1回だけ適用しない）", () => {
    // 40分待機 × 2回、4t車（50円/分）
    const perEvent = sumWaitCost([40, 40], "4t");
    expect(perEvent).toBe(1000); // (40-30)*50 * 2

    // 日次合計へ1回だけ適用した場合の誤った値と一致しないこと
    expect(perEvent).not.toBe(calcWaitCost(80, "4t")); // (80-30)*50 = 2500
  });

  it("各回が30分以下の待機は、合計が30分を超えても課金されない", () => {
    // 20分待機 × 3回 = 合計60分だが、どの回も課金対象ではない
    expect(sumWaitCost([20, 20, 20], "4t")).toBe(0);
    expect(calcWaitCost(60, "4t")).toBe(1500); // 合計に適用すると誤課金になる
  });

  it("待機が0件なら0円", () => {
    expect(sumWaitCost([], "4t")).toBe(0);
  });
});
