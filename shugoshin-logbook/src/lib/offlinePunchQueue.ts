/**
 * 圏外で記録した打刻のローカルキュー（オフライン打刻 Phase 1）
 *
 * 【このモジュールの立ち位置】
 * 旧 `offlineQueue.ts` は compliance_logs へクライアント時刻を直接 INSERT しようとし、
 * DB側のトリガーがサーバー時刻で黙って上書きするため使えなかった（同ファイルのヘッダー参照）。
 * こちらは代わりに `queue_offline_punch` RPC を叩き、`pending_punches` へ
 * **申請として** 送る。主張時刻 `claimed_at` は上書きされずそのまま保存される。
 *
 * 【重要な前提】
 * ここに溜まった打刻は、送信しても待機料の請求根拠にはならない。
 * 管理者が承認して初めて `wait_logs` へ昇格する（承認機能は Phase 2）。
 * UI はこれを「仮記録」として明示し、確定した打刻と同じ見た目にしてはならない。
 *
 * 詳細な設計は docs/DESIGN_OFFLINE_PUNCH.md を参照。
 */

import { supabase } from "@/integrations/supabase/client";
import type { FisheryData } from "@/hooks/useEvidence";
import type { Json } from "@/integrations/supabase/types";

const QUEUE_KEY = "OFFLINE_PUNCH_QUEUE";
const FAILED_KEY = "OFFLINE_PUNCH_FAILED";

/**
 * 'loading_start' は荷待ち時間の終端＝待機料の課金境界にあたる。
 * 圏外でこれを記録できないと、その待機の待機料をまるごと失う。
 */
export type PunchType = "arrival" | "loading_start" | "completion";

export interface OfflinePunch {
  /** 冪等キー。再送しても二重申請にならないよう端末側で発番する */
  clientPunchId: string;
  punchType: PunchType;
  /** 端末が主張する打刻時刻（ISO）。検証不能な値であることを忘れないこと */
  claimedAt: string;
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  note: string | null;
  /** 完了打刻の申請の場合、対象の待機ログID */
  waitLogId: string | null;
  /** 完了打刻の申請に付随する水産物情報。到着の申請では null */
  fisheryData: FisheryData | null;
}

/**
 * 水産物情報をRPCへ渡す形に整える。
 *
 * 漁獲番号は特定第一種水産動植物のみ法令上必要なため、対象外の魚種では
 * catch_number を持たせない（useEvidence.completeTicket と同じ整形）。
 */
function toFisheryPayload(data: FisheryData | null): Json | null {
  if (!data) return null;
  return {
    species: data.species,
    weight_kg: data.weight_kg,
    ...(data.species_id ? { species_id: data.species_id } : {}),
    ...(data.catch_number ? { catch_number: data.catch_number } : {}),
  };
}

/** 送信したがサーバーに恒久的に拒否された申請（理由をドライバーに見せるために保持する） */
export interface RejectedPunch extends OfflinePunch {
  reason: string;
  rejectedAt: string;
}

/** crypto.randomUUID が無い環境向けのフォールバック */
function newUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function readJson<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

function writeJson<T>(key: string, value: T[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 保存領域が一杯でも打刻操作自体は落とさない
  }
}

export function getQueue(): OfflinePunch[] {
  return readJson<OfflinePunch>(QUEUE_KEY);
}

export function getRejected(): RejectedPunch[] {
  return readJson<RejectedPunch>(FAILED_KEY);
}

export function clearRejected(): void {
  writeJson<RejectedPunch>(FAILED_KEY, []);
}

/**
 * 圏外の打刻をキューに積む。clientPunchId をここで発番して返す。
 */
export function enqueuePunch(
  punch: Omit<OfflinePunch, "clientPunchId">
): OfflinePunch {
  const entry: OfflinePunch = { ...punch, clientPunchId: newUuid() };
  writeJson(QUEUE_KEY, [...getQueue(), entry]);
  return entry;
}

/**
 * サーバーが恒久的に拒否したかどうかを判定する。
 *
 * 未来時刻・30日超過・座標欠落などは何度送り直しても通らないため、
 * キューに残し続けると永久に再送し続けることになる。逆に通信エラーは
 * 電波が戻れば通るので必ずキューに残す。
 */
function isPermanentRejection(message: string): boolean {
  return (
    message.includes("[法的保護]") ||
    message.includes("check_violation") ||
    message.includes("not_null_violation") ||
    message.includes("打刻種別が不正")
  );
}

export interface FlushResult {
  /** サーバーに受理された件数（重複として既存が返ったものを含む） */
  accepted: number;
  /** 恒久的に拒否され、キューから外した件数 */
  rejected: number;
  /** 通信エラー等でキューに残した件数 */
  retained: number;
}

/**
 * キューをサーバーへ送る。
 *
 * - 受理された申請はキューから外す
 * - 恒久的に拒否された申請はキューから外し、理由付きで rejected 側へ移す
 * - 通信エラーはキューに残して次回に再試行する
 */
export async function flushPunchQueue(): Promise<FlushResult> {
  const queue = getQueue();
  if (queue.length === 0) return { accepted: 0, rejected: 0, retained: 0 };

  const retained: OfflinePunch[] = [];
  const newlyRejected: RejectedPunch[] = [];
  let accepted = 0;

  for (const punch of queue) {
    const { error } = await supabase.rpc("queue_offline_punch", {
      p_claimed_at: punch.claimedAt,
      p_latitude: punch.latitude,
      p_longitude: punch.longitude,
      p_client_punch_id: punch.clientPunchId,
      p_punch_type: punch.punchType,
      p_accuracy_m: punch.accuracyM,
      p_note: punch.note,
      p_wait_log_id: punch.waitLogId,
      p_fishery_data: toFisheryPayload(punch.fisheryData),
    });

    if (!error) {
      accepted++;
      continue;
    }

    const msg = error.message ?? "";
    if (isPermanentRejection(msg)) {
      newlyRejected.push({
        ...punch,
        reason: msg,
        rejectedAt: new Date().toISOString(),
      });
    } else {
      retained.push(punch);
    }
  }

  writeJson(QUEUE_KEY, retained);
  if (newlyRejected.length > 0) {
    writeJson(FAILED_KEY, [...getRejected(), ...newlyRejected]);
  }

  return {
    accepted,
    rejected: newlyRejected.length,
    retained: retained.length,
  };
}
