import { addDays } from "date-fns";
import { cleanText, displayText, displayYen } from "@/lib/orderContent";
import { DEMO_ORDER_ISSUER, DEMO_ORDER_NUMBER, DEMO_ORDER_TODAY_ISO } from "@/demo/demoOrders";

/**
 * 以下の文言は、実際の発注書PDF（supabase/functions/generate-order-pdf）と同じにしてある。
 * 法令名・注釈の正しさはこのデモでは判断せず、実際の書面に合わせている。
 */
const DOC_TITLE = "発注書 兼 取引条件通知書";
const DOC_LEGAL_TITLE = "特定受託事業者に係る取引の適正化等に関する法律 第4条書面";
const LEGAL_NOTES = [
  "本書面は2026年施行の取適法第4条に基づき交付する書面です。",
  "本取引は下請法および取適法に基づき、物品受領後60日以内の支払いを厳守します。",
  "支払期日を超過した場合、遅延損害金が発生します。",
  "本書面の記載事項に変更が生じた場合は、速やかに書面にて通知します。",
  "下請代金の減額、買いたたき、不当な給付内容の変更等は禁止されています。",
];
const LEGAL_REMARK = "備考: 特段の検収期間を定めない限り、物品受領日をもって検査完了とする。";

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

/** 納品日の60日後（支払期日）を yyyy-MM-dd で返す */
function paymentDeadlineIso(deliveryIso: string): string | null {
  const m = deliveryIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = addDays(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), 60);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 承認した発注の「4条書面」（架空データ）。
 * 実際の画面ではPDFでダウンロードする書面と同じ項目・同じ並びを、画面上に出す。
 */
export function DemoOrderDocument({ data }: { data: DemoOrderDocumentData }) {
  const deadline = paymentDeadlineIso(data.deliveryDate);
  const rows: { label: string; value: string; emphasize?: boolean; highlight?: boolean }[] = [
    { label: "品目名", value: displayText(data.item_name), emphasize: true },
    { label: "数量", value: displayText(data.quantity) },
    { label: "温度帯", value: cleanText(data.temperatureZone) ?? "常温" },
    { label: "出発地", value: displayText(data.origin), emphasize: true },
    { label: "到着地", value: displayText(data.destination), emphasize: true },
    { label: "運賃（税抜）", value: displayYen(data.price), emphasize: true },
    { label: "納品日", value: formatJaDate(data.deliveryDate), emphasize: true },
    {
      label: "支払期日（60日ルール）",
      value: `${deadline ? formatJaDate(deadline) : "—"}（物品受領日から60日以内）`,
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
          <p>会社名: ___________________</p>
          <p>担当者名: ___________________</p>
        </section>

        <section className="grid grid-cols-2 gap-2 text-xs">
          <p>発注者 署名・押印:</p>
          <p>受注者 署名・押印:</p>
        </section>

        <section className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
          <h4 className="font-bold text-foreground">
            法的注釈（特定受託事業者に係る取引の適正化等に関する法律 第4条書面）
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
