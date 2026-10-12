import { FileDown } from "lucide-react";
import { FieldButton } from "@/components/ui/field-button";

/**
 * デモの見本 PDF（public/samples/）。いずれも架空のデータ。
 * 画面の内容を変えたら scripts/make-demo-pdfs.mjs で作り直す。
 */
export const DEMO_SAMPLE_PDF = {
  order: "/samples/demo-order.pdf",
  report: "/samples/demo-report.pdf",
  warning: "/samples/demo-warning.pdf",
} as const;

/**
 * 「印刷・PDF保存」は window.print() を呼ぶだけで、ホーム画面から開いたアプリや LINE などの
 * アプリ内ブラウザ（iPhone）では何も起きないことがある。そういう端末でも PDF が開けるよう、
 * 見本の PDF へのリンクを別に置く。
 */
export function DemoPdfLink({
  href,
  fullWidth,
  children,
}: {
  href: (typeof DEMO_SAMPLE_PDF)[keyof typeof DEMO_SAMPLE_PDF];
  fullWidth?: boolean;
  children: React.ReactNode;
}) {
  return (
    <FieldButton asChild variant="outline" fullWidth={fullWidth} className="gap-3">
      <a href={href} target="_blank" rel="noopener noreferrer">
        <FileDown />
        {children}
      </a>
    </FieldButton>
  );
}
