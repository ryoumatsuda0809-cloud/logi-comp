import { WifiOff } from "lucide-react";

/**
 * オフライン時の警告バナー。
 *
 * 以前は全画面を覆う OfflineFallback を表示していたが、それだと圏外の現場で
 * ドライバーが「自分が何番の整理券で、いつ到着したことになっているか」すら
 * 確認できなくなる。打刻はできなくても記録の閲覧は妨げないよう、
 * 画面を塞がないバナーに変更した。
 */
export default function OfflineBanner() {
  return (
    <div
      role="status"
      className="fixed left-0 right-0 top-0 z-[60] flex items-center justify-center gap-2 bg-destructive px-4 py-2 text-destructive-foreground shadow-md"
      style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
    >
      <WifiOff className="h-4 w-4 shrink-0" />
      <p className="text-sm font-semibold">
        オフライン — 打刻できません。電波の良い場所へ移動してください
      </p>
    </div>
  );
}
