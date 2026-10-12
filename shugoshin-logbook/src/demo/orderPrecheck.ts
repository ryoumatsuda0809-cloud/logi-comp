import { invalidForApproval, missingForApproval, type OrderFields } from "@/lib/orderContent";

/**
 * 承認ボタンを押す前に、入力の途中でも見せる「確認が必要な項目」の文。デモ用の事前表示。
 * 判定は承認ボタンと同じ missingForApproval / invalidForApproval を使う。ここで新しい規則は足さない。
 * 表示だけで、承認できるかどうかは変えない（止めるのは承認ボタンの確認と DB のガード）。
 */
export function orderPrecheckNotices(content: OrderFields, deliveryDate: string | null | undefined): string[] {
  const notices: string[] = [];
  const missing = missingForApproval(content, deliveryDate);
  if (missing.length > 0) notices.push(`${missing.join("・")}が入っていません`);
  notices.push(...invalidForApproval(content));
  return notices;
}
