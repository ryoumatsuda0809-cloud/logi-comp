import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type DemoTopBarProps = {
  /** 画面の名前（/demo は「守護神」） */
  title: string;
  subtitle?: string;
  /** 右端に置く操作（「やり直す」など） */
  right?: ReactNode;
  /** PC では左のメニューに名前が出ているので、行ごと隠す（右の操作が要らない画面） */
  hideOnDesktop?: boolean;
  className?: string;
};

/**
 * デモ画面のいちばん上の行。紺の帯（PageHeader）の代わりに、淡い地の上にアイコンと名前だけを置く。
 * 移動は下のナビ（PC は左のメニュー）に任せるので、戻るボタンは置かない。
 * アイコンはスマホだけ（PC は左のメニューに同じものがある）。
 */
export function DemoTopBar({ title, subtitle = "デモ", right, hideOnDesktop = false, className }: DemoTopBarProps) {
  return (
    <header
      className={cn("px-4 pb-1 pt-3 print:hidden lg:px-8 lg:pt-5", hideOnDesktop && "lg:hidden", className)}
      style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
    >
      <div className="mx-auto flex max-w-4xl items-center gap-2.5 lg:mx-0 lg:max-w-none">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent lg:hidden">
          <img src="/icon-192.png" alt="" className="h-7 w-7 rounded-md" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[17px] font-bold leading-tight lg:text-2xl">{title}</h1>
          <p className="truncate text-xs text-muted-foreground lg:hidden">{subtitle}</p>
        </div>
        {right && <div className="flex shrink-0 items-center gap-1">{right}</div>}
      </div>
    </header>
  );
}

/** 4つのデモ画面で同じ書き方にする注意書き（灰色の帯にはしない） */
export function DemoNotice({ className }: { className?: string }) {
  return (
    <p className={cn("px-4 pt-2 text-xs text-muted-foreground print:hidden lg:px-8", className)}>
      架空のデータです（実在とは無関係）
    </p>
  );
}
