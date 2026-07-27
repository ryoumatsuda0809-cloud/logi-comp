# 守護神 — 進行状況・設計方針ログ

> **対象読者**: 進行中の修正・設計判断の背景を追いたい担当者
> **最終更新**: 2026-07-27
> **関連ドキュメント**: [`IMPLEMENTATION_SUMMARY.md`](./IMPLEMENTATION_SUMMARY.md)（実装済み機能のベースライン）

---

## 目次

1. [進行中の修正 #1: complete_ticket の GPS 座標詰みバグ](#進行中の修正-1-complete_ticket-の-gps-座標詰みバグ)
2. [進行中の修正 #2: 待機料の過大計算バグ](#進行中の修正-2-待機料の過大計算バグ)
3. [未着手・要検討事項](#未着手要検討事項)

---

## 進行中の修正 #1: complete_ticket の GPS 座標詰みバグ

### 何が起きていたか

`complete_ticket` RPC が `wait_logs.latitude` / `wait_logs.longitude`（到着時保存値）を読み取って `waiting_evidence` に INSERT していたが、`issue_ticket` 経由で作成された `wait_logs` 行がこの2カラムに NULL を持つケースがあり、`waiting_evidence` の NOT NULL 制約に違反して INSERT が失敗していた。

結果として「作業完了（出発）」操作が 500 エラーで失敗し、該当の待機ログが `status='waiting'` のまま永久に残留 → ドライバーが新しい到着打刻もできなくなる詰み状態が発生していた。

### 方針

出発時の GPS 座標は「到着時座標の再利用」ではなく、**作業完了操作その場でドライバー端末から再取得した座標**を証拠として記録するのが本来の意味的に正しい設計。そのため `wait_logs` 側の値には一切依存せず、`p_latitude` / `p_longitude` を必須引数として受け取る形に変更する。

### 変更点

| ファイル | 内容 |
|---------|------|
| `supabase/migrations/20260720120000_fix_complete_ticket_gps_coords.sql` | `complete_ticket(p_log_id, p_latitude, p_longitude, p_fishery_data)` に signature 変更。座標 NULL 時は `[法的保護]` エラーで拒否（Rule 2 のフロント物理ロックに対するDB側二重防御） |
| `src/hooks/useEvidence.ts` | `completeTicket()` 内で `navigator.geolocation.getCurrentPosition()` を高精度オプションで再取得。取得失敗時は `watchPosition` の最終値にフォールバック。`position` が null の場合はRPC呼び出し自体をブロック |
| `src/integrations/supabase/types.ts` | `complete_ticket` の `Args` 型を新シグネチャに追随 |
| `src/hooks/useEvidence.test.ts` | 正常系（座標がRPCに正しく渡る）・異常系（DBの`[法的保護]`エラーが日本語メッセージに変換される）の結合テストを追加 |

### ステータス

未コミット（作業ツリー上）。`npm run build` / `tsc --noEmit` および migration の実DB適用は未実施。

---

## 進行中の修正 #2: 待機料の過大計算バグ

### 何が起きていたか

`convertWaitLogsToTimeline`（`src/lib/waitLogToTimeline.ts`）が `departure` イベントに `waitMinutes: workMins`（作業時間）を設定していた。これを `useDailyTimeline.ts` の `totalWaitMinutes` / `totalWaitCost` 集計がフィルタなしで合算していたため、**荷役作業時間が待機料の対象時間に混入し、待機料が過大計算**されていた。

取適法上、待機料（待機料）は署名後不可変（CLAUDE.md 記載）の法的データであるため、算定ロジックの誤りは重大な法的リスクとなる。

### 方針

- `departure` イベントは「作業終了」を表すイベントであり、待機時間ではないため `waitMinutes` を持たせない。
- 待機料集計の対象イベントを `waiting_start`（GPS由来の荷待ち）と `voice_report`（音声申告の荷待ち）のみに限定する。

### 変更点

| ファイル | 内容 |
|---------|------|
| `src/lib/waitLogToTimeline.ts` | `departure` エントリ生成時に `waitMinutes: workMins ?? undefined` の行を削除 |
| `src/hooks/useDailyTimeline.ts` | `isWaitEligible()` ヘルパーを追加し、`totalWaitMinutes` / `totalWaitCost` の `.filter()` に適用 |
| `src/lib/waitLogToTimeline.test.ts`（新規） | 作業時間120分を含むログで `departure.waitMinutes` が `undefined` であること、`totalWaitMinutes` が荷待ち分のみになることを検証する回帰テスト |

### ステータス

未コミット。既存の `waitLogToTimeline` / `useDailyTimeline` を利用する他画面（ダッシュボード集計等）への影響範囲は未確認。

---

## 未着手・要検討事項

- [ ] migration `20260720120000_fix_complete_ticket_gps_coords.sql` の実環境（Supabase）への適用
- [ ] `npm run build` / `tsc --noEmit` による型チェック確認
- [ ] 上記2修正のコミット・PR化
- [ ] 待機料自動計算ロジックまわりの他の集計箇所（荷主向けダッシュボード等、`IMPLEMENTATION_SUMMARY.md` の「次のステップ」参照）に同様の混入バグがないかの横展開確認
