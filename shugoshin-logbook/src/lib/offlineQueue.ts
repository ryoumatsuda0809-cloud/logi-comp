/**
 * ⚠️ このモジュールは現在どこからも呼ばれていない。**そのまま繋いではいけない。**
 *
 * 【なぜ危険か】
 * flushQueue は compliance_logs へクライアント時刻の recorded_at を送るが、
 * DB側の trg_force_recorded_at トリガーがこれを**サーバー時刻で無条件に上書き**する。
 * その結果、朝9時にオフラインで打刻した記録が「再接続した15時に到着した」という
 * 偽の記録として保存される。しかもエラーにならず黙って起きる。
 * 待機料の請求根拠としては誤りであり、証拠全体の信頼性を損なう。
 *
 * さらに compliance_logs への直接 insert は CLAUDE.md Rule 1
 * （RPCチェーン必須）にも違反する。
 *
 * 【オフライン打刻を実装する場合に必要なこと】
 *   1. クライアント主張時刻とサーバー受信時刻を**別カラムで両方**保持する
 *   2. オフライン記録であることを明示するフラグを立て、証拠の強さを偽らない
 *   3. 整理券番号はサーバーが施設単位・日単位で採番するため、
 *      オフラインでは確定できない（暫定番号と事後突合の設計が要る）
 *   4. 500mジオフェンス判定もサーバー側のため、オフラインでは検証できない
 *
 * 詳細な検討は docs/CONTEXT_LEGAL_SPEC.md / PROGRESS_LOG.md を参照。
 * 現状のアプリはオフライン時に打刻ボタンを物理ロックし、偽の記録を作らない方針。
 */

import { supabase } from "@/integrations/supabase/client";

const QUEUE_KEY = "COMPLIANCE_LOG_QUEUE";

export interface QueuedLog {
  order_id: string;
  event_type: string;
  latitude: number | null;
  longitude: number | null;
  location_check: boolean;
  user_id: string;
  driver_id: string;
  recorded_at: string;
  waiting_minutes: number;
  location_name: string;
  client_organization_id: string | null;
  is_manual: boolean;
  system_note: string | null;
}

export function getQueue(): QueuedLog[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function enqueue(log: QueuedLog): void {
  const queue = getQueue();
  queue.push(log);
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

function setQueue(queue: QueuedLog[]): void {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

/**
 * Flush queued logs to Supabase one-by-one.
 * Successfully inserted items are removed; failures remain for retry.
 * Returns the number of successfully flushed items.
 */
export async function flushQueue(): Promise<number> {
  const queue = getQueue();
  if (queue.length === 0) return 0;

  let flushed = 0;
  const remaining: QueuedLog[] = [];

  for (const log of queue) {
    const { error } = await supabase.from("compliance_logs").insert({
      order_id: log.order_id,
      event_type: log.event_type as any,
      latitude: log.latitude,
      longitude: log.longitude,
      location_check: log.location_check,
      user_id: log.user_id,
      driver_id: log.driver_id,
      recorded_at: log.recorded_at,
      waiting_minutes: log.waiting_minutes,
      location_name: log.location_name,
      client_organization_id: log.client_organization_id,
      is_manual: log.is_manual,
      system_note: log.system_note,
    });

    if (error) {
      remaining.push(log);
    } else {
      flushed++;
    }
  }

  setQueue(remaining);
  return flushed;
}
