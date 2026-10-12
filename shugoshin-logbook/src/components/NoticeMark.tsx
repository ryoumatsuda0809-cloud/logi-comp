import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 「知らせる」ための色付きマーク（算定不可・圏外承認など、読み落とすと誤読につながる注意）。
 * 画面の色は琥珀色の1色だけ。形（三角）でも伝えるので、色が見えなくても読める。
 * 印刷は白黒前提なので黒にする。装飾なので読み上げ対象から外し、意味は隣の文が担う。
 */
export function NoticeMark({ className }: { className?: string }) {
  return (
    <AlertTriangle
      aria-hidden="true"
      className={cn(
        "inline-block h-3.5 w-3.5 shrink-0 -translate-y-px text-amber-600 dark:text-amber-400 print:text-black",
        className,
      )}
    />
  );
}
