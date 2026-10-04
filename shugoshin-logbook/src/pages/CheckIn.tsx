import { BottomNav } from "@/components/BottomNav";
import { EvidenceCollector } from "@/components/evidence/EvidenceCollector";
import { PageHeader } from "@/components/PageHeader";

export default function CheckIn() {

  return (
    <div
      className="flex min-h-screen flex-col bg-background select-none overscroll-none"
      style={{ WebkitTapHighlightColor: "transparent" }}
    >
      {/* ヘッダー */}
      <PageHeader title="打刻" />

      {/* メインコンテンツ */}
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col pb-24">
        <EvidenceCollector />
      </main>

      <BottomNav />
    </div>
  );
}
