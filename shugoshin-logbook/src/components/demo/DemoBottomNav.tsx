import { useLocation, useNavigate } from "react-router-dom";
import { AlertTriangle, ClipboardList, FileText, MapPin } from "lucide-react";
import type { BottomNavItem } from "@/components/BottomNav";

/** /demo の画面の行き先 */
export const DEMO_NAV_ITEMS: BottomNavItem[] = [
  { path: "/demo", icon: MapPin, label: "打刻" },
  { path: "/demo/orders", icon: ClipboardList, label: "発注" },
  { path: "/demo/report", icon: FileText, label: "報告書" },
  { path: "/demo/warning", icon: AlertTriangle, label: "警告" },
];

/**
 * デモ専用の下のナビ。スマホのアプリ（iOS 26 のタブバー、Material 3 Expressive のナビ）に合わせ、
 * 画面の端から浮かせた半透明のバーにして、選んでいる画面を背景の丸で示す。
 * 本物の画面の BottomNav は変えない（ドライバーの画面の見た目は変わらない）。
 */
export function DemoBottomNav() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <nav
      aria-label="デモの画面"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 px-3"
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      <div className="pointer-events-auto mx-auto flex max-w-md items-center gap-1 rounded-full border border-primary-foreground/10 bg-primary/85 p-1.5 shadow-lg shadow-black/25 backdrop-blur-xl">
        {DEMO_NAV_ITEMS.map(({ path, icon: Icon, label }) => {
          const isActive = location.pathname === path;
          return (
            <button
              key={path}
              type="button"
              onClick={() => {
                // 触った手応え。対応している端末（主に Android）だけ。iPhone のブラウザは振動できない
                if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(8);
                navigate(path);
              }}
              aria-current={isActive ? "page" : undefined}
              className={`flex h-14 flex-1 select-none flex-col items-center justify-center gap-0.5 rounded-full transition-colors ${
                isActive
                  ? "bg-primary-foreground/15 text-accent"
                  : "text-primary-foreground/70 hover:text-primary-foreground"
              }`}
            >
              <Icon className="h-5 w-5" strokeWidth={isActive ? 2.5 : 1.8} />
              <span className="text-[11px] font-medium leading-none">{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
