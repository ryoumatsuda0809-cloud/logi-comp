import { AlertTriangle, ClipboardList, FileText, MapPin } from "lucide-react";
import { BottomNav, type BottomNavItem } from "@/components/BottomNav";

/** /demo の画面の行き先。本物の画面と同じ下のナビ（BottomNav）に、デモの画面だけを並べる */
export const DEMO_NAV_ITEMS: BottomNavItem[] = [
  { path: "/demo", icon: MapPin, label: "打刻" },
  { path: "/demo/orders", icon: ClipboardList, label: "発注" },
  { path: "/demo/report", icon: FileText, label: "報告書" },
  { path: "/demo/warning", icon: AlertTriangle, label: "警告" },
];

export function DemoBottomNav() {
  return <BottomNav items={DEMO_NAV_ITEMS} />;
}
