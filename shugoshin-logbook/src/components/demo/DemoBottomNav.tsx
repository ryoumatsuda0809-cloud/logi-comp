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
 * デモ専用のナビ。1つの要素のまま、画面の幅で形を変える（案A「明るいガラス」）。
 * - スマホ: 下に浮いた丸いガラスのバー
 * - PC（lg 以上）: 左に浮いたガラスのメニュー
 * どちらも、今いる画面は紺で塗る。本物の画面の BottomNav は変えない。
 */
export function DemoBottomNav() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <nav
      aria-label="デモの画面"
      className="demo-nav pointer-events-none fixed inset-x-0 bottom-0 z-50 px-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))] lg:pointer-events-auto lg:inset-x-auto lg:bottom-5 lg:left-5 lg:top-5 lg:w-[232px] lg:p-4"
    >
      {/* PC のメニューの上に出す名前（スマホでは画面の上に出ている） */}
      <div className="mb-5 hidden items-center gap-2.5 px-1.5 lg:flex">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent">
          <img src="/icon-192.png" alt="" className="h-7 w-7 rounded-md" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-[17px] font-bold leading-tight">守護神</p>
          <p className="truncate text-xs text-muted-foreground">デモ（架空のデータ）</p>
        </div>
      </div>

      <div className="demo-nav-bar pointer-events-auto mx-auto flex max-w-md items-center gap-1 p-1.5 lg:mx-0 lg:max-w-none lg:flex-col lg:items-stretch lg:gap-1.5 lg:p-0">
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
              className={`flex h-[52px] flex-1 select-none flex-col items-center justify-center gap-0.5 rounded-full transition-colors lg:h-11 lg:flex-none lg:flex-row lg:justify-start lg:gap-2.5 lg:rounded-[14px] lg:px-3 ${
                isActive
                  ? "bg-primary text-primary-foreground shadow-[0_8px_20px_-8px_rgba(15,23,42,0.5)]"
                  : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
              }`}
            >
              <Icon className="h-5 w-5" strokeWidth={isActive ? 2.4 : 1.8} />
              <span className="text-xs font-bold leading-none lg:text-sm lg:font-semibold">{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
