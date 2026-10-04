import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { BottomNav } from "@/components/BottomNav";
import { EvidenceCollector } from "@/components/evidence/EvidenceCollector";

export default function CheckIn() {
  const navigate = useNavigate();

  return (
    <div
      className="flex min-h-screen flex-col bg-background select-none overscroll-none"
      style={{ WebkitTapHighlightColor: "transparent" }}
    >
      {/* ヘッダー */}
      <header className="bg-primary px-4 py-4 shadow-lg">
        <div className="mx-auto flex max-w-4xl items-center gap-3">
          <button
            onClick={() => navigate("/")}
            className="text-primary-foreground/70 hover:text-primary-foreground"
            aria-label="ホームへ戻る"
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <img
            src="/icon-192.png"
            alt="守護神"
            className="h-6 w-6 rounded-md"
          />
          <h1 className="text-lg font-bold text-primary-foreground">
            守護神 打刻
          </h1>
        </div>
      </header>

      {/* メインコンテンツ */}
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col pb-24">
        <EvidenceCollector />
      </main>

      <BottomNav />
    </div>
  );
}
