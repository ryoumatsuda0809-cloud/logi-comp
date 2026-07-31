import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { calcWaitCost, sumWaitCost } from "@/lib/waitCostCalc";
import { convertWaitLogsToTimeline } from "@/lib/waitLogToTimeline";
import type { WaitLogRow } from "@/lib/waitLogToTimeline";

// ---------- Types ----------

export type TimelineSource = "gps" | "voice";

export interface UnifiedTimelineItem {
  id: string;
  timestamp: string; // ISO string
  source: TimelineSource;
  eventType: string; // compliance_event or 'voice_report'
  label: string;
  location?: string;
  waitMinutes?: number;
  estimatedCost?: number;
  latitude?: number | null;
  longitude?: number | null;
  accuracy?: string | null; // from system_note or metadata
  isManual?: boolean;
  discrepancy?: boolean;
  /** 'C' のとき管理者が承認した圏外申告。荷主への提示で等級Aと区別すること */
  evidenceGrade?: string;
  /** 等級Cで承認者と申請者が同一だった場合 true */
  selfApproved?: boolean;
  // voice-specific
  summary?: string;
  shipperName?: string;
  uncompensatedWork?: boolean;
  formalReport?: string;
  // raw ref
  rawId: string;
}

export interface DailyTimelineResult {
  timeline: UnifiedTimelineItem[];
  vehicleClass: string;
  totalWaitMinutes: number;
  totalWaitCost: number;
  hasDiscrepancy: boolean;
  loading: boolean;
  alreadySubmitted: boolean;
  latestFormalReport: string | null;
}

// ---------- Event label mapping ----------

const EVENT_LABELS: Record<string, string> = {
  arrival: "到着",
  waiting_start: "荷待ち開始",
  loading_start: "積込開始",
  departure: "出発",
  voice_report: "音声日報",
};

// ---------- Discrepancy detection ----------

const DISCREPANCY_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

function detectDiscrepancies(items: UnifiedTimelineItem[]): boolean {
  const gpsTimes = items.filter((i) => i.source === "gps").map((i) => new Date(i.timestamp).getTime());
  const voiceTimes = items.filter((i) => i.source === "voice").map((i) => new Date(i.timestamp).getTime());

  if (gpsTimes.length === 0 || voiceTimes.length === 0) return false;

  for (const vt of voiceTimes) {
    const closest = gpsTimes.reduce((best, gt) => {
      const d = Math.abs(gt - vt);
      return d < best ? d : best;
    }, Infinity);
    if (closest > DISCREPANCY_THRESHOLD_MS) return true;
  }
  return false;
}

function markItemDiscrepancies(items: UnifiedTimelineItem[]): void {
  const gpsTimes = items.filter((i) => i.source === "gps").map((i) => new Date(i.timestamp).getTime());
  
  for (const item of items) {
    if (item.source !== "voice" || gpsTimes.length === 0) continue;
    const vt = new Date(item.timestamp).getTime();
    const closest = gpsTimes.reduce((best, gt) => {
      const d = Math.abs(gt - vt);
      return d < best ? d : best;
    }, Infinity);
    if (closest > DISCREPANCY_THRESHOLD_MS) {
      item.discrepancy = true;
    }
  }
}

// ---------- Hook ----------

