import { useNavigate, useLocation } from "react-router-dom";
import { Home, ClipboardList, MapPin, FileText, Building2, type LucideIcon } from "lucide-react";

export type BottomNavItem = { path: string; icon: LucideIcon; label: string };

const DEFAULT_ITEMS: BottomNavItem[] = [
  { path: "/",                      icon: Home,          label: "ホーム" },
  { path: "/orders",                icon: ClipboardList, label: "発注" },
  { path: "/check-in",              icon: MapPin,        label: "打刻" },
  { path: "/daily-report",          icon: FileText,      label: "日報" },
  { path: "/organization-settings", icon: Building2,     label: "組織設定" },
];

/** 画面下の共通ナビ。items を渡すと行き先を差し替えられる（/demo が自分の画面だけを並べるのに使う） */
export function BottomNav({ items = DEFAULT_ITEMS }: { items?: BottomNavItem[] }) {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 flex border-t border-primary-foreground/10 bg-primary"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {items.map(({ path, icon: Icon, label }) => {
        const isActive = location.pathname === path;
        return (
          <button
            key={path}
            onClick={() => navigate(path)}
            className={`flex flex-1 h-[60px] flex-col items-center justify-center gap-1 select-none transition-colors ${
              isActive
                ? "text-accent"
                : "text-primary-foreground/60 hover:text-primary-foreground"
            }`}
          >
            <Icon className="h-5 w-5" strokeWidth={isActive ? 2.5 : 1.8} />
            <span className="text-[11px] font-medium leading-none">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
