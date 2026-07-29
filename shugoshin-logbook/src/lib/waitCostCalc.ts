/**
 * 車格別待機料計算ユーティリティ
 * 2024年問題対応 — 30分超過分のみ課金
 */

const RATE_MAP: Record<string, number> = {
  '2t': 40,
  '4t': 50,
  '10t': 60,
};

const DEFAULT_VEHICLE_CLASS = '4t';

/**
 * 待機料を計算する
 * @param waitMinutes 待機時間（分）
 * @param vehicleClass 車格（'2t' | '4t' | '10t'）
 * @returns 待機料（円）。30分以下は0円。
 */
export function calcWaitCost(waitMinutes: number, vehicleClass: string): number {
  if (waitMinutes <= 30) return 0;
  const rate = RATE_MAP[vehicleClass] ?? RATE_MAP[DEFAULT_VEHICLE_CLASS];
  return (waitMinutes - 30) * rate;
}

/**
 * 車格の表示名を返す
 */
export function vehicleClassLabel(vc: string): string {
  if (vc in RATE_MAP) return `${vc}車`;
  return `${DEFAULT_VEHICLE_CLASS}車（デフォルト）`;
}

/**
 * 単価を返す（円/分）
 */
export function getRate(vehicleClass: string): number {
  return RATE_MAP[vehicleClass] ?? RATE_MAP[DEFAULT_VEHICLE_CLASS];
}

/**
 * 複数回の待機の待機料合計を返す。
 *
 * 【なぜこの関数が必要か】
 * 30分の控除は「待機1回ごと」に適用される（標準貨物自動車運送約款の待機時間料は
 * 集貨地・配達地ごとの待機について算定するため）。
 * 日次合計に対して calcWaitCost() を1回だけ適用すると控除が1回分しか効かず、
 * 荷主へ提示する請求額が過大になる。
 *
 *   例) 40分待機 × 2回、4t車（50円/分）
 *       正: (40-30)*50 * 2 =  1,000円
 *       誤: (80-30)*50     =  2,500円   ← 日次合計に適用した場合
 *   例) 20分待機 × 3回
 *       正: 0円（各回とも30分以下）
 *       誤: (60-30)*50     =  1,500円   ← 課金対象でない待機に課金してしまう
 *
 * 集計側で calcWaitCost を直接呼ばず、必ずこの関数を経由すること。
 */
export function sumWaitCost(waitMinutesList: number[], vehicleClass: string): number {
  return waitMinutesList.reduce((sum, m) => sum + calcWaitCost(m, vehicleClass), 0);
}
