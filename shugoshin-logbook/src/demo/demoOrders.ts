/**
 * /demo/orders 用の架空データ。
 *
 * 実在の施設・人物・取引とは無関係。本番DBにも AI にもアクセスしない。
 * 「AI解析」は例文ごとに決めた固定の結果を返すだけ（実際の AI 解析ではない）。
 */

/** デモ内の「今日」。/demo の報告書（2026-10-03）と同じ日にそろえ、「明日」などの読み取り結果を毎回同じにする */
export const DEMO_ORDER_TODAY = new Date(2026, 9, 3);
/** 上の日付を yyyy-MM-dd にしたもの（納品日の最小値、発行日の表示に使う） */
export const DEMO_ORDER_TODAY_ISO = "2026-10-03";

/** 4条書面の発注元（架空） */
export const DEMO_ORDER_ISSUER = "架空運送株式会社";
/** 4条書面の発注番号（架空） */
export const DEMO_ORDER_NUMBER = "Order_demo0001";
/** 承認日時の表示（デモは常にこの時刻に承認したことにする） */
export const DEMO_ORDER_APPROVED_AT_LABEL = "2026-10-03 10:15";

/** 実際の parse-order（Edge Function）が返す形と同じ */
export type DemoAiOrderResult = {
  item_name: string;
  quantity: string;
  price: string;
  origin: string;
  destination: string;
  payment_date: string | null;
};

export type DemoOrderExample = {
  id: string;
  /** ボタンに出す短い名前 */
  label: string;
  /** 発注の入力文（実際の画面では、ここに人が打つか話す） */
  sentence: string;
  /** 「AI解析」が返す固定の結果。入力に無い項目は、実際の AI と同じく "不明" などの埋め草が入ることがある */
  aiResult: DemoAiOrderResult;
};

export const DEMO_ORDER_EXAMPLES: DemoOrderExample[] = [
  {
    id: "complete",
    label: "例1：そろっている発注",
    sentence: "架空水産の第2荷捌き場から架空冷蔵の本社倉庫まで、冷凍のブリ20箱、運賃6万円、明日納品",
    aiResult: {
      item_name: "ブリ",
      quantity: "20箱",
      price: "60000",
      origin: "架空水産 第2荷捌き場",
      destination: "架空冷蔵 本社倉庫",
      payment_date: null,
    },
  },
  {
    id: "no-price",
    label: "例2：運賃が書かれていない",
    sentence: "架空物産の配送センターから架空冷蔵の本社倉庫へ、冷蔵のタイ15箱、10月8日に届けたい",
    aiResult: {
      item_name: "タイ",
      quantity: "15箱",
      // 入力に運賃が無いと、AI は "不明" などの埋め草を入れて返すことがある（実際の画面は空欄に戻す）
      price: "不明",
      origin: "架空物産 配送センター",
      destination: "架空冷蔵 本社倉庫",
      payment_date: null,
    },
  },
  {
    id: "no-date",
    label: "例3：納品日が決まっていない",
    sentence: "架空水産の第2荷捌き場から架空物産の配送センターまで、常温の乾物5ケース、運賃3万5千円、納期は未定",
    aiResult: {
      item_name: "乾物",
      quantity: "5ケース",
      price: "35000",
      origin: "架空水産 第2荷捌き場",
      destination: "架空物産 配送センター",
      payment_date: null,
    },
  },
];

/** 「AI解析」のふりをする待ち時間（ミリ秒） */
export const DEMO_PARSE_DELAY_MS = 800;

/** 画面に必ず出す注記 */
export const DEMO_PARSE_NOTE = "デモ用の固定結果です。実際のAI解析ではありません";
