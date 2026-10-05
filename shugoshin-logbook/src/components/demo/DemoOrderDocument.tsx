import { cleanText, displayText, displayYen } from "@/lib/orderContent";
import { latestPaymentDate } from "@/lib/paymentDeadline";
import {
  DEMO_ORDER_CONTRACTOR,
  DEMO_ORDER_ISSUER,
  DEMO_ORDER_NUMBER,
  DEMO_ORDER_TODAY_ISO,
} from "@/demo/demoOrders";

/**
 * 以下の文言は、実際の発注書PDF（supabase/functions/generate-order-pdf）と同じにしてある。
 * 法令名・支払期日の数え方は公取委・中小企業庁のテキストで確認したもの（docs/CONTEXT_LEGAL_SPEC.md）。
 */
const DOC_TITLE = "発注書 兼 取引条件通知書";
const LEGAL_ACT_NAME = "製造委託等に係る中小受託事業者に対する代金の支払の遅延等の防止に関する法律";
const DOC_LEGAL_TITLE = `${LEGAL_ACT_NAME} 第4条の明示`;
const LEGAL_NOTES = [
  "本書面は、中小受託取引適正化法（取適法。2026年1月1日施行）第4条に基づく明示事項を記載した書面です。",
  "代金の支払期日は、役務の提供を受けた日から起算して60日以内（受領日を算入）に定めます。",
  "支払期日までに支払わない場合、役務の提供を受けた日から60日を経過した日から支払日まで、年率14.6%の遅延利息を支払います。",
  "本書面の記載事項に変更が生じた場合は、速やかに書面にて通知します。",
  "代金の減額、買いたたき、不当な給付内容の変更等は禁止されています。",
];
const LEGAL_REMARK = "備考: 特段の検収期間を定めない限り、役務の提供を受けた日をもって検査完了とする。";

export type DemoOrderDocumentData = {
  item_name: string;
  quantity: string;
  price: string;
  origin: string;
  destination: string;
  temperatureZone: string;
  /** yyyy-MM-dd */
  deliveryDate: string;
};

/** yyyy-MM-dd を「2026年10月4日」にする（タイムゾーンに左右されないよう、文字列のまま分解する） */
function formatJaDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "—";
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

/**
 * 承認した発注の「4条書面」（架空データ）。
 * 実際の画面ではPDFでダウンロードする書面と同じ項目・同じ並びを、画面上に出す。
 */
export function DemoOrderDocument({ data }: { data: DemoOrderDocumentData }) {
  // 納品日（役務の提供を受ける日）から60日以内。受領日を算入するので上限は59日後
  const deadline = latestPaymentDate(data.deliveryDate);
  const rows: { label: string; value: string; emphasize?: boolean; highlight?: boolean }[] = [
    { label: "品目名", value: displayText(data.item_name), emphasize: true },
    { label: "数量", value: displayText(data.quantity) },
    { label: "温度帯", value: cleanText(data.temperatureZone) ?? "常温" },
    { label: "出発地", value: displayText(data.origin), emphasize: true },
    { label: "到着地", value: displayText(data.destination), emphasize: true },
    { label: "運賃（税抜）", value: displayYen(data.price), emphasize: true },
    { label: "委託日（発注日）", value: formatJaDate(DEMO_ORDER_TODAY_ISO) },
    { label: "納品日（役務の提供を受ける日）", value: formatJaDate(data.deliveryDate), emphasize: true },
    {
      label: "支払期日（60日以内）",
      value: `${deadline ? formatJaDate(deadline) : "—"}（役務の提供を受けた日から起算して60日以内）`,
      highlight: true,
    },
  ];

  return (
    <article aria-label="4条書面（架空）" className="overflow-hidden rounded-lg border bg-card text-card-foreground">
      <div className="bg-primary px-4 py-3 text-primary-foreground">
        <h3 className="text-base font-bold">{DOC_TITLE}</h3>
        <p className="mt-0.5 text-[11px] leading-snug text-primary-foreground/70">{DOC_LEGAL_TITLE}</p>
      </div>

      <div className="space-y-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <dl className="min-w-0 space-y-0.5 text-xs text-muted-foreground">
            <div>
              <dt className="inline">発行日: </dt>
              <dd className="inline tabular-nums">{formatJaDate(DEMO_ORDER_TODAY_ISO)}</dd>
            </div>
            <div>
              <dt className="inline">発注番号: </dt>
              <dd className="inline break-all">{DEMO_ORDER_NUMBER}</dd>
            </div>
          </dl>
          <div className="flex shrink-0 gap-1" aria-hidden="true">
            {["承認", "担当", "検印"].map((s) => (
              <div key={s} className="flex h-9 w-9 items-end justify-center rounded-sm border pb-0.5 text-[9px] text-muted-foreground">
                {s}
              </div>
            ))}
          </div>
        </div>

        <section>
          <h4 className="text-sm font-bold">【発注元】</h4>
          <p className="mt-1 text-sm">{DEMO_ORDER_ISSUER}</p>
        </section>

        <section>
          <h4 className="mb-2 text-sm font-bold">取引明細</h4>
          <dl className="overflow-hidden rounded-md border text-sm">
            {rows.map((r) => (
              <div
                key={r.label}
                className={`grid grid-cols-[6.5rem_minmax(0,1fr)] border-b last:border-b-0 ${
                  r.highlight ? "bg-accent/10" : ""
                }`}
              >
                <dt className={`border-r px-2 py-2 text-xs ${r.highlight ? "bg-accent/15 font-bold" : "bg-muted/50 text-muted-foreground"}`}>
                  {r.label}
                </dt>
                <dd className={`break-words px-2 py-2 ${r.emphasize ? "font-semibold" : ""} ${r.highlight ? "font-bold" : ""}`}>
                  {r.value}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="space-y-1 text-xs text-muted-foreground">
          <h4 className="text-sm font-bold text-foreground">【発注先（運送事業者）】</h4>
          <p>会社名: {DEMO_ORDER_CONTRACTOR}</p>
          <p>担当者名: ___________________</p>
        </section>

        <section className="grid grid-cols-2 gap-2 text-xs">
          <p>発注者 署名・押印:</p>
          <p>受注者 署名・押印:</p>
        </section>

        <section className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
          <h4 className="font-bold text-foreground">
            法的注釈（{DOC_LEGAL_TITLE}）
          </h4>
          <ul className="mt-1 space-y-0.5">
            {LEGAL_NOTES.map((n, i) => (
              <li key={i}>{i === 0 ? n : `・${n}`}</li>
            ))}
          </ul>
          <p className="mt-1">{LEGAL_REMARK}</p>
        </section>
      </div>
    </article>
  );
}
