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
 * デモ専用のナビ。1つの要素のまま、画面の幅で形を変える。
 * - スマホ: 画面の端から浮かせた半透明のバー（iOS 26 のタブバー、Material 3 Expressive のナビ）
 * - PC（lg 以上）: 左に固定したサイドバー。浮いたバーは PC では内容に重なり、横幅も活かせないため
 * 本物の画面の BottomNav は変えない（ドライバーの画面の見た目は変わらない）。
 */
export function DemoBottomNav() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <nav
      aria-label="デモの画面"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 px-3 lg:pointer-events-auto lg:inset-x-auto lg:left-0 lg:top-0 lg:w-60 lg:border-r lg:border-primary-foreground/10 lg:bg-primary lg:px-3 lg:pt-5"
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      {/* PC のサイドバーの上に出す名前（スマホでは上のヘッダーに出ている） */}
      <div className="mb-6 hidden items-center gap-3 px-2 lg:flex">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent">
          <img src="/icon-192.png" alt="" className="h-8 w-8 rounded-md" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-lg font-bold text-primary-foreground">守護神</p>
          <p className="truncate text-xs text-primary-foreground/70">デモ（架空のデータ）</p>
        </div>
      </div>

      <div className="pointer-events-auto mx-auto flex max-w-md items-center gap-1 rounded-full border border-primary-foreground/10 bg-primary/85 p-1.5 shadow-lg shadow-black/25 backdrop-blur-xl lg:mx-0 lg:max-w-none lg:flex-col lg:items-stretch lg:rounded-none lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none lg:backdrop-blur-none">
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
              className={`flex h-14 flex-1 select-none flex-col items-center justify-center gap-0.5 rounded-full transition-colors lg:h-11 lg:flex-none lg:flex-row lg:justify-start lg:gap-3 lg:rounded-lg lg:px-3 ${
                isActive
                  ? "bg-primary-foreground/15 text-accent"
                  : "text-primary-foreground/70 hover:bg-primary-foreground/5 hover:text-primary-foreground"
              }`}
            >
              <Icon className="h-5 w-5" strokeWidth={isActive ? 2.5 : 1.8} />
              <span className="text-[11px] font-medium leading-none lg:text-sm">{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