export function useDailyTimeline(): DailyTimelineResult {
  const { user } = useAuth();
  const [timeline, setTimeline] = useState<UnifiedTimelineItem[]>([]);
  const [vehicleClass, setVehicleClass] = useState("4t");
  const [loading, setLoading] = useState(true);
  const [alreadySubmitted, setAlreadySubmitted] = useState(false);
  const [latestFormalReport, setLatestFormalReport] = useState<string | null>(null);

  const fetchTimeline = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }

    setLoading(true);

    // Local date string to avoid UTC/JST timezone mismatch
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const todayStart = `${todayStr}T00:00:00`;
    const todayEnd = `${todayStr}T23:59:59`;

    // Parallel fetches (including wait_logs + facilities)
    const [profileRes, logsRes, reportsRes, submittedRes, waitLogsRes, facilitiesRes] = await Promise.all([
      supabase
        .from("profiles")
        .select("vehicle_class")
        .eq("user_id", user.id)
        .maybeSingle(),
      supabase
        .from("compliance_logs")
        .select("*")
        .eq("driver_id", user.id)
        .gte("recorded_at", todayStart)
        .lte("recorded_at", todayEnd)
        .order("recorded_at", { ascending: true }),
      supabase
        .from("daily_reports")
        .select("*")
        .eq("user_id", user.id)
        .gte("created_at", todayStart)
        .lte("created_at", todayEnd)
        .order("created_at", { ascending: true }),
      supabase
        .from("submitted_reports")
        .select("id")
        .eq("user_id", user.id)
        .eq("report_date", todayStr)
        .maybeSingle(),
      supabase
        .from("wait_logs")
        .select("*")
        .eq("user_id", user.id)
        .gte("arrival_time", todayStart)
        .lte("arrival_time", todayEnd)
        .order("arrival_time", { ascending: true }),
      supabase.from("facilities").select("id, name"),
    ]);

    const vc = profileRes.data?.vehicle_class ?? "4t";
    setVehicleClass(vc);
    setAlreadySubmitted(!!submittedRes.data);

    const merged: UnifiedTimelineItem[] = [];

    // Map compliance_logs → UnifiedTimelineItem
    if (logsRes.data) {
      for (const log of logsRes.data) {
        const wm = log.waiting_minutes ?? 0;
        const cost = log.event_type === "waiting_start" && wm > 0 ? calcWaitCost(wm, vc) : undefined;

        merged.push({
          id: `gps-${log.id}`,
          timestamp: log.recorded_at,
          source: "gps",
          eventType: log.event_type,
          label: EVENT_LABELS[log.event_type] ?? log.event_type,
          location: log.location_name ?? undefined,
          waitMinutes: wm > 0 ? wm : undefined,
          estimatedCost: cost,
          latitude: log.latitude,
          longitude: log.longitude,
          accuracy: log.system_note ?? undefined,
          isManual: log.is_manual ?? false,
          rawId: log.id,
        });
      }
    }

    // Map daily_reports → UnifiedTimelineItem
    if (reportsRes.data) {
      for (const report of reportsRes.data) {
        const wm = report.waiting_minutes ?? 0;
        const cost = wm > 0 ? calcWaitCost(wm, vc) : undefined;

        merged.push({
          id: `voice-${report.id}`,
          timestamp: report.created_at ?? new Date().toISOString(),
          source: "voice",
          eventType: "voice_report",
          label: "音声日報",
          shipperName: report.shipper_name ?? undefined,
          summary: report.summary ?? report.report_text,
          waitMinutes: wm > 0 ? wm : undefined,
          estimatedCost: cost,
          uncompensatedWork: report.uncompensated_work ?? false,
          rawId: report.id,
        });
      }
    }

    // Map wait_logs → UnifiedTimelineItem (via convertWaitLogsToTimeline)
    if (waitLogsRes.data && waitLogsRes.data.length > 0) {
      const facilityMap: Record<string, string> = {};
      for (const f of facilitiesRes.data ?? []) {
        facilityMap[f.id] = f.name;
      }
      const waitLogRows: WaitLogRow[] = waitLogsRes.data.map((wl) => ({
        id: wl.id,
        facility_id: wl.facility_id,
        ticket_number: wl.ticket_number,
        status: wl.status,
        arrival_time: wl.arrival_time,
        called_time: wl.called_time,
        work_start_time: wl.work_start_time,
        work_end_time: wl.work_end_time,
        evidence_grade: wl.evidence_grade,
        claimed_at: wl.claimed_at,
        claimed_end_at: wl.claimed_end_at,
        self_approved: wl.self_approved,
      }));
      const { entries } = convertWaitLogsToTimeline(waitLogRows, facilityMap);
      for (const entry of entries) {
        const wm = entry.waitMinutes ?? 0;
        const cost = wm > 0 ? calcWaitCost(wm, vc) : undefined;
        merged.push({
          id: `wl-${entry.eventType}-${entry.timestamp}`,
          timestamp: entry.timestamp,
          source: "gps",
          eventType: entry.eventType,
          label: EVENT_LABELS[entry.eventType] ?? entry.eventType,
          location: entry.locationName,
          waitMinutes: wm > 0 ? wm : undefined,
          estimatedCost: cost,
          evidenceGrade: entry.evidenceGrade,
          selfApproved: entry.selfApproved,
          rawId: entry.ticketNumber?.toString() ?? "",
        });
      }
    }

    setLatestFormalReport(null);

    // Sort by timestamp
    merged.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Mark discrepancies on individual items
    markItemDiscrepancies(merged);

    setTimeline(merged);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    fetchTimeline();
  }, [fetchTimeline]);

  // 待機料の集計対象は「実際の待機イベント」に限定する。
  // 作業時間（loading_start/departure等）を誤って合算すると待機料が過大計算されるため、
  // waiting_start（GPS由来の荷待ち）と voice_report（音声申告の荷待ち）のみを対象とする。
  const isWaitEligible = (i: UnifiedTimelineItem) =>
    i.eventType === "waiting_start" || i.eventType === "voice_report";

  const totalWaitMinutes = timeline
    .filter((i) => isWaitEligible(i) && i.waitMinutes && i.waitMinutes > 0)
    .reduce((sum, i) => sum + (i.waitMinutes ?? 0), 0);

  // 30分の控除は待機1回ごとに適用するため、合計分数ではなく待機1回ごとの分数を
  // sumWaitCost() に渡す。日次合計に calcWaitCost() を1回だけ適用すると過大計算になる。
  const totalWaitCost = sumWaitCost(
    timeline
      .filter((i) => isWaitEligible(i) && i.waitMinutes && i.waitMinutes > 0)
      .map((i) => i.waitMinutes ?? 0),
    vehicleClass
  );

  const hasDiscrepancy = detectDiscrepancies(timeline);

  return {
    timeline,
    vehicleClass,
    totalWaitMinutes,
    totalWaitCost,
    hasDiscrepancy,
    loading,
    alreadySubmitted,
    latestFormalReport,
  };
}
