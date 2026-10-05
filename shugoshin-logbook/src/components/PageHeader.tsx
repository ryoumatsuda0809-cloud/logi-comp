import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

type PageHeaderProps = {
  title: string;
  subtitle?: ReactNode;
  /** 戻る先。共有リンクから直接開かれることがあるので、履歴ではなく行き先を決めておく */
  backTo?: string;
  /** 右端に置く操作 */
  right?: ReactNode;
  /** 見出しの下に続ける行（施設の切り替えなど） */
  children?: ReactNode;
  className?: string;
};

/** ホーム以外の画面の共通ヘッダー（戻る・見出し・補足・右端の操作） */
export function PageHeader({ title, subtitle, backTo = "/", right, children, className }: PageHeaderProps) {
  const navigate = useNavigate();
  return (
    <header className={cn("sticky top-0 z-30 bg-primary px-4 py-3 shadow-md", className)}>
      <div className="mx-auto flex max-w-4xl items-center gap-2">
        <button
          type="button"
          onClick={() => navigate(backTo)}
          className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-primary-foreground hover:bg-primary-foreground/10"
          aria-label="戻る"
        >
          <ArrowLeft className="h-6 w-6" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold text-primary-foreground">{title}</h1>
          {subtitle && <p className="truncate text-xs text-primary-foreground/70">{subtitle}</p>}
        </div>
        {right && <div className="flex shrink-0 items-center gap-1">{right}</div>}
      </div>
      {children && <div className="mx-auto max-w-4xl">{children}</div>}
    </header>
  );
}
